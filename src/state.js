/**
 * frani-treasury — persisted state (the on-disk ledger)
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * A JSON-backed store in wallet-data/state.json holding everything the treasury
 * must remember to behave correctly, transparently, and idempotently across
 * restarts:
 *   • seenDmIds / seenTransferIds — dedup rings (relays replay; events double-fire)
 *   • handledRequestIds           — idempotency ring: a request id disbursed once, ever
 *   • requesters                  — per-pubkey reputation + history records
 *   • loans                       — every micro-loan, with outstanding + repayments
 *   • disbursements               — rolling window of {at, base} for the 24h budget
 *   • ledger                      — append-only decision log (capped) for `history`/audit
 *   • stats                       — lifetime totals (grants, loans, repaid, donations)
 *   • paused / serviceIntentId    — live operational flags
 *
 * Money is stored as base-unit DECIMAL STRINGS (BigInt isn't JSON-native) and
 * only ever parsed back through BigInt — never through Number. Writes are atomic
 * (temp file + rename, mode 0600) so a crash mid-write can't corrupt the ledger.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

import config from './config.js';
import { createLogger } from './logger.js';
import { freshRequester } from './reputation.js';

const log = createLogger('state');

const RING_CAP = 500; // max ids kept per dedup ring
const LEDGER_CAP = 400; // remembered decisions (audit trail / history)
const DISB_CAP = 400; // rolling disbursement records kept
const STATE_VERSION = 1;
const DAY_MS = 86_400_000;

// Reject reason codes that DON'T consume a requester's personal daily allowance:
// these are treasury-capacity limits, not the requester's fault.
const CAPACITY_CODES = new Set(['daily-budget', 'reserve-floor', 'paused', 'unavailable']);

/** Normalize a pubkey to x-only lowercase hex so 02.../03… and bare forms collide. */
export function normalizeKey(key) {
  if (typeof key !== 'string') return String(key ?? '');
  const k = key.trim().toLowerCase();
  if (k.length === 66 && (k.startsWith('02') || k.startsWith('03'))) return k.slice(2);
  return k;
}

function statePath() {
  return join(resolve(config.walletDir), 'state.json');
}

function freshStats() {
  return {
    grantsCount: 0,
    loansCount: 0,
    totalGrantedBase: '0',
    totalLoanedBase: '0',
    totalRepaidBase: '0',
    donationsBase: '0',
    refundsBase: '0',
    approvals: 0,
    partials: 0,
    rejects: 0,
  };
}

function freshState() {
  return {
    version: STATE_VERSION,
    serviceIntentId: null,
    paused: false,
    // Lag-free "book" balance of the spendable corpus (base-unit string, or null
    // until first anchored). The network reports 0 spendable during a token's
    // in-flight settle window, so we can't read live balance to gate disbursements;
    // instead we debit this book the instant we attempt a send and reconcile it to
    // the on-chain confirmed balance whenever the wallet is quiescent. See
    // sphere-client.effectiveSpendableBase().
    bookBalanceBase: null,
    seenDmIds: [],
    seenTransferIds: [],
    handledRequestIds: [],
    requesters: {}, // { [normKey]: Requester }
    loans: {}, // { [loanId]: Loan }
    disbursements: [], // [{ at, base }]  rolling window
    ledger: [], // [{ at, id, requester, nametag, requestedBase, decision, code, kind, amountBase }]
    stats: freshStats(),
  };
}

/** Push onto a capped ring; returns true if the id was NEW (not already present). */
function ringAdd(arr, id, cap = RING_CAP) {
  if (!id) return false;
  if (arr.includes(id)) return false;
  arr.push(id);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  return true;
}

const B = (x) => BigInt(x ?? '0');

export class State {
  constructor(data) {
    this.data = data;
  }

  static load() {
    const path = statePath();
    if (!existsSync(path)) return new State(freshState());
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      const data = { ...freshState(), ...raw };
      for (const k of ['seenDmIds', 'seenTransferIds', 'handledRequestIds', 'disbursements', 'ledger']) {
        if (!Array.isArray(data[k])) data[k] = [];
      }
      for (const k of ['requesters', 'loans']) {
        if (typeof data[k] !== 'object' || data[k] === null) data[k] = {};
      }
      data.stats = { ...freshStats(), ...(data.stats ?? {}) };
      return new State(data);
    } catch (err) {
      log.warn(`state.json unreadable (${err?.message ?? err}); starting fresh.`);
      return new State(freshState());
    }
  }

  save() {
    const path = statePath();
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, path); // atomic swap
    } catch (err) {
      log.warn(`Could not persist state: ${err?.message ?? err}`);
    }
  }

  // ── dedup rings ──────────────────────────────────────────────────────────────
  markDmSeen(id) {
    return ringAdd(this.data.seenDmIds, id);
  }
  markTransferSeen(id) {
    return ringAdd(this.data.seenTransferIds, id);
  }
  /** Idempotency: returns true if this request id has NOT been acted on before. */
  markRequestHandled(id) {
    return ringAdd(this.data.handledRequestIds, id);
  }
  wasRequestHandled(id) {
    return this.data.handledRequestIds.includes(id);
  }

  // ── operational flags ─────────────────────────────────────────────────────────
  get serviceIntentId() {
    return this.data.serviceIntentId;
  }
  setServiceIntentId(id) {
    this.data.serviceIntentId = id;
  }
  get paused() {
    return this.data.paused === true;
  }
  setPaused(v) {
    this.data.paused = !!v;
  }

  // ── book balance (lag-free spendable corpus) ─────────────────────────────────
  /** Current book balance in base units, or null if not yet anchored. */
  getBookBase() {
    return this.data.bookBalanceBase == null ? null : B(this.data.bookBalanceBase);
  }
  /** Set the book to an absolute base-unit value (used to anchor/reconcile to chain). */
  setBookBase(base) {
    this.data.bookBalanceBase = B(base).toString();
  }
  /**
   * Adjust the book by a signed delta (negative on disburse/refund, positive on
   * mint/receipt), clamped at zero. No-op while unanchored — the next
   * reconcile anchors it to the confirmed on-chain balance, which already
   * reflects reality, so we never guess from a null book.
   */
  adjustBook(deltaBase) {
    if (this.data.bookBalanceBase == null) return;
    let v = B(this.data.bookBalanceBase) + B(deltaBase);
    if (v < 0n) v = 0n;
    this.data.bookBalanceBase = v.toString();
  }

  // ── requesters (reputation records) ─────────────────────────────────────────
  getRequester(pubkey) {
    return this.data.requesters[normalizeKey(pubkey)] ?? null;
  }

  /** Fetch or create the requester record; keeps the latest known nametag. */
  ensureRequester(pubkey, nametag = null, now = Date.now()) {
    const key = normalizeKey(pubkey);
    let rec = this.data.requesters[key];
    if (!rec) {
      rec = freshRequester(pubkey, nametag, now);
      this.data.requesters[key] = rec;
    } else if (nametag && rec.nametag !== nametag) {
      rec.nametag = nametag;
    }
    return rec;
  }

  allRequesters() {
    return Object.values(this.data.requesters);
  }

  // ── loans ──────────────────────────────────────────────────────────────────
  getLoan(id) {
    return this.data.loans[id] ?? null;
  }

  createLoan({ id, requester, requesterNametag, principalBase, disbursedAt, termDays }) {
    const dueAt = disbursedAt + termDays * DAY_MS;
    const loan = {
      id,
      requester,
      requesterNametag: requesterNametag ?? null,
      principalBase: String(principalBase),
      outstandingBase: String(principalBase),
      disbursedAt,
      dueAt,
      termDays,
      status: 'active', // active | repaid | overdue | forgiven
      repayments: [],
      dueSoonNotified: false,
      overdueNotified: false,
    };
    this.data.loans[id] = loan;
    return loan;
  }

  allLoans() {
    return Object.values(this.data.loans);
  }

  activeLoansFor(pubkey) {
    const key = normalizeKey(pubkey);
    return this.allLoans()
      .filter((l) => normalizeKey(l.requester) === key && (l.status === 'active' || l.status === 'overdue'))
      .sort((a, b) => a.disbursedAt - b.disbursedAt); // FIFO: oldest first
  }

  /** Total outstanding debt (base units) for a requester across active/overdue loans. */
  outstandingDebtBase(pubkey) {
    return this.activeLoansFor(pubkey).reduce((acc, l) => acc + B(l.outstandingBase), 0n);
  }

  hasOverdueLoan(pubkey, now = Date.now()) {
    return this.activeLoansFor(pubkey).some((l) => l.status === 'overdue' || l.dueAt < now);
  }

  /**
   * Apply an incoming repayment (base units) to a requester's active loans,
   * oldest first (FIFO). Mutates loan outstanding/status and appends repayment
   * records. Returns a summary; reputation counters are updated by the caller
   * via recordRepaymentOutcome so policy stays in treasury.js.
   *
   * @returns {{appliedBase: bigint, leftoverBase: bigint, cleared: Array<{loanId:string, onTime:boolean, early:boolean}>}}
   */
  applyRepayment(pubkey, amountBase, now = Date.now()) {
    let remaining = B(amountBase);
    const cleared = [];
    const loans = this.activeLoansFor(pubkey);
    for (const loan of loans) {
      if (remaining <= 0n) break;
      const outstanding = B(loan.outstandingBase);
      const pay = remaining < outstanding ? remaining : outstanding;
      if (pay <= 0n) continue;
      loan.outstandingBase = (outstanding - pay).toString();
      loan.repayments.push({ at: now, base: pay.toString() });
      remaining -= pay;
      if (B(loan.outstandingBase) <= 0n) {
        const onTime = now <= loan.dueAt;
        const early = now <= loan.dueAt - DAY_MS; // cleared with >= 1 day to spare
        loan.status = 'repaid';
        loan.repaidAt = now;
        cleared.push({ loanId: loan.id, onTime, early });
      }
    }
    const appliedBase = B(amountBase) - remaining;
    return { appliedBase, leftoverBase: remaining, cleared };
  }

  // ── rolling 24h disbursement budget ─────────────────────────────────────────
  recordDisbursement(amountBase, now = Date.now()) {
    this.data.disbursements.push({ at: now, base: String(amountBase) });
    if (this.data.disbursements.length > DISB_CAP) {
      this.data.disbursements.splice(0, this.data.disbursements.length - DISB_CAP);
    }
  }

  /** Sum of disbursements within the last `windowMs` (default 24h); prunes old records. */
  disbursedInWindowBase(windowMs = DAY_MS, now = Date.now()) {
    const cutoff = now - windowMs;
    // prune far-expired records (keep a small margin beyond the window)
    const keepFrom = now - windowMs * 2;
    this.data.disbursements = this.data.disbursements.filter((d) => d.at >= keepFrom);
    return this.data.disbursements
      .filter((d) => d.at >= cutoff)
      .reduce((acc, d) => acc + B(d.base), 0n);
  }

  // ── decision ledger (audit trail) ────────────────────────────────────────────
  appendLedger(entry) {
    this.data.ledger.push(entry);
    if (this.data.ledger.length > LEDGER_CAP) {
      this.data.ledger.splice(0, this.data.ledger.length - LEDGER_CAP);
    }
  }

  recentLedger(n = 10) {
    return this.data.ledger.slice(-n).reverse();
  }

  recentLedgerFor(pubkey, n = 10) {
    const key = normalizeKey(pubkey);
    return this.data.ledger
      .filter((e) => normalizeKey(e.requester) === key)
      .slice(-n)
      .reverse();
  }

  /** How many chargeable requests this requester made in the rolling window. */
  requestsIn24h(pubkey, now = Date.now()) {
    const key = normalizeKey(pubkey);
    const cutoff = now - DAY_MS;
    return this.data.ledger.filter(
      (e) =>
        normalizeKey(e.requester) === key &&
        e.at >= cutoff &&
        e.type === 'request' &&
        !CAPACITY_CODES.has(e.code),
    ).length;
  }

  // ── reputation mutations ─────────────────────────────────────────────────────
  touchRequest(pubkey, now = Date.now()) {
    const rec = this.ensureRequester(pubkey, null, now);
    rec.lastRequestAt = now;
  }

  recordGrant(pubkey, amountBase) {
    const rec = this.ensureRequester(pubkey);
    rec.grantsCount += 1;
    rec.totalGrantedBase = (B(rec.totalGrantedBase) + B(amountBase)).toString();
    this.data.stats.grantsCount += 1;
    this.data.stats.totalGrantedBase = (B(this.data.stats.totalGrantedBase) + B(amountBase)).toString();
  }

  recordLoanDisbursed(pubkey, amountBase) {
    const rec = this.ensureRequester(pubkey);
    rec.loansCount += 1;
    rec.totalLoanedBase = (B(rec.totalLoanedBase) + B(amountBase)).toString();
    this.data.stats.loansCount += 1;
    this.data.stats.totalLoanedBase = (B(this.data.stats.totalLoanedBase) + B(amountBase)).toString();
  }

  /**
   * Fold the outcome of a repayment into the requester's standing:
   * on-time cleared loans count toward promotion; early ones grant a temporary
   * daily-limit bonus; late ones increment the late counter. Also lifts the
   * freeze if the requester now carries no overdue debt.
   */
  recordRepaymentOutcome(pubkey, { appliedBase, cleared }, now = Date.now()) {
    const rec = this.ensureRequester(pubkey, null, now);
    rec.totalRepaidBase = (B(rec.totalRepaidBase) + B(appliedBase)).toString();
    this.data.stats.totalRepaidBase = (B(this.data.stats.totalRepaidBase) + B(appliedBase)).toString();
    let promotedInfo = { onTime: 0, late: 0, early: false };
    for (const c of cleared) {
      if (c.onTime) {
        rec.onTimeRepayments += 1;
        promotedInfo.onTime += 1;
        if (c.early) {
          rec.earlyBonusUntil = now + config.treasury.earlyBonusHours * 3_600_000;
          promotedInfo.early = true;
        }
      } else {
        rec.lateRepayments += 1;
        promotedInfo.late += 1;
      }
    }
    // If no overdue debt remains, clear any freeze.
    if (!this.hasOverdueLoan(pubkey, now)) {
      rec.frozenUntil = 0;
    }
    return promotedInfo;
  }

  recordDonation(pubkey, amountBase) {
    if (pubkey) this.ensureRequester(pubkey);
    this.data.stats.donationsBase = (B(this.data.stats.donationsBase) + B(amountBase)).toString();
  }

  recordRefund(amountBase) {
    this.data.stats.refundsBase = (B(this.data.stats.refundsBase) + B(amountBase)).toString();
  }

  noteDecision(decision) {
    if (decision === 'approve') this.data.stats.approvals += 1;
    else if (decision === 'partial') this.data.stats.partials += 1;
    else if (decision === 'reject') this.data.stats.rejects += 1;
  }

  freeze(pubkey, untilMs) {
    const rec = this.ensureRequester(pubkey);
    rec.frozenUntil = Math.max(rec.frozenUntil ?? 0, untilMs);
  }

  setBlacklist(pubkey, on) {
    const rec = this.ensureRequester(pubkey);
    rec.blacklisted = !!on;
  }

  /** Owner action: lift a freeze immediately (does not clear a blacklist). */
  unfreeze(pubkey) {
    const rec = this.ensureRequester(pubkey);
    rec.frozenUntil = 0;
  }

  /**
   * Owner action: forgive a loan — zero its outstanding balance and mark it
   * forgiven. Returns the loan (or null if unknown). The corresponding freeze,
   * if any, is lifted by the caller once no overdue debt remains.
   */
  forgiveLoan(id) {
    const loan = this.data.loans[id];
    if (!loan) return null;
    loan.outstandingBase = '0';
    loan.status = 'forgiven';
    loan.forgivenAt = Date.now();
    return loan;
  }

  get stats() {
    return this.data.stats;
  }
}

export default State;

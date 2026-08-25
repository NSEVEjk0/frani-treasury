/**
 * frani-treasury — request lifecycle & loan bookkeeping
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * The orchestration layer between the network and the pure policy brain:
 *
 *   handleFundingRequest — validate → build the numeric context (balance, budget,
 *     reputation) → policy.evaluate() → on approve/partial: disburse (guarded) →
 *     book the grant or loan → ledger + reply. On reject: ledger + explain.
 *
 *   applyIncomingRepayment — an inbound transfer from a borrower is matched FIFO
 *     against their outstanding loans (on-time repayments build reputation,
 *     overpayment is refunded); from anyone else it's recorded as a corpus
 *     donation, kept with thanks.
 *
 *   sweepLoans — periodic: send due-soon reminders, flip past-due loans to
 *     overdue, and freeze the borrower until they settle.
 *
 * Every decision is recorded in an append-only ledger and logged as a compact
 * structured line, so the treasury's behaviour is fully auditable.
 */

import { randomUUID } from 'node:crypto';

import config from './config.js';
import { createLogger } from './logger.js';
import policy from './policy.js';
import reputation from './reputation.js';
import { reply, recipientFromSender, sig } from './reply.js';

const log = createLogger('treasury');

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const short = (id) => String(id ?? '').replace(/-/g, '').slice(0, 6);
function fmtWhen(ms) {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Build the fully-resolved numeric context the pure policy engine needs.
 * Reads the live balance once; everything else comes from state + reputation.
 */
export async function buildContext(client, state, rec, now) {
  const decimals = client.coin.decimals;
  const balanceBase = await client.effectiveSpendableBase();
  return {
    balanceBase,
    floorBase: client.toBase(config.treasury.minBalanceFloorWhole),
    dailyBudgetBase: client.toBase(config.treasury.dailyBudgetWhole),
    dailySpentBase: state.disbursedInWindowBase(DAY_MS, now),
    maxSingleBase: client.toBase(config.treasury.maxSingleWhole),
    grantMaxBase: client.toBase(config.treasury.grantMaxWhole),
    outstandingDebtBase: state.outstandingDebtBase(rec.pubkey),
    creditLimitBase: reputation.creditLimitBaseFor(rec, decimals),
    cooldownMs: reputation.cooldownMsFor(rec),
    lastRequestAt: rec.lastRequestAt ?? 0,
    requestsIn24h: state.requestsIn24h(rec.pubkey, now),
    dailyRequestLimit: reputation.personalDailyLimit(rec, config, now),
    frozen: reputation.isFrozen(rec, now),
    blacklisted: rec.blacklisted === true,
    hasOverdue: state.hasOverdueLoan(rec.pubkey, now),
    disburseEnabled: config.safety.disburseEnabled,
    paused: state.paused,
    fmt: (b) => client.fmt(b),
  };
}

/** Compose the message sent when a grant/loan is approved (or partially so). */
function approvalMessage(client, { decision, kind, amountBase, requestedBase, loan, rec }) {
  const amt = client.fmt(amountBase);
  const prog = reputation.progress(rec);
  const lines = [];
  const partial = decision === 'partial';

  if (kind === 'grant') {
    lines.push(`✅ Approved — SEED GRANT of ${amt}${partial ? ` (you asked for ${client.fmt(requestedBase)})` : ''}.`);
    lines.push(`This is a no-repayment grant. Nothing to pay back — go build. 🌱`);
  } else {
    lines.push(`✅ Approved — MICRO-LOAN of ${amt}${partial ? ` (you asked for ${client.fmt(requestedBase)})` : ''}.`);
    lines.push(`Term: ${loan.termDays} days · due ${fmtWhen(loan.dueAt)}.`);
    lines.push(`Repay by simply sending UCT back to me — I match it to your oldest loan automatically.`);
    lines.push(`Repay on time to climb the reputation ladder; early repayment earns a temporary limit boost.`);
  }
  if (partial) {
    lines.push(``);
    lines.push(`Only part of your ask fit within the treasury's current rails (per-request ceiling,`);
    lines.push(`rolling daily budget, reserve floor, or your tier's credit headroom).`);
  }
  lines.push(``);
  lines.push(`Your standing: ${prog.label}${prog.nextTier ? ` · ${prog.toNextOnTime} on-time repayment(s) to ${reputation.describeTier(prog.nextTier)}` : ' · top tier'}.`);
  lines.push(`Reply \`status\` any time for balances, limits and your history. ${sig()}`);
  return lines.join('\n');
}

/** Compose a rejection message: the policy reason + a constructive hint. */
function rejectionMessage(client, decision, rec) {
  const prog = reputation.progress(rec);
  const hint =
    decision.code === policy.CODES.CREDIT_LIMIT
      ? `Tip: repay outstanding loans on time to raise your ceiling (currently ${prog.label}).`
      : decision.code === policy.CODES.COOLDOWN || decision.code === policy.CODES.DAILY_REQUEST_CAP
        ? `Tip: requests are rate-limited per account to keep the treasury fair.`
        : `Reply \`status\` to see current limits, or \`help\` for how funding works.`;
  return [`🛑 Request declined.`, decision.reason, ``, hint, sig()].join('\n');
}

/** One compact structured log line per decision (auditable in journald). */
function logDecision(client, { rec, requestedBase, decision }) {
  log.info(
    JSON.stringify({
      evt: 'decision',
      requester: rec.nametag ? `@${rec.nametag}` : String(rec.pubkey).slice(0, 12),
      tier: reputation.tierOf(rec),
      requested: client.toWhole(requestedBase),
      decision: decision.decision,
      kind: decision.kind,
      amount: client.toWhole(decision.amountBase),
      code: decision.code,
    }),
  );
}

/**
 * Full lifecycle for a `request <amount> [reason]` DM. Callers must have already
 * de-duplicated the DM id (agent.js persists it before dispatch), so a given
 * request is processed exactly once — no double-disbursement across restarts.
 */
export async function handleFundingRequest(client, state, rateLimit, { dm, requestedBase, reason }) {
  const now = Date.now();
  const pubkey = dm.senderPubkey;
  const nametag = dm.senderNametag ?? null;
  const recipient = recipientFromSender(pubkey, nametag);

  const rec = state.ensureRequester(pubkey, nametag, now);
  const ctx = await buildContext(client, state, rec, now);
  const decision = policy.evaluate({ requestedBase, nowMs: now }, ctx);
  logDecision(client, { rec, requestedBase, decision });

  const ledgerBase = {
    at: now,
    id: randomUUID(),
    type: 'request',
    requester: pubkey,
    nametag,
    reason: String(reason ?? '').slice(0, 140),
    requestedBase: requestedBase.toString(),
    decision: decision.decision,
    code: decision.code,
  };

  // ── rejection ────────────────────────────────────────────────────────────
  if (decision.decision === 'reject') {
    state.noteDecision('reject');
    state.appendLedger({ ...ledgerBase, kind: null, amountBase: '0' });
    state.save();
    await reply(client, recipient, rateLimit, rejectionMessage(client, decision, rec), { priority: true });
    return { decision };
  }

  // ── approve / partial → disburse under the hourly rate cap ─────────────────
  if (!rateLimit.allow('disburse', config.safety.maxDisbursementsPerHour)) {
    log.warn(`Disbursement rate cap reached — asking ${recipient} to retry shortly.`);
    await reply(client, recipient, rateLimit, `⏳ I'm handling a lot of funding right now. Please re-send your request in a little while. ${sig()}`, { priority: true });
    return { decision, deferred: true };
  }

  const memo = `frani-treasury ${decision.kind} ${short(ledgerBase.id)}`;
  const res = await client.disburse(recipient, decision.amountBase, memo);

  // Disbursement blocked by a guard — explain honestly, record as a reject.
  if (res?.skipped === 'disburse-disabled') {
    state.noteDecision('reject');
    state.appendLedger({ ...ledgerBase, decision: 'reject', code: policy.CODES.PAUSED, kind: null, amountBase: '0' });
    state.save();
    await reply(client, recipient, rateLimit, `⏸️ Funding is paused right now, so I can't disburse. Please try again later. ${sig()}`, { priority: true });
    return { decision, skipped: 'disburse-disabled' };
  }
  if (res?.skipped === 'reserve-floor') {
    state.noteDecision('reject');
    state.appendLedger({ ...ledgerBase, decision: 'reject', code: policy.CODES.RESERVE_FLOOR, kind: null, amountBase: '0' });
    state.save();
    await reply(client, recipient, rateLimit, `🛑 The treasury is at its reserve floor and can't disburse right now. Please check back later. ${sig()}`, { priority: true });
    return { decision, skipped: 'reserve-floor' };
  }
  if (res?.ambiguous) {
    // The send could not be confirmed end-to-end. Its token burn may already be
    // certified (funds gone) or it may have failed outright — the network doesn't
    // tell us, and we must NOT retry (double-pay guard, already enforced in _send).
    // Act conservatively for the CORPUS: the book was already debited in _send, so
    // count the outflow against the rolling budget and start the cooldown to block
    // an immediate double-request. But do NOT create a repayable loan or a completed
    // grant for funds we can't confirm landed — record an auditable, clearly-marked
    // ledger line instead, and never tell the requester "nothing was sent".
    log.warn(`Disbursement to ${recipient} unconfirmed (${res.code}) — recorded conservatively, not retried.`);
    rec.lastRequestAt = now; // start the cooldown (anti double-pay)
    state.recordDisbursement(decision.amountBase, now); // treat as spent against the daily budget
    state.noteDecision(decision.decision);
    state.appendLedger({ ...ledgerBase, kind: decision.kind, amountBase: decision.amountBase.toString(), code: 'unconfirmed', unconfirmed: true });
    state.save();
    await reply(client, recipient, rateLimit, [
      `⚠️ I couldn't get a network confirmation that your ${decision.kind} of ${client.fmt(decision.amountBase)} completed.`,
      `The funds may well have arrived — please check your wallet in a minute.`,
      `To rule out any double-payment I won't retry automatically. If nothing shows up,`,
      `you can request again after your cooldown, or reply here and the owner will reconcile it. ${sig()}`,
    ].join('\n'), { priority: true });
    return { decision, unconfirmed: true, code: res.code };
  }

  const dry = res?.dryRun === true;

  // ── book it (skip financial writes in DRY_RUN so accounting matches reality) ─
  rec.lastRequestAt = now; // funded → start the cooldown
  let loan = null;
  if (!dry) {
    if (decision.kind === 'loan') {
      loan = state.createLoan({
        id: ledgerBase.id,
        requester: pubkey,
        requesterNametag: nametag,
        principalBase: decision.amountBase.toString(),
        disbursedAt: now,
        termDays: config.treasury.loanTermDays,
      });
      state.recordLoanDisbursed(pubkey, decision.amountBase);
    } else {
      state.recordGrant(pubkey, decision.amountBase);
    }
    state.recordDisbursement(decision.amountBase, now);
  } else if (decision.kind === 'loan') {
    // Build an ephemeral loan object just so the reply can quote a due date.
    loan = { termDays: config.treasury.loanTermDays, dueAt: now + config.treasury.loanTermDays * DAY_MS };
  }

  state.noteDecision(decision.decision);
  state.appendLedger({ ...ledgerBase, kind: decision.kind, amountBase: decision.amountBase.toString(), dry });
  state.save();

  const body = approvalMessage(client, {
    decision: decision.decision,
    kind: decision.kind,
    amountBase: decision.amountBase,
    requestedBase,
    loan: loan ?? { termDays: config.treasury.loanTermDays, dueAt: now + config.treasury.loanTermDays * DAY_MS },
    rec,
  });
  await reply(client, recipient, rateLimit, dry ? `[DRY_RUN — no funds moved]\n${body}` : body, { priority: true });
  return { decision, loan };
}

/**
 * Match an inbound transfer from `pubkey` against their outstanding loans (FIFO).
 * If they have none, it's a donation to the corpus (kept, thanked). Overpayment
 * beyond all debt is refunded.
 */
export async function applyIncomingRepayment(client, state, rateLimit, { transfer, amountBase }) {
  const now = Date.now();
  const pubkey = transfer.senderPubkey;
  const nametag = transfer.senderNametag ?? null;
  const recipient = recipientFromSender(pubkey, nametag);

  const active = state.activeLoansFor(pubkey);

  // No active loan → treat as a donation to the treasury corpus.
  if (active.length === 0) {
    state.recordDonation(pubkey, amountBase);
    state.appendLedger({ at: now, id: randomUUID(), type: 'donation', requester: pubkey, nametag, amountBase: amountBase.toString(), decision: 'received', code: 'donation' });
    state.save();
    log.info(JSON.stringify({ evt: 'donation', from: recipient, amount: client.toWhole(amountBase) }));
    await reply(client, recipient, rateLimit, `🙏 Thank you — ${client.fmt(amountBase)} received. You have no outstanding loan, so I'm adding this to the treasury corpus for future grants. ${sig()}`, { priority: true });
    return { donation: true };
  }

  // Apply FIFO to outstanding loans.
  const { appliedBase, leftoverBase, cleared } = state.applyRepayment(pubkey, amountBase, now);
  const outcome = state.recordRepaymentOutcome(pubkey, { appliedBase, cleared }, now);
  const rec = state.ensureRequester(pubkey, nametag, now);
  const remainingDebt = state.outstandingDebtBase(pubkey);

  state.appendLedger({
    at: now,
    id: randomUUID(),
    type: 'repayment',
    requester: pubkey,
    nametag,
    amountBase: appliedBase.toString(),
    cleared: cleared.length,
    decision: 'received',
    code: 'repayment',
  });

  // Refund any surplus beyond all debt (recorded only once the refund is accepted).
  let refunded = 0n;
  if (leftoverBase > 0n) {
    const rr = await client.refund(pubkey, leftoverBase, `frani-treasury overpayment refund`);
    if (rr && !rr.error && !rr.ambiguous && !rr.skipped) {
      refunded = leftoverBase;
      state.recordRefund(leftoverBase);
    } else if (rr?.ambiguous) {
      log.warn(`Overpayment refund to ${recipient} unconfirmed (${rr.code}) — not asserting a completed refund.`);
    }
  }
  state.save();

  log.info(JSON.stringify({ evt: 'repayment', from: recipient, applied: client.toWhole(appliedBase), cleared: cleared.length, onTime: outcome.onTime, late: outcome.late, remaining: client.toWhole(remainingDebt) }));

  const prog = reputation.progress(rec);
  const lines = [`✅ Repayment received: ${client.fmt(appliedBase)}.`];
  if (cleared.length) {
    const onTimeCleared = cleared.filter((c) => c.onTime).length;
    lines.push(`Loan(s) cleared: ${cleared.length}${onTimeCleared ? ` (${onTimeCleared} on time 👍)` : ''}.`);
    if (outcome.early) lines.push(`Early repayment — enjoy a temporary boost to your daily request limit. ⚡`);
  }
  lines.push(remainingDebt > 0n ? `Remaining outstanding: ${client.fmt(remainingDebt)}.` : `You're all settled — no outstanding debt. 🎉`);
  if (refunded > 0n) lines.push(`Overpayment of ${client.fmt(refunded)} refunded to you.`);
  lines.push(`Standing: ${prog.label}${prog.nextTier ? ` · ${prog.toNextOnTime} on-time to ${reputation.describeTier(prog.nextTier)}` : ' · top tier'}. ${sig()}`);
  await reply(client, recipient, rateLimit, lines.join('\n'), { priority: true });
  return { appliedBase, cleared, refunded };
}

/**
 * Periodic loan sweep: due-soon reminders (once), and past-due → overdue with a
 * borrower freeze (until settled). Bounded by the action rate cap.
 */
export async function sweepLoans(client, state, rateLimit, now = Date.now()) {
  let changed = false;
  for (const loan of state.allLoans()) {
    if (loan.status !== 'active') continue;
    const recipient = recipientFromSender(loan.requester, loan.requesterNametag);

    if (loan.dueAt <= now) {
      loan.status = 'overdue';
      state.freeze(loan.requester, now + config.treasury.overdueFreezeHours * HOUR_MS);
      changed = true;
      if (!loan.overdueNotified) {
        loan.overdueNotified = true;
        if (rateLimit.allow('action', config.safety.maxActionsPerHour)) {
          await client.sendDM(recipient, [
            `⛔ Your micro-loan of ${client.fmt(loan.principalBase)} is now OVERDUE (was due ${fmtWhen(loan.dueAt)}).`,
            `Outstanding: ${client.fmt(loan.outstandingBase)}. New requests are frozen until you settle —`,
            `just send the outstanding UCT back to me to clear it. ${sig()}`,
          ].join('\n'));
        }
      }
    } else if (loan.dueAt - now <= DAY_MS && !loan.dueSoonNotified) {
      loan.dueSoonNotified = true;
      changed = true;
      if (rateLimit.allow('action', config.safety.maxActionsPerHour)) {
        await client.sendDM(recipient, [
          `⏰ Friendly reminder: your micro-loan of ${client.fmt(loan.principalBase)} is due ${fmtWhen(loan.dueAt)}.`,
          `Outstanding: ${client.fmt(loan.outstandingBase)}. Repay on time to build your reputation —`,
          `send the UCT back to me and I'll match it automatically. ${sig()}`,
        ].join('\n'));
      }
    }
  }
  if (changed) state.save();
  return changed;
}

export default { buildContext, handleFundingRequest, applyIncomingRepayment, sweepLoans };

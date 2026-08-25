/**
 * frani-treasury — the policy engine (pure decision brain)
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * `evaluate(request, ctx)` is a PURE function: given a request and a fully
 * resolved numeric context (all amounts already in base units), it returns a
 * decision. No I/O, no clock, no SDK, no config import — every input is passed
 * in, so the entire funding logic can be unit-tested in isolation and produces
 * the same answer every time.
 *
 * The decision composes as a series of checks, belt-and-suspenders:
 *   HARD GATES (any one rejects):
 *     paused/disabled · invalid amount · frozen/blacklisted · has overdue loan ·
 *     cooldown active · personal daily request cap reached
 *   SOFT BOUNDS (each clamps the amount down; the tightest wins):
 *     absolute single-disbursement ceiling · remaining rolling-24h budget ·
 *     reserve floor (never spend the corpus below it) · per-requester credit
 *     headroom (for loans)
 *
 * Tiering: an approvable amount of <= grantMax from a debt-free requester is a
 * pure GRANT (no repayment). Anything larger — or any funding to a requester who
 * already carries debt — is booked as a repayable LOAN, clamped to their credit
 * headroom. If every soft bound still leaves a positive amount below the ask,
 * the result is a PARTIAL; if it reaches zero, a REJECT naming the binding rail.
 *
 * The returned `checks[]` array is a full, ordered trace of what happened — the
 * treasury logs it and can surface it, so a decision is never a black box.
 */

import { bigMax } from './money.js';

const ZERO = 0n;

/** Reason codes — stable machine identifiers for each outcome. */
export const CODES = Object.freeze({
  APPROVED: 'approved',
  PARTIAL: 'partial',
  PAUSED: 'paused',
  INVALID_AMOUNT: 'invalid-amount',
  FROZEN: 'frozen',
  BLACKLISTED: 'blacklisted',
  OVERDUE: 'overdue',
  COOLDOWN: 'cooldown',
  DAILY_REQUEST_CAP: 'daily-request-cap',
  RESERVE_FLOOR: 'reserve-floor',
  DAILY_BUDGET: 'daily-budget',
  CREDIT_LIMIT: 'credit-limit',
  UNAVAILABLE: 'unavailable',
});

const reject = (code, reason, checks) => ({
  decision: 'reject',
  kind: null,
  amountBase: ZERO,
  code,
  reason,
  checks,
});

/**
 * @param {{requestedBase: bigint, nowMs: number}} request
 * @param {object} ctx  fully-resolved numeric context (all bigint base units):
 *   balanceBase, floorBase, dailyBudgetBase, dailySpentBase, maxSingleBase,
 *   grantMaxBase, outstandingDebtBase, creditLimitBase,
 *   cooldownMs, lastRequestAt, requestsIn24h, dailyRequestLimit,
 *   frozen, blacklisted, hasOverdue, disburseEnabled, paused,
 *   fmt?(base)=>string  (optional pretty-printer for reason strings)
 * @returns {{decision:'approve'|'partial'|'reject', kind:'grant'|'loan'|null,
 *            amountBase: bigint, code:string, reason:string, checks:object[]}}
 */
export function evaluate(request, ctx) {
  const fmt = typeof ctx.fmt === 'function' ? ctx.fmt : (b) => String(b);
  const checks = [];
  const gate = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    return ok;
  };

  const requested = BigInt(request.requestedBase ?? 0n);
  const now = request.nowMs ?? 0;

  // ── HARD GATES ─────────────────────────────────────────────────────────────
  const enabledOk = ctx.disburseEnabled === true && ctx.paused !== true;
  const enabledDetail = enabledOk ? 'disbursement enabled' : ctx.paused ? 'treasury paused' : 'disbursement disabled';
  if (!gate('enabled', enabledOk, enabledDetail)) {
    return reject(CODES.PAUSED, 'The treasury is currently paused — funding is temporarily suspended. Please try again later.', checks);
  }

  if (!gate('valid-amount', requested > ZERO, `requested=${fmt(requested)}`)) {
    return reject(CODES.INVALID_AMOUNT, 'Please request a positive amount, e.g. `request 1 gas for testing`.', checks);
  }

  if (ctx.blacklisted === true) {
    gate('not-blacklisted', false, 'owner blacklist');
    return reject(CODES.BLACKLISTED, 'This account is blocked from funding. Contact the treasury owner if you believe this is in error.', checks);
  }

  if (!gate('has-overdue', ctx.hasOverdue !== true, ctx.hasOverdue ? 'overdue loan outstanding' : 'none')) {
    return reject(CODES.OVERDUE, 'You have an overdue loan. Settle it (send the outstanding UCT back) to unfreeze new requests.', checks);
  }

  if (!gate('not-frozen', ctx.frozen !== true, ctx.frozen ? 'account frozen' : 'ok')) {
    return reject(CODES.FROZEN, 'Your account is temporarily frozen. It will unfreeze automatically once the cool-off passes and any debt is settled.', checks);
  }

  const sinceLast = ctx.lastRequestAt ? now - ctx.lastRequestAt : Infinity;
  if (!gate('cooldown', sinceLast >= ctx.cooldownMs, `sinceLast=${Number.isFinite(sinceLast) ? Math.round(sinceLast / 1000) + 's' : 'n/a'} / need ${Math.round(ctx.cooldownMs / 1000)}s`)) {
    const waitMin = Math.max(1, Math.ceil((ctx.cooldownMs - sinceLast) / 60_000));
    return reject(CODES.COOLDOWN, `You're on cooldown — please wait about ${waitMin} more minute(s) before your next request.`, checks);
  }

  if (!gate('daily-request-cap', (ctx.requestsIn24h ?? 0) < ctx.dailyRequestLimit, `${ctx.requestsIn24h ?? 0}/${ctx.dailyRequestLimit} in 24h`)) {
    return reject(CODES.DAILY_REQUEST_CAP, `You've reached your limit of ${ctx.dailyRequestLimit} request(s) in 24h. This resets on a rolling basis — try again later.`, checks);
  }

  // ── SOFT BOUNDS (clamp the amount; remember what bound it) ───────────────────
  let amount = requested;
  let binding = null;

  const clampTo = (name, cap, code) => {
    const capped = bigMax(ZERO, cap);
    const ok = amount <= capped;
    checks.push({ name, ok, detail: `cap=${fmt(capped)} vs amount=${fmt(amount)}` });
    if (!ok) {
      amount = capped;
      binding = code;
    }
  };

  // Absolute per-disbursement ceiling (last-resort clamp).
  clampTo('max-single', ctx.maxSingleBase, CODES.CREDIT_LIMIT);
  // Remaining rolling-24h treasury-wide budget.
  clampTo('daily-budget', ctx.dailyBudgetBase - ctx.dailySpentBase, CODES.DAILY_BUDGET);
  // Reserve floor — never spend the corpus below it.
  clampTo('reserve-floor', ctx.balanceBase - ctx.floorBase, CODES.RESERVE_FLOOR);

  // ── tier: grant (no debt) vs loan (tracked, credit-limited) ──────────────────
  const hasDebt = (ctx.outstandingDebtBase ?? ZERO) > ZERO;
  let kind;
  if (!hasDebt && amount <= ctx.grantMaxBase) {
    kind = 'grant';
    checks.push({ name: 'classify', ok: true, detail: `grant (<= grantMax ${fmt(ctx.grantMaxBase)}, no debt)` });
  } else {
    kind = 'loan';
    const headroom = bigMax(ZERO, ctx.creditLimitBase - (ctx.outstandingDebtBase ?? ZERO));
    checks.push({ name: 'classify', ok: true, detail: `loan (headroom ${fmt(headroom)}${hasDebt ? ', has debt' : ''})` });
    clampTo('credit-headroom', headroom, CODES.CREDIT_LIMIT);
  }

  // ── terminal decision ────────────────────────────────────────────────────────
  if (amount <= ZERO) {
    // Name the rail that squeezed it to zero (most specific first).
    let code = binding ?? CODES.UNAVAILABLE;
    let reason;
    if ((ctx.balanceBase - ctx.floorBase) <= ZERO) {
      code = CODES.RESERVE_FLOOR;
      reason = 'The treasury is at its reserve floor right now and cannot disburse. Please check back after it is replenished.';
    } else if ((ctx.dailyBudgetBase - ctx.dailySpentBase) <= ZERO) {
      code = CODES.DAILY_BUDGET;
      reason = "Today's funding budget is exhausted. The rolling 24h budget frees up over time — try again later.";
    } else if (kind === 'loan') {
      code = CODES.CREDIT_LIMIT;
      reason = 'You have no remaining credit headroom at your current reputation tier. Repay outstanding loans on time to raise your limit.';
    } else {
      reason = 'No funding is available for this request right now.';
    }
    checks.push({ name: 'result', ok: false, detail: `reject (${code})` });
    return reject(code, reason, checks);
  }

  const partial = amount < requested;
  checks.push({ name: 'result', ok: true, detail: `${partial ? 'partial' : 'approve'} ${kind} ${fmt(amount)}` });

  return {
    decision: partial ? 'partial' : 'approve',
    kind,
    amountBase: amount,
    code: partial ? CODES.PARTIAL : CODES.APPROVED,
    reason: partial
      ? `Approved a partial ${kind} of ${fmt(amount)} (you asked for ${fmt(requested)}); the rest is limited by treasury rails.`
      : `Approved a ${kind} of ${fmt(amount)}.`,
    checks,
  };
}

export default { evaluate, CODES };

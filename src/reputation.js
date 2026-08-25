/**
 * frani-treasury — reputation ladder
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * A requester's standing is earned, not asserted. Reputation is derived purely
 * from on-network behaviour recorded in state.js:
 *
 *   Newbie  → everyone starts here. Grants only + a modest loan ceiling.
 *   Trusted → reached after N on-time loan repayments. Higher ceiling, shorter cooldown.
 *   Partner → reached after M on-time repayments. Highest ceiling, shortest cooldown.
 *
 * Perks & penalties:
 *   • On-time repayment  → counts toward promotion.
 *   • Early repayment    → a temporary boost to the personal daily request limit.
 *   • Overdue / default  → a temporary freeze; all new requests are refused until settled.
 *
 * These functions are side-effect free: they read a requester record + config
 * and return a standing. Mutations to the record happen in state.js / treasury.js.
 */

import config from './config.js';
import { toBaseUnits } from './money.js';

export const TIER_ORDER = ['newbie', 'trusted', 'partner'];

const TIER_LABEL = Object.freeze({
  newbie: 'Newbie 🌱',
  trusted: 'Trusted ⭐',
  partner: 'Partner 👑',
});

/** A zeroed requester record (the shape persisted per pubkey in state.json). */
export function freshRequester(pubkey, nametag = null, now = Date.now()) {
  return {
    pubkey,
    nametag: nametag ?? null,
    firstSeenAt: now,
    lastRequestAt: 0,
    grantsCount: 0,
    totalGrantedBase: '0',
    loansCount: 0,
    totalLoanedBase: '0',
    totalRepaidBase: '0',
    onTimeRepayments: 0,
    lateRepayments: 0,
    defaults: 0,
    frozenUntil: 0, // ms; 0 = not frozen
    earlyBonusUntil: 0, // ms; 0 = no active bonus
    blacklisted: false, // owner hard block
  };
}

/**
 * Which tier has this requester earned? Promotion is monotonic in on-time
 * repayments; late/defaults don't demote the tier directly (they freeze the
 * account instead), but they do gate promotion because they don't count as
 * on-time.
 */
export function tierOf(record, cfg = config) {
  const onTime = record?.onTimeRepayments ?? 0;
  const t = cfg.treasury.tiers;
  if (onTime >= t.partner.promoteAtOnTime) return 'partner';
  if (onTime >= t.trusted.promoteAtOnTime) return 'trusted';
  return 'newbie';
}

/** The tuned knobs for a tier (ceiling + cooldown). */
export function tierParams(tier, cfg = config) {
  return cfg.treasury.tiers[tier] ?? cfg.treasury.tiers.newbie;
}

/** Human label with emoji, e.g. "Trusted ⭐". */
export function describeTier(tier) {
  return TIER_LABEL[tier] ?? tier;
}

/** Per-requester cooldown between requests, in ms, for this tier. */
export function cooldownMsFor(record, cfg = config) {
  return tierParams(tierOf(record, cfg), cfg).cooldownMin * 60_000;
}

/**
 * Maximum single-LOAN ceiling for this requester (base units). Grants are
 * bounded separately by grantMaxWhole and are available to every tier.
 */
export function maxLoanBaseFor(record, decimals, cfg = config) {
  return toBaseUnits(tierParams(tierOf(record, cfg), cfg).maxLoanWhole, decimals);
}

/**
 * Credit limit = the most a requester may have OUTSTANDING at once (base units).
 * Set equal to their tier's single-loan ceiling: a Newbie can carry one small
 * loan, a Partner more headroom. New borrowing that would push total debt past
 * this is refused (or partially funded up to it).
 */
export function creditLimitBaseFor(record, decimals, cfg = config) {
  return maxLoanBaseFor(record, decimals, cfg);
}

/** Is the account currently frozen (overdue penalty or owner action)? */
export function isFrozen(record, now = Date.now()) {
  if (!record) return false;
  return record.blacklisted === true || (record.frozenUntil ?? 0) > now;
}

/** Personal request budget over a rolling 24h, incl. any active early-repay bonus. */
export function personalDailyLimit(record, cfg = config, now = Date.now()) {
  const base = cfg.treasury.maxRequestsPer24h;
  const bonusActive = record && (record.earlyBonusUntil ?? 0) > now;
  return base + (bonusActive ? cfg.treasury.earlyBonusExtraRequests : 0);
}

/**
 * Progress summary toward the next tier (for `status`): current tier, the next
 * tier if any, and how many more on-time repayments are needed to get there.
 */
export function progress(record, cfg = config) {
  const tier = tierOf(record, cfg);
  const onTime = record?.onTimeRepayments ?? 0;
  const idx = TIER_ORDER.indexOf(tier);
  const nextTier = TIER_ORDER[idx + 1] ?? null;
  let toNext = 0;
  if (nextTier) {
    toNext = Math.max(0, tierParams(nextTier, cfg).promoteAtOnTime - onTime);
  }
  return { tier, label: describeTier(tier), onTime, nextTier, toNextOnTime: toNext };
}

export default {
  freshRequester,
  tierOf,
  tierParams,
  describeTier,
  cooldownMsFor,
  maxLoanBaseFor,
  creditLimitBaseFor,
  isFrozen,
  personalDailyLimit,
  progress,
  TIER_ORDER,
};

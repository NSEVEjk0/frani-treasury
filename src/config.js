/**
 * frani-treasury — central configuration
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * All runtime settings live here. Values come from environment variables
 * (optionally loaded from a local .env file), each with a safe, conservative
 * default. The exported object is frozen so nothing mutates config at runtime.
 *
 * The treasury is deliberately timid out of the box: small daily budget, a
 * large untouchable reserve, low per-request ceilings, and a global
 * DISBURSE_ENABLED kill-switch. Loosen it on purpose via .env — never by
 * accident.
 */

import { createLogger } from './logger.js';

const log = createLogger('config');

// Load .env if present (Node >=20.12). Never fatal if the file is missing.
try {
  process.loadEnvFile(process.env.ENV_FILE || '.env');
} catch {
  // No .env file — rely on real environment variables and defaults.
}

// ── small typed env helpers ────────────────────────────────────────────────
const str = (key, def) => {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
};
const int = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    log.warn(`Invalid integer for ${key}="${v}", using default ${def}`);
    return def;
  }
  return n;
};
const num = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) {
    log.warn(`Invalid number for ${key}="${v}", using default ${def}`);
    return def;
  }
  return n;
};
const bool = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
};
const list = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : def;
};

// Nametag: strip a leading '@' and lowercase, since the SDK expects the bare form.
// AGENT_NAME is the documented alias for NAMETAG (AGENT_NAME wins if both are set).
const rawNametag = str('AGENT_NAME', str('NAMETAG', 'frani-treasury'))
  .replace(/^@/, '')
  .trim()
  .toLowerCase();

// Owner admin key: the on-network pubkey allowed to issue protected admin
// commands over DM (pause/resume/params/forgive/topup). EMPTY BY DEFAULT → the admin
// surface is disabled entirely (safe). Accepts the controlling identity's chain
// pubkey (66 hex, 02/03-prefixed) or its transport pubkey (64 hex) — normalizeKey()
// strips the prefix, so both compare equal. Validated at boot: a nametag or a
// DIRECT:// address is refused rather than quietly arming an admin surface that
// can never authenticate a DM.
const ownerPubkey = (() => {
  const raw = str('OWNER_PUBKEY', '').trim().toLowerCase();
  if (!raw) return ''; // unset → admin surface disabled, the safe default
  // A pubkey, not an address and not a nametag. `enabled` is just `length > 0`, so
  // anything non-empty arms the admin surface — and a wrong value arms one that can
  // never authenticate, silently, forever. `normalizeKey` strips a 02/03 prefix, so
  // both the 33-byte compressed chain pubkey and the 32-byte x-only transport pubkey
  // are accepted and compare equal. Refuse everything else at boot, loudly.
  const compressed = /^0[23][0-9a-f]{64}$/.test(raw);
  const xonly = /^[0-9a-f]{64}$/.test(raw);
  if (compressed || xonly) return raw;
  const hint = raw.startsWith('@')
    ? 'that is a nametag. Resolve it to a pubkey first (the DM surface compares keys, not names).'
    : raw.startsWith('direct://')
      ? 'that is a DIRECT address, not a key. An address is a one-way hash of a pubkey — resolve it with sphere.resolve() and use the chainPubkey it returns.'
      : `expected 66 hex chars starting 02/03 (chain pubkey) or 64 hex chars (transport pubkey); got ${raw.length} chars.`;
  throw new Error(
    `OWNER_PUBKEY is not a pubkey: "${raw.slice(0, 24)}${raw.length > 24 ? '…' : ''}" — ${hint}\n` +
      'Leave OWNER_PUBKEY unset to run with the admin surface disabled.',
  );
})();

const config = Object.freeze({
  // ── Identity / branding ──────────────────────────────────────────────────
  nametag: rawNametag,
  owner: 'Itachi',
  brand: 'CRYPTFRANI',

  // ── Storage ────────────────────────────────────────────────────────────
  walletDir: str('WALLET_DIR', './wallet-data'),
  walletFileName: str('WALLET_FILE', 'wallet.json'),
  password: str('WALLET_PASSWORD', undefined), // undefined => plaintext on disk

  // ── Network (testnet2) ───────────────────────────────────────────────────
  network: str('UNICITY_NETWORK', str('NETWORK', 'testnet2')), // UNICITY_NETWORK is the documented alias
  oracleApiKey: str('ORACLE_API_KEY', 'sk_ddc3cfcc001e4a28ac3fad7407f99590'),
  walletApiUrl: str('WALLET_API_URL', 'https://wallet-api.unicity.network'),
  coinSymbol: str('COIN_SYMBOL', 'UCT'),

  // ── Treasury policy — the rules the agent funds by ────────────────────────
  // Every whole-UCT knob here is a hard constraint enforced with exact BigInt
  // math in policy.js. They compose belt-and-suspenders: a disbursement must
  // pass ALL of them, and the guarded send in sphere-client.js re-checks the
  // floor independently before any UCT leaves the wallet.
  treasury: Object.freeze({
    // Tier boundary. A disbursement of <= this is a pure SEED GRANT (no debt
    // tracked). Above it, the disbursement is booked as a repayable micro-LOAN.
    grantMaxWhole: num('GRANT_MAX_UCT', 1),
    // Default repayment term for Tier-2 loans (days). Repay by the due date to
    // build reputation; miss it and the account freezes until settled.
    loanTermDays: int('LOAN_TERM_DAYS', 7),
    // Absolute hard ceiling on ANY single disbursement, regardless of tier or
    // reputation. A last-resort clamp so no rule interaction can over-pay.
    maxSingleWhole: num('MAX_SINGLE_UCT', 10),
    // Rolling 24-hour outflow budget across ALL requesters combined.
    dailyBudgetWhole: num('DAILY_BUDGET_UCT', 25),
    // Untouchable reserve. The treasury will never let its spendable balance
    // fall below this — the corpus that keeps it solvent and credible.
    minBalanceFloorWhole: num('MIN_BALANCE_FLOOR_UCT', 25),
    // Per-requester throttle: max funding requests considered per rolling 24h
    // (early repayment temporarily raises this — see earlyBonus below).
    maxRequestsPer24h: int('MAX_REQUESTS_PER_24H', 5),

    // Reputation ladder. On-time repayments promote a requester up the tiers,
    // raising their single-loan ceiling and shrinking their cooldown. Grants
    // (Tier 1) are available to everyone, including brand-new Newbies.
    tiers: Object.freeze({
      newbie: Object.freeze({
        maxLoanWhole: num('TIER_NEWBIE_MAX_UCT', 2),
        cooldownMin: int('TIER_NEWBIE_COOLDOWN_MIN', 60),
        promoteAtOnTime: 0, // starting tier
      }),
      trusted: Object.freeze({
        maxLoanWhole: num('TIER_TRUSTED_MAX_UCT', 5),
        cooldownMin: int('TIER_TRUSTED_COOLDOWN_MIN', 30),
        promoteAtOnTime: int('TIER_TRUSTED_PROMOTE_AT', 2), // on-time repayments to reach Trusted
      }),
      partner: Object.freeze({
        maxLoanWhole: num('TIER_PARTNER_MAX_UCT', 10),
        cooldownMin: int('TIER_PARTNER_COOLDOWN_MIN', 15),
        promoteAtOnTime: int('TIER_PARTNER_PROMOTE_AT', 5), // on-time repayments to reach Partner
      }),
    }),

    // Early-repayment perk: repaying before the due date grants a temporary
    // boost to the personal daily request limit.
    earlyBonusHours: int('EARLY_BONUS_HOURS', 24),
    earlyBonusExtraRequests: int('EARLY_BONUS_EXTRA_REQUESTS', 2),
    // How long an account stays frozen after going overdue. It stays frozen at
    // least until the debt is settled; this is the extra cool-off afterwards.
    overdueFreezeHours: int('OVERDUE_FREEZE_HOURS', 48),
  }),

  // ── Economic safety rails ────────────────────────────────────────────────
  safety: Object.freeze({
    // Global observe-only kill-switch: log intended actions, touch nothing.
    dryRun: bool('DRY_RUN', false),
    // Master outflow switch. If false, the treasury evaluates and REPLIES to
    // requests but disburses nothing (useful to run "advice-only" or to freeze
    // all outflow instantly without a redeploy). Owner `pause` flips this live.
    disburseEnabled: bool('DISBURSE_ENABLED', true),
    // One-time capped self-mint of the corpus on first run (no faucet on testnet2).
    selfMintEnabled: bool('SELF_MINT_ENABLED', true),
    selfMintAmountWhole: num('SELF_MINT_AMOUNT', 250),
    // Refund the surplus when a borrower overpays a repayment (never keep more
    // than the outstanding debt). The other permitted outflow besides funding.
    autoRefundOverpayment: bool('AUTO_REFUND_OVERPAYMENT', true),
    // Politeness / anti-spam (relay protection; not a money control).
    maxDmsPerHour: int('MAX_DMS_PER_HOUR', 40),
    maxActionsPerHour: int('MAX_ACTIONS_PER_HOUR', 80),
    // Global cap on the NUMBER of disbursements per hour (rate, not amount).
    maxDisbursementsPerHour: int('MAX_DISBURSEMENTS_PER_HOUR', 20),
  }),

  // ── Owner admin (protected) ──────────────────────────────────────────────
  admin: Object.freeze({
    // The chain pubkey authorized for admin DMs. Empty => admin disabled.
    ownerPubkey,
    enabled: ownerPubkey.length > 0,
  }),

  // ── Housekeeping cadences ────────────────────────────────────────────────
  schedule: Object.freeze({
    // How often to sweep loans for due-soon reminders / overdue transitions (ms).
    sweepMs: int('SWEEP_MS', 15 * 60_000),
    // Cadence for the incoming-transfer / DM safety-net receive() poll (ms).
    receivePollMs: int('RECEIVE_POLL_MS', 45_000),
  }),

  // ── Public advert (the service intent on the market board) ────────────────
  publish: Object.freeze({
    serviceIntentEnabled: bool('SERVICE_INTENT_ENABLED', true),
    intentExpiresInDays: int('INTENT_EXPIRES_DAYS', 7),
    serviceDescription: str(
      'SERVICE_DESCRIPTION',
      'frani-treasury: an autonomous, rules-based UCT treasury on Unicity testnet2. ' +
        'DM @frani-treasury `request <amount> <reason>` for funding — small asks (<=1 UCT) ' +
        'are instant no-repayment seed grants; larger asks become 7-day repayable micro-loans ' +
        'that build your on-network reputation. Transparent caps, `status` any time. Run by CRYPTFRANI.',
    ),
    // Optional public heartbeat: broadcast a short solvency/status line each sweep.
    broadcastEnabled: bool('BROADCAST_ENABLED', false),
    broadcastTags: Object.freeze(list('BROADCAST_TAGS', ['treasury', 'grants', 'unicity'])),
  }),

  logLevel: str('LOG_LEVEL', 'info'),
});

export default config;

/**
 * test-solvency-truth-unit.mjs — offline proof that a wallet-api outage never
 * becomes a FUNDING DECISION.
 *
 * This treasury's whole claim is that every answer it gives is explainable down
 * to the individual check that produced it. `policy.evaluate()` returns an
 * ordered check trace precisely so a requester can be told *which* rule bound
 * them. That claim is only worth anything if the numbers going into the trace are
 * true.
 *
 * One of them can silently be a lie. `payments.assets()` RESOLVES WITH AN EMPTY
 * ARRAY when the wallet-api is unreachable — it does not throw. An empty array
 * parses as `confirmedAmount: 0`, `transferringAmount: 0`, `unconfirmedAmount: 0`,
 * which reads as a wallet that is both broke and perfectly quiescent. So an
 * outage does not surface as an outage. It surfaces as:
 *
 *   "🛑 The treasury is at its reserve floor and can't disburse right now."
 *
 *  …told to a requester by a treasury that is in fact holding 250 UCT. And
 * because the read looks quiescent, the reconcile then PERSISTS the zero, so the
 * treasury keeps declining everybody after the network comes back. Observed live
 * on 2026-08-27/28: `bookBalanceBase` on disk went to 0 against a real 250 UCT.
 *
 * WHAT THIS SUITE PINS, and why it cannot be lifted into a sibling repo: the
 * assertions do not stop at the balance reader. They run a real request through
 * `treasury.buildContext()` → `policy.evaluate()` and assert on the DECISION and
 * on the check trace — the reserve-floor gate specifically. Every claim below is
 * about this repo's decision engine, which no other agent in the fleet has.
 *
 * It also pins the structural property that makes the engine trustworthy at all:
 * `policy.js` reads no clock, no config and no wallet. It cannot be fooled by an
 * outage because it cannot see the network — every number it judges has to be
 * handed to it by `buildContext`, which is the single place the lie could enter.
 *
 * Offline: `SphereClient` takes an injected sphere. No network, no wallet, no
 * funds.  Run:  node test-solvency-truth-unit.mjs
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'frani-treasury-solvency-'));
process.env.ENV_FILE = join(tmp, 'no-such.env');
process.env.WALLET_DIR = tmp;
process.env.LOG_LEVEL = 'error';

const { SphereClient } = await import('./src/sphere-client.js');
const { State } = await import('./src/state.js');
const { default: config } = await import('./src/config.js');
const policy = (await import('./src/policy.js')).default;
const { buildContext } = await import('./src/treasury.js');
const reputation = (await import('./src/reputation.js')).default;

const DEC = 18n;
const D = 10n ** DEC;
const base = (whole) => (BigInt(Math.round(Number(whole) * 1000)) * D) / 1000n;
const COIN = { coinId: 'uct-coin-id', symbol: 'UCT', decimals: Number(DEC) };
const ASKER = `02${'b'.repeat(64)}`;

let passed = 0, failed = 0;
const ok = (cond, msg, got) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}${got !== undefined ? ` — got ${got}` : ''}`); }
};

/** The exact shape the SDK produces when the wallet-api cannot be reached. */
const OUTAGE = [];
const funded = (whole, extra = {}) => [{
  coinId: COIN.coinId,
  confirmedAmount: base(whole).toString(),
  transferringAmount: '0',
  unconfirmedAmount: '0',
  ...extra,
}];

function makeClient(assetRows, created = false) {
  const mints = [];
  const sphere = {
    payments: {
      rows: assetRows,
      async assets() { return this.rows; },
      async mint(args) { mints.push(args); return { success: true }; },
    },
    identity: { chainPubkey: `02${'a'.repeat(64)}` },
  };
  return { client: new SphereClient(sphere, COIN, 'device-test', created), sphere, mints };
}

const freshState = () => {
  const s = State.load();
  s.data.bookBalanceBase = undefined;
  s.data.requesters = {};
  s.data.loans = [];
  s.data.ledger = [];
  s.data.paused = false;
  return s;
};

/** Put a real request through the real engine and hand back the decision + trace. */
async function decide(client, state, { whole, now = Date.now(), pubkey = ASKER }) {
  const rec = state.ensureRequester(pubkey, null, now);
  const ctx = await buildContext(client, state, rec, now);
  const decision = policy.evaluate({ requestedBase: base(whole), nowMs: now }, ctx);
  const check = (name) => decision.checks.find((c) => c.name === name);
  return { rec, ctx, decision, check };
}

console.log('════════ frani-treasury · solvency-truth proof (offline) ════════');
console.log(`   (grant ≤ ${config.treasury.grantMaxWhole} UCT · floor ${config.treasury.minBalanceFloorWhole}`
  + ` · 24h budget ${config.treasury.dailyBudgetWhole} · max single ${config.treasury.maxSingleWhole})`);

console.log('\n[0] baseline: a funded corpus decides normally, and says why');
{
  const { client } = makeClient(funded(250));
  const st = freshState();
  client.attachState(st);

  const grant = await decide(client, st, { whole: 1 });
  ok(grant.decision.decision === 'approve' && grant.decision.kind === 'grant',
    `${config.treasury.grantMaxWhole} UCT is an instant grant`, `${grant.decision.decision}/${grant.decision.kind}`);
  ok(grant.decision.checks.length >= 6, 'and the decision carries its ordered check trace', grant.decision.checks.length);

  const loan = await decide(client, st, { whole: 2, pubkey: `02${'c'.repeat(64)}` });
  ok(loan.decision.kind === 'loan', 'above the grant ceiling it books a loan', loan.decision.kind);
  ok(loan.check('reserve-floor')?.ok === true, 'the reserve-floor gate passes on a funded corpus');
}

console.log('\n[1] AN OUTAGE MUST NOT COME BACK AS "AT THE RESERVE FLOOR"');
{
  const { client, sphere } = makeClient(funded(250));
  const st = freshState();
  client.attachState(st);
  await client.effectiveSpendableBase(); // anchor the book at 250
  ok(st.getBookBase() === base(250), 'anchored at 250 UCT while the network was up', st.getBookBase());

  sphere.payments.rows = OUTAGE; // the wallet-api goes away mid-conversation

  const { ctx, decision, check } = await decide(client, st, { whole: 2 });
  // These four fail without the fix: the empty read makes balanceBase 0, the
  // reserve-floor clamp caps the amount at 0, and the requester is told the
  // treasury is broke.
  ok(ctx.balanceBase === base(250), 'buildContext still sees the 250 UCT corpus', ctx.balanceBase);
  ok(decision.decision === 'approve', 'the request is still approved', decision.decision);
  ok(decision.code !== policy.CODES.RESERVE_FLOOR,
    'NOT rejected for the reserve floor by a network outage', decision.code);
  ok(check('reserve-floor')?.ok === true, 'and the trace does not blame the floor', check('reserve-floor')?.detail);
  ok(decision.amountBase === base(2), 'for the full amount asked, unclamped', decision.amountBase);
}

console.log('\n[2] AND MUST NOT POISON THE BOOK, so it keeps deciding right afterwards');
{
  const { client, sphere } = makeClient(funded(250));
  const st = freshState();
  client.attachState(st);
  await client.effectiveSpendableBase();

  sphere.payments.rows = OUTAGE;
  await decide(client, st, { whole: 2 });
  ok(st.getBookBase() === base(250), 'the outage wrote nothing to disk', st.getBookBase());
  ok(st.getBookBase() !== 0n, 'the false-quiescent reconcile did not fire', st.getBookBase());

  // The failure mode that mattered: it outlives the outage.
  sphere.payments.rows = funded(250);
  const after = await decide(client, st, { whole: 2, pubkey: `02${'d'.repeat(64)}` });
  ok(after.decision.decision === 'approve', 'once the network is back it is still approving', after.decision.decision);
  ok(after.ctx.balanceBase === base(250), 'from a book that was never corrupted', after.ctx.balanceBase);
}

console.log('\n[3] A GENUINELY EMPTY CORPUS STILL DECLINES — silence and zero differ');
{
  const { client } = makeClient(funded(0));
  const st = freshState();
  client.attachState(st);
  const { decision, check } = await decide(client, st, { whole: 2 });
  ok(decision.decision === 'reject', 'a real zero is rejected', decision.decision);
  ok(decision.code === policy.CODES.RESERVE_FLOOR, 'and named as the reserve floor', decision.code);
  ok(check('reserve-floor')?.ok === false, 'the trace blames the floor, correctly');
  ok(/reserve floor|can.t (fund|disburse)|insufficient/i.test(decision.reason),
    'and the requester is told the treasury is out of room', decision.reason);
}

console.log('\n[4] a real balance below the floor is honoured — the fix did not blunt the floor');
{
  const floor = config.treasury.minBalanceFloorWhole;
  const { client } = makeClient(funded(floor + 1));
  const st = freshState();
  client.attachState(st);
  const { decision } = await decide(client, st, { whole: 5 });
  ok(decision.amountBase <= base(1),
    `with only 1 UCT above the ${floor} floor, a 5 UCT ask is clamped to at most 1`, decision.amountBase);
  ok(decision.decision === 'partial' || decision.amountBase === base(1),
    'and reported as a partial fund rather than a silent shortfall', decision.decision);
}

console.log('\n[5] with no anchor yet an outage reports 0 but persists nothing');
{
  const { client } = makeClient(OUTAGE);
  const st = freshState();
  client.attachState(st);
  const v = await client.effectiveSpendableBase();
  ok(v === 0n, 'it has nothing better to report than 0', v);
  ok(st.getBookBase() == null, 'but writes NO anchor it cannot vouch for', st.getBookBase());
}

console.log('\n[6] the bootstrap mint is gated on the same distinction');
{
  const pre = makeClient(OUTAGE, false); // a wallet that existed before this boot
  pre.client.attachState(freshState());
  await pre.client.bootstrapMintIfNeeded();
  ok(pre.mints.length === 0,
    'an outage on a PRE-EXISTING wallet mints nothing — it may already hold the corpus', pre.mints.length);

  const born = makeClient(OUTAGE, true); // generated on this very boot
  born.client.attachState(freshState());
  await born.client.bootstrapMintIfNeeded();
  ok(born.mints.length === 1,
    'a wallet created on THIS boot cannot already hold funds, so it still seeds the corpus', born.mints.length);

  const full = makeClient(funded(250), false);
  full.client.attachState(freshState());
  await full.client.bootstrapMintIfNeeded();
  ok(full.mints.length === 0, 'and a funded treasury never re-mints', full.mints.length);
}

console.log('\n[7] an outage cannot touch the reputation ladder or the loan book');
{
  const { client, sphere } = makeClient(funded(250));
  const st = freshState();
  client.attachState(st);
  await client.effectiveSpendableBase();
  const before = { loans: st.data.loans.length, ledger: st.data.ledger.length };

  sphere.payments.rows = OUTAGE;
  const { rec, decision } = await decide(client, st, { whole: 2 });
  ok(st.data.loans.length === before.loans, 'evaluating creates no loan on its own', st.data.loans.length);
  ok(reputation.tierOf(rec) === 'newbie', 'and does not move the tier', reputation.tierOf(rec));
  ok((rec.onTimeRepayments ?? 0) === 0, 'nor invent repayment history', rec.onTimeRepayments);
  ok(decision.decision === 'approve', 'while still answering truthfully', decision.decision);
  ok(st.outstandingDebtBase(ASKER) === 0n, 'nobody owes anything yet', st.outstandingDebtBase(ASKER));
}

console.log('\n[8] the decision engine is blind to the network BY CONSTRUCTION');
{
  const src = readFileSync(new URL('./src/policy.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^\s*import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
  ok(!imports.some((i) => /sphere|sdk|config|state|reputation/i.test(i)),
    'policy.js imports no SDK, no config, no state and no clock', imports.join(', '));
  ok(!/Date\.now\(\)/.test(src), 'and never reads the clock — `now` is passed in', 'Date.now found');
  ok(!/await/.test(src), 'it is fully synchronous, so it cannot await a wallet read');

  // Therefore the same numbers always give the same answer, outage or not.
  const ctx = {
    balanceBase: base(250), floorBase: base(25), dailyBudgetBase: base(25), dailySpentBase: 0n,
    maxSingleBase: base(10), grantMaxBase: base(1), outstandingDebtBase: 0n, creditLimitBase: base(2),
    cooldownMs: 0, lastRequestAt: 0, requestsIn24h: 0, dailyRequestLimit: 5,
    frozen: false, blacklisted: false, hasOverdue: false, disburseEnabled: true, paused: false,
  };
  const a = policy.evaluate({ requestedBase: base(2), nowMs: 1 }, ctx);
  const b = policy.evaluate({ requestedBase: base(2), nowMs: 1 }, ctx);
  const show = (d) => JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  ok(show(a) === show(b), 'the engine is deterministic on a fixed context');
  ok(a.checks.every((c) => typeof c.name === 'string' && 'ok' in c),
    'and every check in the trace is named and resolved');
}

console.log(`\n════════ ${passed} passed, ${failed} failed ════════`);
process.exit(failed === 0 ? 0 : 1);

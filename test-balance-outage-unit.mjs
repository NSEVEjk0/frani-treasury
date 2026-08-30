/**
 * test-balance-outage-unit.mjs — offline proof that a wallet-api outage is never
 * mistaken for a zero corpus.
 *
 * `payments.assets()` resolves with an EMPTY ARRAY when the wallet-api cannot be
 * reached. It does not throw. So at the call site an outage and a genuinely empty
 * wallet are indistinguishable — and this treasury had three places that read the
 * silence as a balance of zero:
 *
 *   1. `effectiveSpendableBase()` — the worst of the three. An empty read makes
 *      `transferringAmount` and `unconfirmedAmount` both parse as 0, so the wallet
 *      looks *quiescent*, and the reconcile then overwrote the book balance with
 *      zero AND PERSISTED IT. A treasury holding 250 UCT would decline every
 *      request, and keep declining after the outage ended, until some later
 *      quiescent read happened to heal it.
 *   2. `spendableBase()` — reported 0 to the operator and to `status`.
 *   3. `bootstrapMintIfNeeded()` — saw 0 < floor and would mint a *second*
 *      bootstrap onto an already-funded treasury.
 *
 * This was observed live on 2026-08-27/28: the treasury's on-disk
 * `bookBalanceBase` went to 0 while the wallet actually held 250 UCT.
 *
 * The fix is `_coinRow()`, which reports whether a row came back at all, so
 * silence can be handled as silence.
 *
 * Offline: the SphereClient constructor takes an injected `sphere`, so no
 * network, no wallet and no funds are involved.
 *
 * Gitignored by default (test-*.mjs) and negated explicitly. Run:
 *   node test-balance-outage-unit.mjs
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'frani-treasury-outage-'));
process.env.ENV_FILE = join(tmp, 'no-such.env'); // config falls back to defaults
process.env.WALLET_DIR = tmp; // state.json lives here
process.env.LOG_LEVEL = 'error';

const { SphereClient } = await import('./src/sphere-client.js');
const { State } = await import('./src/state.js');

const DEC = 18n;
const D = 10n ** DEC;
const base = (whole) => (BigInt(Math.round(Number(whole) * 1000)) * D) / 1000n;
const COIN = { coinId: 'uct-coin-id', symbol: 'UCT', decimals: Number(DEC) };

let passed = 0, failed = 0;
const ok = (cond, msg, got) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}${got !== undefined ? ` — got ${got}` : ''}`); }
};

/**
 * A fake sphere whose `assets()` returns whatever we hand it. `OUTAGE` is the
 * real shape the SDK produces when the wallet-api is unreachable: not an error,
 * not a row with zeros — an empty array.
 */
const OUTAGE = [];
const funded = (whole, extra = {}) => [{
  coinId: COIN.coinId,
  confirmedAmount: base(whole).toString(),
  transferringAmount: '0',
  unconfirmedAmount: '0',
  ...extra,
}];
const OTHER_COIN_ONLY = [{ coinId: 'some-other-coin', confirmedAmount: base(999).toString() }];

const makeClient = (assetRows) => {
  const sphere = {
    payments: {
      rows: assetRows,
      async assets() { return this.rows; },
      async mint() { throw new Error('mint must not be called'); },
    },
    identity: { chainPubkey: '02' + 'a'.repeat(64) },
  };
  const c = new SphereClient(sphere, COIN, 'device-test', false);
  return { client: c, sphere };
};

const freshState = () => {
  const s = State.load();
  s.data.bookBalanceBase = undefined;
  return s;
};

console.log('════════ frani-treasury · balance-outage unit proof (offline) ════════');

console.log('\n[0] the harness is sound: a real row is still read normally');
{
  const { client } = makeClient(funded(250));
  ok((await client.spendableBase()) === base(250), 'a present row reads 250 UCT');
  const st = freshState();
  client.attachState(st);
  ok((await client.effectiveSpendableBase()) === base(250), 'and anchors the book to 250 UCT');
  ok(st.getBookBase() === base(250), 'the anchor is persisted', st.getBookBase());
}

console.log('\n[1] AN OUTAGE NEVER OVERWRITES A KNOWN BOOK BALANCE');
{
  const { client, sphere } = makeClient(funded(250));
  const st = freshState();
  client.attachState(st);
  await client.effectiveSpendableBase();            // anchor at 250
  ok(st.getBookBase() === base(250), 'anchored at 250 UCT first');

  sphere.payments.rows = OUTAGE;                     // the wallet-api goes away
  const during = await client.effectiveSpendableBase();
  ok(during === base(250), 'during the outage the corpus still reads 250 UCT', during);
  ok(st.getBookBase() === base(250), 'and the book on disk is NOT zeroed', st.getBookBase());

  // This is the assertion that fails without the fix: an empty array makes
  // transferring/unconfirmed both 0, so the wallet looks quiescent and the
  // reconcile writes `confirmed` (0) straight over the book.
  ok(st.getBookBase() !== 0n, 'the false-quiescent reconcile did not fire', st.getBookBase());
}

console.log('\n[2] the book heals normally once the wallet-api answers again');
{
  const { client, sphere } = makeClient(funded(250));
  const st = freshState();
  client.attachState(st);
  await client.effectiveSpendableBase();
  sphere.payments.rows = OUTAGE;
  await client.effectiveSpendableBase();
  sphere.payments.rows = funded(180);                // a real, smaller balance
  const after = await client.effectiveSpendableBase();
  ok(after === base(180), 'a real read still reconciles the book DOWN', after);
  ok(st.getBookBase() === base(180), 'and persists the true figure', st.getBookBase());
}

console.log('\n[3] with no anchor yet, an outage reports 0 but persists nothing');
{
  const { client, sphere } = makeClient(OUTAGE);
  const st = freshState();
  client.attachState(st);
  const v = await client.effectiveSpendableBase();
  ok(v === 0n, 'a first-ever read during an outage reports 0 (nothing better to say)', v);
  ok(st.getBookBase() == null, 'but does NOT anchor the book to that 0', st.getBookBase());

  sphere.payments.rows = funded(100);
  await client.effectiveSpendableBase();
  ok(st.getBookBase() === base(100), 'so the first real read is what anchors it', st.getBookBase());
}

console.log('\n[4] a row for a DIFFERENT coin is treated as silence, not as zero');
{
  const { client } = makeClient(OTHER_COIN_ONLY);
  const st = freshState();
  client.attachState(st);
  await client.effectiveSpendableBase();
  ok(st.getBookBase() == null, 'no anchor is taken from someone else\'s coin row', st.getBookBase());
}

console.log('\n[5] a genuinely empty wallet still reads as zero — the fix is not a mask');
{
  const { client } = makeClient(funded(0));
  const st = freshState();
  client.attachState(st);
  ok((await client.spendableBase()) === 0n, 'a real row saying 0 reads 0');
  ok((await client.effectiveSpendableBase()) === 0n, 'and anchors the book at 0');
  ok(st.getBookBase() === 0n, 'which IS persisted, because the backend answered', st.getBookBase());
}

console.log('\n[6] an in-flight settle window is still respected (not confused with an outage)');
{
  const { client, sphere } = makeClient(funded(250));
  const st = freshState();
  client.attachState(st);
  await client.effectiveSpendableBase();
  // Mid-settle: confirmed dips to ~0 while everything sits in transferring.
  sphere.payments.rows = funded(0, { transferringAmount: base(250).toString() });
  const mid = await client.effectiveSpendableBase();
  ok(mid === base(250), 'the book carries the corpus through the settle window', mid);
  ok(st.getBookBase() === base(250), 'and is not reconciled mid-settle', st.getBookBase());
}

console.log('\n[7] BOOTSTRAP MINT never fires on an unanswered balance');
{
  // The fake sphere throws if mint() is reached, so a double-bootstrap is a crash.
  const { client } = makeClient(OUTAGE);
  let threw = null;
  try { await client.bootstrapMintIfNeeded(); } catch (err) { threw = err?.message ?? String(err); }
  ok(threw === null, 'no mint was attempted during an outage', threw);
}

console.log(`\n  ${passed} passed, ${failed} failed`);
console.log(failed === 0
  ? '  ✅ ALL PASS — silence from the wallet-api is never read as a zero corpus.'
  : '  ❌ FAILURES — an outage can still be mistaken for an empty treasury.');
process.exit(failed === 0 ? 0 : 1);

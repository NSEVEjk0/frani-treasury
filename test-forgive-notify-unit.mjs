/**
 * test-forgive-notify-unit.mjs — offline proof that forgiving a loan tells the
 * BORROWER, not just the owner.
 *
 * `forgive <loanId>` zeroed the debt, lifted the borrower's freeze, and replied
 * "✅ forgiven and written off" — to the owner. The borrower heard nothing. Their
 * standing had changed terminally and in their favour, and the one person who needed
 * to know was the one not told: somebody frozen out over an overdue loan keeps
 * believing they are frozen and stops asking.
 *
 * Same class as the silent closes fixed in @frani-agora (refundDeal, c5ea1a6) and
 * @frani-bounty (refundBounty, 63efd6b) — a terminal transition with no notification
 * to the counterparty. Found by auditing every terminal transition in the fleet.
 *
 * Offline: no network, no wallet, no funds. Drives the real handleDm → cmdForgive path
 * against a fake client, with OWNER_PUBKEY set to a throwaway key so the owner gate
 * opens without touching the live .env.
 *
 * Gitignored (test-*.mjs). Run: node test-forgive-notify-unit.mjs
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'frani-treasury-forgive-'));
process.env.ENV_FILE = join(tmp, 'no-such.env'); // config falls back to defaults
process.env.WALLET_DIR = tmp;
process.env.LOG_LEVEL = 'error';

// A throwaway owner key so the admin gate opens here without the real one.
const OWNER = '02' + 'f'.repeat(64);
process.env.OWNER_PUBKEY = OWNER;

const { State, normalizeKey } = await import('./src/state.js');
const { handleDm } = await import('./src/services/commands.js');
const { RateLimiter } = await import('./src/ratelimit.js');
const { default: config } = await import('./src/config.js');
const { default: reputation } = await import('./src/reputation.js');

const DEC = 18n;
const UCT = (n) => (BigInt(n) * 10n ** DEC).toString();
const toWhole = (base) => {
  const b = BigInt(base), D = 10n ** DEC;
  const f = (b % D).toString().padStart(Number(DEC), '0').replace(/0+$/, '');
  return f ? `${b / D}.${f}` : `${b / D}`;
};

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ ${msg}`); } };

const makeClient = () => ({
  dms: [],
  sends: [],
  coin: { symbol: 'UCT', decimals: Number(DEC) },
  fmt: (base) => `${toWhole(base)} UCT`,
  toBase: (whole) => UCT(String(whole).split('.')[0]),
  toWhole,
  async sendDM(recipient, content) { this.dms.push({ recipient, content }); return { id: `dm-${this.dms.length}` }; },
  async send(recipient, base, memo) { this.sends.push({ recipient, base: String(base), memo }); return { status: 'ok' }; },
});

const BORROWER = '02' + 'b'.repeat(64);
const DAY_MS = 86_400_000;
const dmFrom = (pub, tag, content) => ({ senderPubkey: pub, senderNametag: tag, content, id: `m-${Math.abs(content.length)}-${pub.slice(2, 8)}` });

/** Fresh state carrying one loan; `overdue` also freezes the borrower, as the sweep does. */
function stateWithLoan({ overdue = false } = {}) {
  const state = State.load();
  for (const l of state.allLoans()) delete state.data.loans[l.id];
  const now = Date.now();
  state.ensureRequester(normalizeKey(BORROWER), 'borrower-demo', now);
  const loan = state.createLoan({
    id: 'loan-abcdef12',
    requester: normalizeKey(BORROWER),
    requesterNametag: 'borrower-demo',
    principalBase: UCT(2),
    disbursedAt: now - (overdue ? 40 : 1) * DAY_MS,
    termDays: 30,
  });
  if (overdue) {
    loan.status = 'overdue';
    loan.overdueNotified = true;
    state.freeze(normalizeKey(BORROWER), now + config.treasury.overdueFreezeHours * 3600_000);
  }
  state.save();
  return { state, loan };
}

const toBorrower = (client) => client.dms.filter((m) => /borrower-demo/.test(String(m.recipient)));
const toOwner = (client) => client.dms.filter((m) => !/borrower-demo/.test(String(m.recipient)));

console.log('════════ frani-treasury · forgive-notification unit proof (offline) ════════');

console.log('\n[0] the fake owner gate is actually open (otherwise this proves nothing)');
ok(config.admin.enabled === true, 'admin is enabled for this run');
ok(normalizeKey(config.admin.ownerPubkey) === normalizeKey(OWNER), 'the throwaway key is the owner');

// ── 1) forgiving an OVERDUE loan: debt gone, freeze lifted, borrower told ──────
console.log('\n[1] forgiving an overdue loan tells the borrower AND lifts the freeze');
{
  const client = makeClient();
  const { state } = stateWithLoan({ overdue: true });
  const rl = new RateLimiter();

  const before = state.getRequester(normalizeKey(BORROWER));
  ok(reputation.isFrozen(before, Date.now()) === true, 'the borrower starts frozen');

  await handleDm(client, state, rl, dmFrom(OWNER, 'itachi', 'forgive loan-abcdef12'));

  const loan = state.getLoan('loan-abcdef12');
  ok(loan.status === 'forgiven', 'the loan is forgiven');
  ok(loan.outstandingBase === '0', 'nothing outstanding');
  ok(client.sends.length === 0, 'no funds moved — forgiveness is a write-off, not a payment');

  const after = state.getRequester(normalizeKey(BORROWER));
  ok(reputation.isFrozen(after, Date.now()) === false, 'the freeze is lifted');

  ok(toOwner(client).length === 1, `the owner gets their confirmation (got ${toOwner(client).length})`);
  const b = toBorrower(client);
  ok(b.length === 1, `the borrower is told, exactly once (got ${b.length})`);
  const body = b[0]?.content ?? '';
  ok(/forgiven/i.test(body), 'it says forgiven');
  ok(/2 UCT/.test(body), 'it names the amount written off');
  ok(/owe nothing/i.test(body), 'it says they owe nothing further');
  ok(/unfrozen/i.test(body), 'and tells them they can borrow again — the part that matters most');
}

// ── 2) forgiving a loan from a borrower who was never frozen ───────────────────
console.log('\n[2] a borrower who was never frozen is not promised an unfreeze');
{
  const client = makeClient();
  const { state } = stateWithLoan({ overdue: false });
  const rl = new RateLimiter();

  await handleDm(client, state, rl, dmFrom(OWNER, 'itachi', 'forgive loan-abcdef12'));

  const b = toBorrower(client);
  ok(b.length === 1, `the borrower is still told (got ${b.length})`);
  const body = b[0]?.content ?? '';
  ok(/forgiven/i.test(body), 'it says forgiven');
  ok(!/unfrozen/i.test(body), 'it does NOT claim a freeze was lifted (there was none)');
}

// ── 3) the gate still holds: a non-owner cannot forgive ────────────────────────
console.log('\n[3] a non-owner `forgive` changes nothing and reaches no borrower');
{
  const client = makeClient();
  const { state } = stateWithLoan({ overdue: true });
  const rl = new RateLimiter();

  await handleDm(client, state, rl, dmFrom(BORROWER, 'borrower-demo', 'forgive loan-abcdef12'));

  const loan = state.getLoan('loan-abcdef12');
  ok(loan.status === 'overdue', 'the loan is untouched');
  ok(loan.outstandingBase === UCT(2), 'the debt still stands');
  const all = client.dms.map((m) => m.content).join('\n');
  ok(/unknown command/i.test(all), 'answered as an unknown command — the owner surface is not revealed');
  ok(!/forgiven/i.test(all), 'nobody is told anything was forgiven');
}

// ── 4) an unknown loan id ─────────────────────────────────────────────────────
console.log('\n[4] forgiving an unknown loan id notifies nobody but the owner');
{
  const client = makeClient();
  const { state } = stateWithLoan({ overdue: true });
  const rl = new RateLimiter();

  await handleDm(client, state, rl, dmFrom(OWNER, 'itachi', 'forgive no-such-loan'));

  ok(state.getLoan('loan-abcdef12').status === 'overdue', 'the real loan is untouched');
  ok(toBorrower(client).length === 0, 'no borrower is told anything');
  ok(/usage/i.test(toOwner(client)[0]?.content ?? ''), 'the owner gets a usage hint');
}

console.log(`\n  ${passed} passed, ${failed} failed`);
console.log(failed === 0
  ? '  ✅ ALL PASS — forgiveness reaches the person it benefits.'
  : '  ❌ FAILURES — a terminal change in standing is still silent.');
process.exit(failed === 0 ? 0 : 1);

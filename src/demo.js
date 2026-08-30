/**
 * frani-treasury — `npm run demo`
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * A five-minute read of the only thing this treasury does: decide, in public,
 * how much UCT an identity may have — and let that answer change as the identity
 * earns it back.
 *
 * The real `policy.js`, the real `reputation.js`, the real `state.js` ledger and
 * the real lifecycle in `treasury.js` run here against a fake wallet. Every
 * decision printed is produced by the code the daemon runs, including the ordered
 * check trace. Nothing is booted, no wallet is opened, no socket is connected and
 * no UCT exists — so unlike `--whoami` this is safe to run while the service is up.
 *
 * PATH A (happy) — a brand-new identity takes a seed grant, then a loan clamped
 * to its Newbie ceiling, repays on time twice, and is PROMOTED. The same request
 * that was clamped to 2 UCT at the start is approved in full at 5 UCT at the end.
 * Nothing about that promotion is asserted by the requester; it is derived
 * entirely from repayments the treasury actually received.
 *
 * PATH B (failure) — a second identity borrows and then goes quiet. The loan
 * falls overdue, the account freezes, and the next request is DECLINED with the
 * exact gate that stopped it. Then they settle, slightly over, and the surplus is
 * refunded — reported as refunded only because the send actually succeeded.
 */

import config from './config.js';
import { State } from './state.js';
import { RateLimiter } from './ratelimit.js';
import policy from './policy.js';
import reputation from './reputation.js';
import { buildContext, handleFundingRequest, applyIncomingRepayment, sweepLoans } from './treasury.js';

const DEC = 18;
const D = 10n ** BigInt(DEC);
const base = (whole) => (BigInt(Math.round(Number(whole) * 1e6)) * D) / 1_000_000n;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ALICE = `02${'b'.repeat(64)}`;
const BORIS = `02${'c'.repeat(64)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rule = (t) => console.log(`\n\x1b[1m${'─'.repeat(76)}\n ${t}\n${'─'.repeat(76)}\x1b[0m`);
const beat = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);
const note = (t) => console.log(`\x1b[2m  ${t}\x1b[0m`);

/** Corpus held by the fake wallet; the demo debits it as the treasury disburses. */
let corpusBase = base(250);
const sent = [];      // every outbound move, so the demo can show the total
let refundFails = false;

const client = {
  coin: { coinId: 'uct-coin-id', symbol: 'UCT', decimals: DEC },
  nametag: config.nametag,
  toBase: (whole) => base(whole),
  toWhole(b) {
    const v = BigInt(b);
    const frac = (v % D).toString().padStart(DEC, '0').replace(/0+$/, '');
    return `${v / D}${frac ? `.${frac}` : ''}`;
  },
  fmt(b) { return `${this.toWhole(b)} ${this.coin.symbol}`; },
  async effectiveSpendableBase() { return corpusBase; },
  async disburse(to, amountBase, memo) {
    corpusBase -= BigInt(amountBase);
    sent.push({ kind: 'disburse', to, amountBase: BigInt(amountBase), memo });
    console.log(`\n  \x1b[33m⇢ DISBURSE ${this.fmt(amountBase)} → ${String(to).slice(0, 12)}…\x1b[0m`);
    note(`corpus now ${this.fmt(corpusBase)} · memo: ${memo}`);
    return { success: true };
  },
  async refund(to, amountBase, memo) {
    if (refundFails) {
      console.log(`\n  \x1b[31m⇢ REFUND ${this.fmt(amountBase)} FAILED (wallet-api unreachable)\x1b[0m`);
      return { error: 'wallet-api unreachable' };
    }
    corpusBase -= BigInt(amountBase);
    sent.push({ kind: 'refund', to, amountBase: BigInt(amountBase), memo });
    console.log(`\n  \x1b[33m⇢ REFUND ${this.fmt(amountBase)} → ${String(to).slice(0, 12)}…\x1b[0m`);
    return { success: true };
  },
  async mint() { return { success: false, error: 'the demo never mints' }; },
  async sendDM(_to, body) {
    console.log(`\n  \x1b[32m@${config.nametag} → requester\x1b[0m`);
    for (const line of String(body).split('\n')) console.log(`  \x1b[32m│\x1b[0m ${line}`);
    return { id: 'dm' };
  },
};

const ask = (pubkey, tag, text) => {
  console.log(`\n  \x1b[35m@${tag} → @${config.nametag}\x1b[0m  ${text}`);
  return { id: `dm-${Math.random()}`, senderPubkey: pubkey, senderNametag: tag, content: text };
};

/** Print the ordered check trace exactly as the engine produced it. */
function trace(decision) {
  console.log(`\n  \x1b[1mdecision\x1b[0m ${decision.decision.toUpperCase()}` +
    `${decision.kind ? ` (${decision.kind})` : ''} · code ${decision.code} · amount ${client.fmt(decision.amountBase)}`);
  for (const c of decision.checks) {
    console.log(`    ${c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c.name.padEnd(20)} ${c.detail ?? ''}`);
  }
}

function standing(state, pubkey, label) {
  const rec = state.ensureRequester(pubkey, null);
  const tier = reputation.tierOf(rec);
  console.log(`\n  \x1b[1m${label}\x1b[0m  tier ${reputation.describeTier(tier)}` +
    ` · loan ceiling ${reputation.tierParams(tier).maxLoanWhole} UCT` +
    ` · cooldown ${Math.round(reputation.cooldownMsFor(rec) / 60_000)} min` +
    ` · on-time ${rec.onTimeRepayments} · late ${rec.lateRepayments}` +
    ` · outstanding ${client.fmt(state.outstandingDebtBase(pubkey))}` +
    ` · ${reputation.isFrozen(rec) ? '\x1b[31mFROZEN\x1b[0m' : 'clear'}`);
}

/** Ask, but with the cooldown wound back so the demo does not sit for an hour. */
async function request(state, rl, pubkey, tag, whole, reason) {
  const rec = state.ensureRequester(pubkey, null);
  rec.lastRequestAt = 0;
  const dm = ask(pubkey, tag, `request ${whole} ${reason}`);
  const out = await handleFundingRequest(client, state, rl, {
    dm, requestedBase: base(whole), reason,
  });
  if (out?.decision) trace(out.decision);
  return out;
}

const repay = (pubkey, tag, whole) => {
  console.log(`\n  \x1b[33m⇠ @${tag} sends ${whole} UCT back\x1b[0m`);
  return { id: `t-${Math.random()}`, senderPubkey: pubkey, senderNametag: tag };
};

export async function runDemo({ pace = 900 } = {}) {
  const state = new State({
    version: 1, serviceIntentId: null, paused: false,
    bookBalanceBase: corpusBase.toString(),
    seenDmIds: [], seenTransferIds: [], handledRequestIds: [],
    requesters: {}, loans: {}, disbursements: [], ledger: [],
    stats: { grants: 0, loans: 0, rejects: 0, partials: 0, repaid: 0, disbursedBase: '0' },
  });
  state.save = () => {}; // the demo touches no disk
  const rl = new RateLimiter();

  console.log(`\n\x1b[1m@${config.nametag}\x1b[0m — a rules-based UCT treasury. Grants, loans, and standing you earn.`);
  console.log(`Owner: ${config.owner} · made by ${config.brand} · Unicity ${config.network}`);
  note(`corpus ${client.fmt(corpusBase)} · reserve floor ${config.treasury.minBalanceFloorWhole} UCT`
    + ` · 24h budget ${config.treasury.dailyBudgetWhole} UCT · grants ≤ ${config.treasury.grantMaxWhole} UCT`);
  note('Real policy engine, real reputation ladder, fake wallet. No socket is opened.');

  // ───────────────────────────── PATH A ─────────────────────────────────────
  rule('PATH A — standing is earned: Newbie → Trusted, and the ceiling moves');

  standing(state, ALICE, 'alice');
  beat('A grant first. Under the ceiling, so no debt is tracked at all — this is the');
  note('onboarding path: developer gas, in one step, for an account with no history.');
  await request(state, rl, ALICE, 'alice', config.treasury.grantMaxWhole, 'gas to test my agent');
  standing(state, ALICE, 'alice');
  await sleep(pace);

  beat('Now more than the grant ceiling. It becomes a loan — and her Newbie ceiling');
  note(`clamps it. Watch the trace: the ask is 4, the tier ceiling is`
    + ` ${config.treasury.tiers.newbie.maxLoanWhole}, and she is told which rule bound her.`);
  await request(state, rl, ALICE, 'alice', 4, 'fund my test harness');
  standing(state, ALICE, 'alice');
  await sleep(pace);

  beat('She repays inside the window. On time counts.');
  let debt = state.outstandingDebtBase(ALICE);
  await applyIncomingRepayment(client, state, rl, { transfer: repay(ALICE, 'alice', client.toWhole(debt)), amountBase: debt });
  standing(state, ALICE, 'alice');
  await sleep(pace);

  beat('A second loan, and a second on-time repayment. This is the promotion.');
  await request(state, rl, ALICE, 'alice', 2, 'second harness run');
  debt = state.outstandingDebtBase(ALICE);
  await applyIncomingRepayment(client, state, rl, { transfer: repay(ALICE, 'alice', client.toWhole(debt)), amountBase: debt });
  standing(state, ALICE, 'alice');
  note(`Two on-time repayments = ${config.treasury.tiers.trusted.promoteAtOnTime} required. Tier up.`);
  await sleep(pace);

  beat('The identical 4 UCT request she made at the start. Same treasury, same rules —');
  note('a different answer, because the ledger says she is good for it now.');
  await request(state, rl, ALICE, 'alice', 4, 'the same ask as before');
  standing(state, ALICE, 'alice');
  note('Nothing was asserted about alice. Every number above came from repayments received.');
  await sleep(pace);

  // ───────────────────────────── PATH B ─────────────────────────────────────
  rule('PATH B — the decline: overdue, frozen, and told exactly which gate stopped it');

  beat('Boris borrows.');
  await request(state, rl, BORIS, 'boris', 2, 'running a node');
  standing(state, BORIS, 'boris');
  await sleep(pace);

  beat('Then he goes quiet, and the term runs out. The sweep — not a human — notices.');
  const loan = state.activeLoansFor(BORIS)[0];
  loan.dueAt = Date.now() - 2 * HOUR;
  note(`loan ${String(loan.id).slice(0, 8)}… due ${new Date(loan.dueAt).toISOString()} (2h ago)`);
  await sweepLoans(client, state, rl, Date.now());
  standing(state, BORIS, 'boris');
  await sleep(pace);

  beat('He asks for more. THIS is the decline the whole engine exists to produce:');
  note('not "no", but the ordered list of gates with the one that stopped him marked.');
  await request(state, rl, BORIS, 'boris', 1, 'just a little gas');
  note('A hard gate short-circuits, so the trace stops at the failure — nothing after it');
  note('was consulted, and the reply names it rather than hiding behind "unavailable".');
  await sleep(pace);

  beat('He settles up — and sends slightly too much.');
  const owed = state.outstandingDebtBase(BORIS);
  const over = owed + base(0.4);
  await applyIncomingRepayment(client, state, rl, { transfer: repay(BORIS, 'boris', client.toWhole(over)), amountBase: over });
  standing(state, BORIS, 'boris');
  note('Debt cleared, and the 0.4 surplus went back out. Late, so no on-time credit —');
  note('the freeze lifts on its cool-off, but the tier has to be earned from here.');
  await sleep(pace);

  beat('The same overpayment when the refund CANNOT go out. This is the honesty rule.');
  refundFails = true;
  await request(state, rl, BORIS, 'boris', 2, 'one more, and this one is a loan');
  const owed2 = state.outstandingDebtBase(BORIS);
  await applyIncomingRepayment(client, state, rl, {
    transfer: repay(BORIS, 'boris', client.toWhole(owed2 + base(0.4))), amountBase: owed2 + base(0.4),
  });
  note('`client.refund` RESOLVES with {error} rather than throwing, so a caller that');
  note('ignored the return value would have told him the surplus was on its way. The');
  note('reply above does not claim "refunded" — it says the opposite, in as many words,');
  note('and the 0.4 is written to the ledger as `refund-owed` rather than absorbed.');
  note('A third outcome exists: an UNCONFIRMED refund is never retried and never');
  note('claimed either way — he is told to check his wallet. Silence is not one of');
  note('the three answers.');
  refundFails = false;

  // ───────────────────────────── the point ──────────────────────────────────
  rule('What both paths have in common');
  const out = sent.reduce((a, s) => a + s.amountBase, 0n);
  console.log(`  Outbound moves: ${sent.length}, totalling ${client.fmt(out)}. Corpus ${client.fmt(corpusBase)}.`);
  console.log(`  Every one of them was request-gated: ${sent.filter((s) => s.kind === 'disburse').length} disbursements`
    + ` against an approved decision, ${sent.filter((s) => s.kind === 'refund').length} refund of a repayment surplus.`);
  console.log('  There is no third path out of this wallet. An unsolicited payment request');
  console.log('  sent TO the treasury is declined — funding is only ever pull, never push.\n');
  console.log('  And the engine that produced every decision above imports no SDK, no config');
  console.log('  and no clock (`test-solvency-truth-unit.mjs` asserts that structurally), so');
  console.log('  the whole trace is reproducible from the numbers alone.\n');
  return { sent: sent.length, corpusBase };
}

export default { runDemo };

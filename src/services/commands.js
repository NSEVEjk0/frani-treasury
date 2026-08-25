/**
 * frani-treasury — DM command router
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Every interaction with the treasury happens over an encrypted DM. This module
 * parses one inbound message and dispatches it:
 *
 *   Public (anyone):
 *     request <amount> [reason]  — ask for funding (grant ≤ grantMax, else loan)
 *     status                     — treasury solvency + your standing & limits
 *     history                    — your recent decisions
 *     terms | rules              — how grants, loans, tiers and caps work
 *     repay                      — how to repay a loan
 *     about                      — what this service is
 *     help                       — command list
 *
 *   Owner-only (authenticated by sender pubkey == OWNER_PUBKEY; disabled unless
 *   OWNER_PUBKEY is configured):
 *     pause | resume             — flip the live disburse switch
 *     params                     — dump the active policy knobs
 *     topup <amount>             — mint more UCT into the corpus
 *     forgive <loanId>           — write off a loan
 *     blacklist <pubkey> [on|off]— block / unblock an account
 *     unfreeze <pubkey>          — lift a freeze early
 *     admin                      — owner command list
 *
 * A leading `!` is optional on every command (`!request` == `request`). Money
 * amounts are parsed as decimals and converted to exact base units before they
 * ever touch the policy engine.
 */

import config from '../config.js';
import { createLogger } from '../logger.js';
import { normalizeKey } from '../state.js';
import reputation from '../reputation.js';
import treasury from '../treasury.js';
import { reply, recipientOfDm, sig } from '../reply.js';

const log = createLogger('commands');

const DAY_MS = 86_400_000;
const AMOUNT_RE = /^\d+(\.\d+)?$/;
const MAX_SANE_WHOLE = 1_000_000; // reject absurd asks before base-unit conversion

/** Is this DM from the configured owner identity? */
function isOwner(dm) {
  if (!config.admin.enabled) return false;
  return normalizeKey(dm.senderPubkey) === normalizeKey(config.admin.ownerPubkey);
}

function fmtDur(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

// ── shared status rendering (used by DM `status` and index.js `--status`) ─────
/**
 * Treasury-wide solvency + lifetime totals, as an array of lines. Async: reads
 * the live balance once.
 */
export async function treasuryStatusLines(client, state, now = Date.now()) {
  const s = state.stats;
  const balanceBase = await client.effectiveSpendableBase();
  const floorBase = client.toBase(config.treasury.minBalanceFloorWhole);
  const budgetBase = client.toBase(config.treasury.dailyBudgetWhole);
  const spentBase = state.disbursedInWindowBase(DAY_MS, now);
  const remainingBudget = budgetBase - spentBase > 0n ? budgetBase - spentBase : 0n;
  const disposable = balanceBase - floorBase > 0n ? balanceBase - floorBase : 0n;

  const activeLoans = state.allLoans().filter((l) => l.status === 'active' || l.status === 'overdue');
  const outstanding = activeLoans.reduce((a, l) => a + BigInt(l.outstandingBase ?? '0'), 0n);
  const overdue = activeLoans.filter((l) => l.status === 'overdue').length;

  const open = config.safety.disburseEnabled && !state.paused;
  return [
    `🏦 frani-treasury — status`,
    `Corpus balance : ${client.fmt(balanceBase)}`,
    `Reserve floor  : ${client.fmt(floorBase)} (never spent)`,
    `Disposable now : ${client.fmt(disposable)}`,
    `Daily budget   : ${client.fmt(remainingBudget)} left of ${client.fmt(budgetBase)} (rolling 24h)`,
    `Funding        : ${open ? 'OPEN ✅' : 'PAUSED ⏸️'}`,
    ``,
    `Lifetime: ${s.grantsCount} grant(s) · ${s.loansCount} loan(s) · repaid ${client.fmt(BigInt(s.totalRepaidBase))}`,
    `Granted ${client.fmt(BigInt(s.totalGrantedBase))} · loaned ${client.fmt(BigInt(s.totalLoanedBase))} · donations ${client.fmt(BigInt(s.donationsBase))}`,
    `Active loans: ${activeLoans.length} (${overdue} overdue) · outstanding ${client.fmt(outstanding)}`,
    `Decisions: ${s.approvals} approved · ${s.partials} partial · ${s.rejects} declined`,
  ];
}

/** The personal half of `status` for a specific requester. */
function personalStatusLines(client, state, dm, now = Date.now()) {
  const rec = state.getRequester(dm.senderPubkey);
  if (!rec) {
    return [
      ``,
      `👤 You: new here — welcome! Start with \`request 1 <reason>\` for an instant seed grant.`,
    ];
  }
  const prog = reputation.progress(rec);
  const decimals = client.coin.decimals;
  const creditLimit = reputation.creditLimitBaseFor(rec, decimals);
  const debt = state.outstandingDebtBase(rec.pubkey);
  const headroom = creditLimit - debt > 0n ? creditLimit - debt : 0n;
  const used = state.requestsIn24h(rec.pubkey, now);
  const limit = reputation.personalDailyLimit(rec, config, now);
  const cooldownMs = reputation.cooldownMsFor(rec);
  const sinceLast = rec.lastRequestAt ? now - rec.lastRequestAt : Infinity;
  const cdLeft = Number.isFinite(sinceLast) && sinceLast < cooldownMs ? cooldownMs - sinceLast : 0;

  const lines = [
    ``,
    `👤 Your standing: ${prog.label}`,
    prog.nextTier
      ? `   ${prog.toNextOnTime} more on-time repayment(s) → ${reputation.describeTier(prog.nextTier)}`
      : `   Top tier reached — thank you for being a reliable partner.`,
    `   Loan credit limit : ${client.fmt(creditLimit)} · outstanding ${client.fmt(debt)} · headroom ${client.fmt(headroom)}`,
    `   Requests (24h)    : ${used}/${limit}`,
    `   Cooldown          : ${cdLeft > 0 ? `${fmtDur(cdLeft)} remaining` : 'ready ✅'}`,
    `   Repaid on time    : ${rec.onTimeRepayments} · late ${rec.lateRepayments}`,
  ];
  if (reputation.isFrozen(rec, now)) {
    lines.push(rec.blacklisted ? `   ⛔ Account blocked by the owner.` : `   ❄️ Frozen until ${fmtDur((rec.frozenUntil ?? now) - now)} from now (settle any debt to speed this up).`);
  }
  return lines;
}

// ── public command handlers ───────────────────────────────────────────────────
async function cmdStatus(client, state, rateLimit, dm) {
  const now = Date.now();
  const lines = await treasuryStatusLines(client, state, now);
  lines.push(...personalStatusLines(client, state, dm, now));
  lines.push(``, sig());
  await reply(client, recipientOfDm(dm), rateLimit, lines.join('\n'), { priority: true });
}

async function cmdHistory(client, state, rateLimit, dm) {
  const entries = state.recentLedgerFor(dm.senderPubkey, 8);
  const lines = [`📜 Your recent activity:`];
  if (!entries.length) {
    lines.push(`   (nothing yet — send \`request 1 <reason>\` to get started)`);
  } else {
    for (const e of entries) {
      const when = new Date(e.at).toISOString().slice(0, 16).replace('T', ' ');
      if (e.type === 'repayment') lines.push(`   ${when}  repaid ${client.fmt(BigInt(e.amountBase))} (${e.cleared} loan[s] cleared)`);
      else if (e.type === 'donation') lines.push(`   ${when}  donated ${client.fmt(BigInt(e.amountBase))}`);
      else {
        const tag = e.decision === 'reject' ? `declined (${e.code})` : `${e.decision} ${e.kind ?? ''} ${client.fmt(BigInt(e.amountBase ?? '0'))}`;
        const note = e.unconfirmed ? ' — unconfirmed, check your wallet' : '';
        lines.push(`   ${when}  requested ${client.fmt(BigInt(e.requestedBase ?? '0'))} → ${tag}${note}`);
      }
    }
  }
  lines.push(sig());
  await reply(client, recipientOfDm(dm), rateLimit, lines.join('\n'), { priority: true });
}

async function cmdTerms(client, state, rateLimit, dm) {
  const t = config.treasury;
  const body = [
    `📜 How frani-treasury funds you — the rules, in full:`,
    ``,
    `TIER 1 · SEED GRANT (≤ ${t.grantMaxWhole} UCT)`,
    `  Instant, no repayment, no debt. For onboarding, gas and quick tests.`,
    ``,
    `TIER 2 · MICRO-LOAN (> ${t.grantMaxWhole} UCT)`,
    `  Repayable within ${t.loanTermDays} days. Repay by sending the UCT back to me;`,
    `  I match it to your oldest loan automatically. Grants are paused while you`,
    `  carry a loan, so clear it to unlock instant grants again.`,
    ``,
    `REPUTATION LADDER (earned by on-time repayment)`,
    `  Newbie 🌱  loan ceiling ${t.tiers.newbie.maxLoanWhole} UCT · cooldown ${t.tiers.newbie.cooldownMin}m`,
    `  Trusted ⭐ loan ceiling ${t.tiers.trusted.maxLoanWhole} UCT · cooldown ${t.tiers.trusted.cooldownMin}m  (after ${t.tiers.trusted.promoteAtOnTime} on-time)`,
    `  Partner 👑 loan ceiling ${t.tiers.partner.maxLoanWhole} UCT · cooldown ${t.tiers.partner.cooldownMin}m  (after ${t.tiers.partner.promoteAtOnTime} on-time)`,
    `  Early repayment → a temporary boost to your daily request limit.`,
    `  Overdue → account frozen until settled.`,
    ``,
    `SAFETY RAILS (always on)`,
    `  Max single disbursement ${t.maxSingleWhole} UCT · rolling daily budget ${t.dailyBudgetWhole} UCT`,
    `  Reserve floor ${t.minBalanceFloorWhole} UCT is never spent · ${t.maxRequestsPer24h} requests/24h per account.`,
    ``,
    sig(),
  ].join('\n');
  await reply(client, recipientOfDm(dm), rateLimit, body, { priority: true });
}

async function cmdRepay(client, state, rateLimit, dm) {
  const debt = state.outstandingDebtBase(dm.senderPubkey);
  const lines = [
    `💸 Repaying a loan is simple: just send UCT back to me (@${config.nametag}).`,
    `I automatically match incoming transfers to your oldest outstanding loan (FIFO).`,
    `Overpayment beyond your total debt is refunded to you automatically.`,
  ];
  if (debt > 0n) lines.push(``, `Your current outstanding balance: ${client.fmt(debt)}.`);
  else lines.push(``, `You currently have no outstanding loans. 🎉`);
  lines.push(sig());
  await reply(client, recipientOfDm(dm), rateLimit, lines.join('\n'), { priority: true });
}

async function cmdAbout(client, state, rateLimit, dm) {
  const body = [
    `🏦 frani-treasury — an autonomous, rules-based UCT treasury on Unicity testnet2.`,
    ``,
    config.publish.serviceDescription,
    ``,
    `Owner / Creator: ${config.owner}. Made by ${config.brand}.`,
    `Send \`help\` for commands, \`terms\` for the funding rules, \`status\` for live figures.`,
    sig(),
  ].join('\n');
  await reply(client, recipientOfDm(dm), rateLimit, body, { priority: true });
}

async function cmdHelp(client, state, rateLimit, dm) {
  const lines = [
    `🤖 frani-treasury commands (the \`!\` prefix is optional):`,
    `  request <amount> [reason]  — ask for funding (e.g. \`request 1 gas for testing\`)`,
    `  status                     — treasury solvency + your standing & limits`,
    `  history                    — your recent requests & repayments`,
    `  terms                      — how grants, loans, tiers and caps work`,
    `  repay                      — how to repay a loan`,
    `  about                      — what this service is`,
    `  help                       — this message`,
  ];
  if (isOwner(dm)) lines.push(`  admin                      — owner commands`);
  lines.push(``, `Tip: small asks (≤ ${config.treasury.grantMaxWhole} UCT) are instant no-repayment grants.`, sig());
  await reply(client, recipientOfDm(dm), rateLimit, lines.join('\n'), { priority: true });
}

async function cmdRequest(client, state, rateLimit, dm, parts) {
  const recipient = recipientOfDm(dm);
  const amountStr = parts[1];
  const reason = parts.slice(2).join(' ');

  if (!amountStr || !AMOUNT_RE.test(amountStr) || Number.parseFloat(amountStr) <= 0) {
    await reply(client, recipient, rateLimit, [
      `❓ Usage: \`request <amount> [reason]\` — e.g. \`request 1 gas for testing\`.`,
      `Small asks (≤ ${config.treasury.grantMaxWhole} UCT) are instant grants; larger asks are repayable loans.`,
      sig(),
    ].join('\n'), { priority: true });
    return;
  }
  if (Number.parseFloat(amountStr) > MAX_SANE_WHOLE) {
    await reply(client, recipient, rateLimit, `😅 That's not a serious amount. The max single disbursement here is ${config.treasury.maxSingleWhole} UCT. ${sig()}`, { priority: true });
    return;
  }

  const requestedBase = client.toBase(amountStr);
  await treasury.handleFundingRequest(client, state, rateLimit, { dm, requestedBase, reason });
}

// ── owner-only command handlers ───────────────────────────────────────────────
async function cmdAdminHelp(client, state, rateLimit, dm) {
  const body = [
    `🔐 Owner commands:`,
    `  pause | resume            — stop / restart all disbursement immediately`,
    `  params                    — show the active policy knobs`,
    `  topup <amount>            — mint more UCT into the corpus`,
    `  forgive <loanId>          — write off a loan (zero its balance)`,
    `  blacklist <pubkey> [on|off]— block / unblock an account`,
    `  unfreeze <pubkey>         — lift a freeze early`,
    sig(),
  ].join('\n');
  await reply(client, recipientOfDm(dm), rateLimit, body, { priority: true });
}

async function cmdParams(client, state, rateLimit, dm) {
  const t = config.treasury;
  const sf = config.safety;
  const body = [
    `⚙️ Active policy:`,
    `  grantMax=${t.grantMaxWhole} · maxSingle=${t.maxSingleWhole} · dailyBudget=${t.dailyBudgetWhole} · floor=${t.minBalanceFloorWhole} (UCT)`,
    `  loanTermDays=${t.loanTermDays} · maxReq/24h=${t.maxRequestsPer24h} · overdueFreeze=${t.overdueFreezeHours}h`,
    `  tiers newbie/trusted/partner max=${t.tiers.newbie.maxLoanWhole}/${t.tiers.trusted.maxLoanWhole}/${t.tiers.partner.maxLoanWhole} UCT`,
    `  disburseEnabled=${sf.disburseEnabled} · paused=${state.paused} · dryRun=${sf.dryRun}`,
    `  maxDisb/h=${sf.maxDisbursementsPerHour} · selfMint=${sf.selfMintEnabled}(${sf.selfMintAmountWhole})`,
    sig(),
  ].join('\n');
  await reply(client, recipientOfDm(dm), rateLimit, body, { priority: true });
}

async function cmdPause(client, state, rateLimit, dm, on) {
  state.setPaused(on);
  state.save();
  log.warn(`Owner ${on ? 'PAUSED' : 'RESUMED'} disbursement.`);
  await reply(client, recipientOfDm(dm), rateLimit, `${on ? '⏸️ Disbursement paused.' : '▶️ Disbursement resumed.'} ${sig()}`, { priority: true });
}

async function cmdTopup(client, state, rateLimit, dm, parts) {
  const amountStr = parts[1];
  if (!amountStr || !AMOUNT_RE.test(amountStr) || Number.parseFloat(amountStr) <= 0) {
    await reply(client, recipientOfDm(dm), rateLimit, `Usage: \`topup <amount>\` — mints UCT into the corpus. ${sig()}`, { priority: true });
    return;
  }
  const res = await client.mint(amountStr);
  const ok = res?.success || res?.dryRun;
  await reply(client, recipientOfDm(dm), rateLimit, ok ? `✅ Top-up submitted: minted ${amountStr} ${client.coin.symbol} into the corpus. ${sig()}` : `⚠️ Top-up failed: ${res?.error ?? 'unknown error'}. ${sig()}`, { priority: true });
}

async function cmdForgive(client, state, rateLimit, dm, parts) {
  const id = parts[1];
  const loan = id ? state.forgiveLoan(id) : null;
  if (!loan) {
    await reply(client, recipientOfDm(dm), rateLimit, `Usage: \`forgive <loanId>\` — no active loan found for that id. ${sig()}`, { priority: true });
    return;
  }
  if (!state.hasOverdueLoan(loan.requester)) state.unfreeze(loan.requester);
  state.save();
  log.warn(`Owner forgave loan ${id} (${client.fmt(BigInt(loan.principalBase))}).`);
  await reply(client, recipientOfDm(dm), rateLimit, `✅ Loan ${String(id).slice(0, 8)} forgiven and written off. ${sig()}`, { priority: true });
}

async function cmdBlacklist(client, state, rateLimit, dm, parts) {
  const target = parts[1];
  const on = !/^(off|false|0|no)$/i.test(parts[2] ?? 'on');
  if (!target) {
    await reply(client, recipientOfDm(dm), rateLimit, `Usage: \`blacklist <pubkey> [on|off]\`. ${sig()}`, { priority: true });
    return;
  }
  state.setBlacklist(target, on);
  state.save();
  log.warn(`Owner ${on ? 'blacklisted' : 'un-blacklisted'} ${String(target).slice(0, 16)}.`);
  await reply(client, recipientOfDm(dm), rateLimit, `✅ ${String(target).slice(0, 12)}… ${on ? 'blacklisted' : 'un-blacklisted'}. ${sig()}`, { priority: true });
}

async function cmdUnfreeze(client, state, rateLimit, dm, parts) {
  const target = parts[1];
  if (!target) {
    await reply(client, recipientOfDm(dm), rateLimit, `Usage: \`unfreeze <pubkey>\`. ${sig()}`, { priority: true });
    return;
  }
  state.unfreeze(target);
  state.save();
  log.warn(`Owner unfroze ${String(target).slice(0, 16)}.`);
  await reply(client, recipientOfDm(dm), rateLimit, `✅ ${String(target).slice(0, 12)}… unfrozen. ${sig()}`, { priority: true });
}

// ── dispatch ────────────────────────────────────────────────────────────────
const OWNER_COMMANDS = new Set(['admin', 'params', 'pause', 'resume', 'topup', 'forgive', 'blacklist', 'unfreeze']);

/**
 * Parse and handle one inbound DM. Callers (agent.js) must have already
 * de-duplicated the message id, so this runs at most once per message.
 */
export async function handleDm(client, state, rateLimit, dm) {
  const raw = String(dm.content ?? '').trim();
  if (!raw) return;

  const parts = raw.replace(/^!/, '').trim().split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase();
  const recipient = recipientOfDm(dm);
  log.info(`DM from ${recipient}: ${cmd || '(empty)'}${parts.length > 1 ? ' …' : ''}`);

  // Owner-only surface.
  if (OWNER_COMMANDS.has(cmd)) {
    if (!isOwner(dm)) {
      // Don't reveal the admin surface to non-owners; treat as unknown.
      await reply(client, recipient, rateLimit, `❓ Unknown command. Send \`help\` for what I can do. ${sig()}`);
      return;
    }
    switch (cmd) {
      case 'admin': return cmdAdminHelp(client, state, rateLimit, dm);
      case 'params': return cmdParams(client, state, rateLimit, dm);
      case 'pause': return cmdPause(client, state, rateLimit, dm, true);
      case 'resume': return cmdPause(client, state, rateLimit, dm, false);
      case 'topup': return cmdTopup(client, state, rateLimit, dm, parts);
      case 'forgive': return cmdForgive(client, state, rateLimit, dm, parts);
      case 'blacklist': return cmdBlacklist(client, state, rateLimit, dm, parts);
      case 'unfreeze': return cmdUnfreeze(client, state, rateLimit, dm, parts);
    }
  }

  // Public surface.
  switch (cmd) {
    case 'request':
    case 'fund':
    case 'req':
      return cmdRequest(client, state, rateLimit, dm, parts);
    case 'status':
    case 'balance':
      return cmdStatus(client, state, rateLimit, dm);
    case 'history':
    case 'log':
      return cmdHistory(client, state, rateLimit, dm);
    case 'terms':
    case 'rules':
      return cmdTerms(client, state, rateLimit, dm);
    case 'repay':
    case 'repayment':
      return cmdRepay(client, state, rateLimit, dm);
    case 'about':
    case 'intent':
      return cmdAbout(client, state, rateLimit, dm);
    case 'help':
    case 'commands':
    case 'start':
    case 'hi':
    case 'hello':
      return cmdHelp(client, state, rateLimit, dm);
    default:
      // Gentle nudge, but rate-limited so a chatty peer can't make us loop.
      await reply(client, recipient, rateLimit, `👋 I'm frani-treasury. Send \`help\` for commands, or \`request 1 <reason>\` for an instant seed grant. ${sig()}`);
      return;
  }
}

export default { handleDm, treasuryStatusLines };

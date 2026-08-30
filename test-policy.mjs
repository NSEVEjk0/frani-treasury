// Offline unit test of the pure policy engine (no network). Gitignored.
import policy from './src/policy.js';

const D = 18n;
const UCT = 10n ** D;
const u = (whole) => {
  const [i, f = ''] = String(whole).split('.');
  return BigInt(i) * UCT + BigInt((f + '0'.repeat(18)).slice(0, 18));
};
const fmt = (b) => `${b / UCT}.${(b % UCT).toString().padStart(18, '0').replace(/0+$/, '') || '0'} UCT`;

// A healthy baseline context: 300 UCT corpus, floor 25, budget 25/day, nothing spent.
const base = () => ({
  balanceBase: u(300), floorBase: u(25),
  dailyBudgetBase: u(25), dailySpentBase: 0n,
  maxSingleBase: u(10), grantMaxBase: u(1),
  outstandingDebtBase: 0n, creditLimitBase: u(2), // newbie ceiling
  cooldownMs: 3600000, lastRequestAt: 0, requestsIn24h: 0, dailyRequestLimit: 5,
  frozen: false, blacklisted: false, hasOverdue: false,
  disburseEnabled: true, paused: false, fmt,
});
const now = 1_000_000_000_000;
const ask = (whole, ctx) => policy.evaluate({ requestedBase: u(whole), nowMs: now }, ctx);

let pass = 0, fail = 0;
function check(label, decision, { d, kind, amt, code }) {
  const okD = decision.decision === d;
  const okK = kind === undefined || decision.kind === kind;
  const okA = amt === undefined || decision.amountBase === u(amt);
  const okC = code === undefined || decision.code === code;
  const ok = okD && okK && okA && okC;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`      → ${decision.decision}${decision.kind ? `/${decision.kind}` : ''} ${fmt(decision.amountBase)} [${decision.code}]`);
  if (!ok) console.log(`      ✗ expected d=${d} kind=${kind} amt=${amt} code=${code}`);
}

// 1) Newbie, healthy corpus, asks 1 → instant GRANT.
check('newbie asks 1 → grant/approve 1', ask('1', base()), { d: 'approve', kind: 'grant', amt: '1', code: 'approved' });

// 2) Newbie asks 5 → LOAN clamped to their 2 UCT ceiling → partial.
check('newbie asks 5 → loan/partial clamped to 2', ask('5', base()), { d: 'partial', kind: 'loan', amt: '2', code: 'partial' });

// 3) Partner (ceiling 10) asks 8 → LOAN approve 8.
{
  const ctx = base(); ctx.creditLimitBase = u(10);
  check('partner asks 8 → loan/approve 8', ask('8', ctx), { d: 'approve', kind: 'loan', amt: '8', code: 'approved' });
}

// 4) Asks 0 → reject invalid-amount.
check('asks 0 → reject invalid', ask('0', base()), { d: 'reject', code: 'invalid-amount' });

// 5) Cooldown active → reject cooldown.
{
  const ctx = base(); ctx.lastRequestAt = now - 60_000; // 1 min ago, need 60 min
  check('within cooldown → reject cooldown', ask('1', ctx), { d: 'reject', code: 'cooldown' });
}

// 6) Reserve floor binding: balance only 25.5, floor 25 → grant clamped to 0.5 (partial).
{
  const ctx = base(); ctx.balanceBase = u('25.5');
  check('near floor asks 1 → partial 0.5 (reserve-floor)', ask('1', ctx), { d: 'partial', kind: 'grant', amt: '0.5' });
}

// 7) Daily budget exhausted → reject daily-budget.
{
  const ctx = base(); ctx.dailySpentBase = u(25);
  check('budget spent asks 1 → reject daily-budget', ask('1', ctx), { d: 'reject', code: 'daily-budget' });
}

// 8) Has overdue → reject overdue (hard gate before amount math).
{
  const ctx = base(); ctx.hasOverdue = true;
  check('overdue asks 1 → reject overdue', ask('1', ctx), { d: 'reject', code: 'overdue' });
}

// 9) Blacklisted → reject blacklisted.
{
  const ctx = base(); ctx.blacklisted = true;
  check('blacklisted asks 1 → reject blacklisted', ask('1', ctx), { d: 'reject', code: 'blacklisted' });
}

// 10) Debt-free rule: has 1 UCT debt, asks 1 → NOT a grant (debt outstanding) → loan within headroom.
{
  const ctx = base(); ctx.outstandingDebtBase = u(1); ctx.creditLimitBase = u(2);
  check('has debt asks 1 → loan/approve 1 (no grant while indebted)', ask('1', ctx), { d: 'approve', kind: 'loan', amt: '1' });
}

// 11) Paused → reject paused.
{
  const ctx = base(); ctx.paused = true;
  check('paused asks 1 → reject paused', ask('1', ctx), { d: 'reject', code: 'paused' });
}

// 12) Credit limit reached: debt == ceiling, asks 1 → reject credit-limit.
{
  const ctx = base(); ctx.outstandingDebtBase = u(2); ctx.creditLimitBase = u(2);
  check('debt at ceiling asks 1 → reject credit-limit', ask('1', ctx), { d: 'reject', code: 'credit-limit' });
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ' ✅'}`);
process.exit(fail ? 1 : 0);

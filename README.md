# frani-treasury

An autonomous lending and grants agent on Unicity **testnet2**. DM it and ask for
UCT. It decides under published rules — no human approves anything — and it shows
you the ordered list of checks it walked to reach the answer.

```
  decision REJECT · code overdue · amount 0 UCT
    ✓ enabled              disbursement enabled
    ✓ valid-amount         requested=1 UCT
    ✗ has-overdue          overdue loan outstanding
```

That trace is what the requester gets, not just what the operator logs.

**Live as `@frani-treasury`**, corpus 250 UCT, funding open.
Address: `DIRECT://000043589af1ee69a89fc49ef54326d87b4477dd2d50c7a67bf60149212b42aa529381243fc1`
Pubkey: `02ba06382aaab28c9e7b2cfcea86ff48a0ada5fecd2fe88ca0140eba832ff09209`

---

## Track

**Autonomous agents**

## Is it Agentic?

**Yes.** It evaluates requests, disburses UCT, sweeps for overdue loans, freezes and
unfreezes accounts, matches repayments and promotes reputations entirely on its own.
A human sets the limits in `.env` once and starts it.

## Runs on AstridOS?

**No** — a Node.js daemon under `systemd` on Linux.

## SDK features used

| Sphere SDK feature | How it's used here |
|---|---|
| `payments.send` | disbursing an approved grant or loan, and refunding an overpayment |
| `payments.assets` | live corpus reads, gating every payout against the reserve floor |
| `payments.requests` | an unsolicited request *to* the treasury is declined automatically |
| Direct Messages | the whole interface: request in, decision + trace out, receipts |
| Nametags | `@frani-treasury` |
| `mintFungibleToken` | one-time capped self-mint to seed the corpus (testnet2 has no faucet) |

---

## What makes it different

**The brain has no hands.** `src/policy.js` is 188 lines and cannot do anything — it
cannot read a balance, look at the clock, save state or send UCT. Its whole import
list is one line:

```js
import { bigMax } from './money.js';
```

Numbers in, `{decision, kind, amountBase, code, reason, checks[]}` out. `treasury.js`
resolves the live balance, the rolling 24h spend and the requester's tier into a flat
object of BigInts, then only *asks* the pure function what to do. Three things follow:

- **the decline is auditable by the person receiving it** — which of eleven named
  gates closed, and the two numbers that closed it;
- **the money rails check the rules again, independently** — the reserve floor is
  enforced in `policy.js` and re-enforced inside `sphere-client._send()` against a
  freshly-read balance, so a bug in the decision cannot spend the reserve;
- **the engine is testable with no wallet at all.**

**Standing is derived, never asserted.** You don't tell it who you are; it works out
what you're worth from repayments it actually received. Repaying isn't a command —
just send the UCT back, and it's matched FIFO against your oldest loan.

| Tier | Loan ceiling | Cooldown | Reached by |
|---|---|---|---|
| Newbie 🌱 | 2 UCT | 60 min | everyone starts here |
| Trusted ⭐ | 5 UCT | 30 min | 2 on-time repayments |
| Partner 👑 | 10 UCT | 15 min | 5 on-time repayments |

Ask for 4 UCT as a Newbie and you're approved for 2 **and told the ceiling was the
binding constraint**. Requests of ≤ 1 UCT are seed grants with no debt tracked at all.

---

## Try it without a wallet

```bash
npm install && npm run demo
```

Runs the real `policy.js`, the real reputation ladder and the real lifecycle against a
**fake wallet** — no socket, no wallet file, safe while the daemon is up.

- **Happy path** — a new key takes a seed grant, then a loan clamped to its Newbie
  ceiling, repays on time twice, is promoted to Trusted, and re-issues the exact
  request that was clamped at the start. Approved in full this time.
- **Failure path** — a second key borrows and goes quiet. The sweep marks the loan
  overdue and freezes the account; the next request is declined with the ordered trace
  stopping at `has-overdue`. They settle slightly over, the refund fails, and the reply
  says so rather than promising money that never left.

---

## Commands

DM `@frani-treasury`. A leading `!` is optional.

```
request <amount> [reason]   ask for funding — the only way money moves
status                      treasury solvency + your tier, headroom and cooldown
history                     your requests, decisions and repayments
terms · repay · about · help
```

Owner-only, and **absent entirely** unless `OWNER_PUBKEY` is set (non-owners get
"unknown command", so the surface is never revealed):

```
pause · resume · params · admin · topup <amount>
forgive <loanId> · blacklist <pubkey> [on|off] · unfreeze <pubkey>
```

## Run it

```bash
npm install
cp .env.example .env      # optional — every value has a safe default

npm run doctor            # connectivity + config self-check
npm run status            # the live treasury report
npm run demo              # offline walk-through (safe while running)
npm start                 # the autonomous daemon
npm test                  # 86 assertions, three offline suites
```

Node ≥ 22. First launch generates a BIP39 identity, claims the nametag and performs a
one-time capped self-mint. The phrase prints once and lands in `wallet-data/`
(gitignored, 0600) — back it up, or set `WALLET_PASSWORD` to encrypt it at rest.

> Don't run `whoami`/`doctor`/`status` while the service is up — each opens a second
> connection on the same wallet. Use `journalctl -u frani-treasury` or the DM `status`.
> `npm run demo` is the exception.

Deploy with the shipped unit: `sudo cp frani-treasury.service /etc/systemd/system/ &&
sudo systemctl enable --now frani-treasury`.

## Configuration

Every knob has a conservative default, so an absent `.env` still runs a valid, timid
treasury. Full list in [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `GRANT_MAX_UCT` | `1` | ≤ this is a no-repayment grant; above it, a loan |
| `LOAN_TERM_DAYS` | `7` | repayment window before a loan goes overdue |
| `MAX_SINGLE_UCT` | `10` | ceiling on any one disbursement |
| `DAILY_BUDGET_UCT` | `25` | rolling 24h outflow across all requesters |
| `MIN_BALANCE_FLOOR_UCT` | `25` | untouchable reserve, enforced twice |
| `OWNER_PUBKEY` | *(empty)* | empty = the admin surface does not exist |
| `DISBURSE_ENABLED` | `true` | `false` = evaluate and reply, move nothing |

## Structure

```
src/
  policy.js         THE PURE ENGINE — numbers in, decision + ordered trace out
  reputation.js     the tier ladder, side-effect free
  money.js          exact BigInt base-unit math
  treasury.js       buildContext → evaluate → disburse → record → reply; the sweep
  state.js          crash-safe ledger: requesters, loans, idempotency rings
  sphere-client.js  SDK wiring + the two guarded outflow paths
  agent.js          the loop: events, polling, the periodic loan sweep
  demo.js           the offline walk-through
  services/         commands.js (DM router) · delivery.js (market intent)
```

State is written temp-file-plus-rename. Every inbound DM id and transfer id is
de-duplicated and persisted *before* it is acted on, so a relay replay cannot fund the
same request twice.

## Tests

```bash
npm test   # 86 assertions across three offline suites — no network, no wallet
```

| Suite | What it pins |
|---|---|
| `test-solvency-truth-unit.mjs` | 35 assertions, **9 fail without the fix**: `payments.assets()` resolves `[]` when the wallet-api is unreachable, so at the call site an outage and an empty corpus are identical. Reading one as the other declines a solvent treasury and would re-fire the bootstrap mint. Also asserts `policy.js`'s purity structurally. |
| `test-forgive-notify-unit.mjs` | 39 assertions. A terminal change always reaches the counterparty: `forgive` tells the *borrower*, and a refund is reported as made only when it went out. |
| `test-policy.mjs` | all 12 decision paths: budgets, caps, cooldown, headroom, reputation, blacklist, pause, reserve floor. |

Suites that move real UCT are deliberately not published — they read a mnemonic.

## Verified on-network

2 grants and 1 loan disbursed for real UCT, the loan repaid in full (0 outstanding),
plus 1 partial fund and 1 policy rejection — the approve → disburse → repay lifecycle
*and* the decline path.

---

Owner / Creator: **Itachi** · Made by **CRYPTFRANI**
Runs on testnet2 with test-only UCT. Not financial software; provided as-is.
MIT — see [LICENSE](LICENSE).

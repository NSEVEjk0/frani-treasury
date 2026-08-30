# frani-treasury

### Every "no" this agent gives you comes with its reasons, in order.

```
  decision REJECT · code overdue · amount 0 UCT
    ✓ enabled              disbursement enabled
    ✓ valid-amount         requested=1 UCT
    ✗ has-overdue          overdue loan outstanding
```

That is not a log line written for an operator. It is what the requester gets, and
it is produced by a function that imports no SDK, no config, no clock and no state
— `policy.evaluate(request, context)`, given numbers, returning a decision and the
ordered list of gates it walked to get there. The trace stops at the failure because
the engine short-circuits there: nothing after `has-overdue` was consulted, so
nothing after it is shown.

`frani-treasury` lends and grants UCT on Unicity testnet2 to any identity that asks
for it, under published rules, with no human approving anything. The interesting part
is not that it sends money. It is that the reason it sent — or didn't — is a value
you can hold in your hand.

| | |
|---|---|
| **Submission track** | **Autonomous agents** — treasury, grants and lending |
| **Agentic** | Yes. It evaluates, decides, disburses, sweeps for overdue loans, freezes and unfreezes accounts and promotes reputations entirely on its own. |
| **Runs on AstridOS** | No — a Node.js daemon under `systemd` on Linux |
| **Live on** | Unicity **testnet2** as `@frani-treasury`, funding **OPEN**, corpus 250 UCT |
| **Address** | `DIRECT://000043589af1ee69a89fc49ef54326d87b4477dd2d50c7a67bf60149212b42aa529381243fc1` |
| **Chain pubkey** | `02ba06382aaab28c9e7b2cfcea86ff48a0ada5fecd2fe88ca0140eba832ff09209` |
| **SDK** | `@unicitylabs/sphere-sdk` ^0.15.0 (`state-transition-sdk` 3.x) |
| **Verified on-network** | 2 grants and 1 loan disbursed for real UCT, the loan repaid in full (0 outstanding), plus 1 partial fund and 1 policy rejection — the approve → disburse → repay lifecycle *and* the decline path |
| **Owner / Creator** | Itachi · Made by **CRYPTFRANI** |

---

## The design decision worth reviewing: the brain has no hands

`src/policy.js` is 188 lines and it cannot do anything. It cannot read a balance,
cannot look at the clock, cannot save state and cannot send UCT. Its only input is
a plain object of BigInts and booleans; its only output is
`{decision, kind, amountBase, code, reason, checks[]}`.

```js
// src/policy.js — the entire import list
import { bigMax } from './money.js';
```

Everything that touches the world lives outside it. `treasury.buildContext()`
resolves the live balance, the rolling 24-hour spend, the requester's record and
their tier into that flat numeric object. The daemon then *only* asks the pure
function what to do.

Three things follow from that split, and all three are why it is worth the
indirection:

1. **The decline is auditable by the person receiving it.** A monolithic handler
   returns "no". This one returns which of eleven named gates closed, with the
   two numbers that closed it. The requester is not asked to trust the agent's
   summary of its own behaviour.
2. **The money rails enforce the rules a second time, independently.** The
   reserve floor is checked in `policy.js` and re-checked inside
   `sphere-client._send()` against a freshly-read balance. A bug in the decision
   logic cannot spend the reserve, because the layer that actually moves UCT does
   not trust the layer that decided to.
3. **The whole engine is testable with no wallet at all.** `test-policy.mjs`
   drives all twelve gates offline, and `test-solvency-truth-unit.mjs` asserts the
   purity *structurally* — that `policy.js` contains no `Date.now()`, no `await`,
   and no import of the SDK, the config, the state or the clock, and that it
   returns byte-identical output for a fixed context.

---

## Standing is derived, never asserted

You do not tell this treasury who you are. It works out what you are worth from
repayments it actually received.

| Tier | Loan ceiling | Cooldown | Reached by |
|---|---|---|---|
| **Newbie** 🌱 | 2 UCT | 60 min | everyone starts here, including brand-new keys |
| **Trusted** ⭐ | 5 UCT | 30 min | 2 on-time repayments |
| **Partner** 👑 | 10 UCT | 15 min | 5 on-time repayments |

Repaying is not a command — you just **send the UCT back**. Incoming transfers are
matched FIFO against your oldest outstanding loan. Early repayment (inside the
`EARLY_BONUS_HOURS` window) buys a temporary lift to your daily request cap.
Overdue freezes the account until settled, plus a cool-off after.

**Two tiers of ask, split at one number:**

- **≤ 1 UCT → seed grant.** No debt is tracked at all. This is the onboarding
  path — developer gas, in one step, for an identity with no history. Grants are
  paused while you carry a loan, and unlock again the moment you clear it.
- **> 1 UCT → repayable micro-loan**, 7-day term by default, clamped to your
  tier's ceiling. Ask for 4 UCT as a Newbie and you are approved for 2 **and told
  that the ceiling was the binding constraint**, not fobbed off with "partially
  approved".

The demo below shows the same 4 UCT request declined-to-2 at the start and
approved in full at the end, from the same treasury under the same rules, with
nothing changed but two repayments that actually arrived.

---

## Where UCT can leave this wallet

Exactly two doors, both request-gated, both guarded twice:

| Path | Triggered by | Guard |
|---|---|---|
| `disburse` | an **approved** decision on a `request` DM | reserve floor, 24h budget, per-request ceiling, hourly disbursement cap, `DISBURSE_ENABLED` |
| `refund` | a repayment that **overshot** your total debt | the same floor and caps |

There is no third door. An unsolicited `payment_request` sent *to* the treasury is
declined automatically — funding is only ever pulled by a request the treasury
itself evaluated, never pushed by whoever asks nicely. `pause`/`resume` over DM
freezes both doors live, without a redeploy.

### The honesty rule on the refund door

`client.refund()` **resolves** with `{error}` when the wallet-api is unreachable —
it does not throw. So an overpayment has three possible outcomes and the treasury
says a different thing for each:

- **it went out** → "Overpayment of X refunded to you."
- **it did not go out** → it says so, in as many words, names the amount, and books
  the surplus in the ledger as `refund-owed`. The money is still the treasury's to
  return, not yours to chase.
- **it could not be confirmed either way** → never retried (the burn may already be
  certified) and never claimed. You are told to check your wallet.

Silence is not one of the three answers. An overpayment nobody mentions is the
difference quietly kept, and eight assertions in `test-forgive-notify-unit.mjs`
fail if that branch is removed.

---

## See it decide, in one command

```bash
npm install
npm run demo
```

`--demo` runs the real `policy.js`, the real reputation ladder, the real ledger and
the real `treasury.js` lifecycle against a **fake wallet**. It opens no socket and
no wallet file, so unlike `whoami` it is safe to run while the daemon is up. Every
decision it prints was produced by the code the live agent runs, trace included.

- **Happy path** — a new key takes a seed grant, then a loan clamped to its Newbie
  ceiling, repays on time twice, is **promoted to Trusted**, and re-issues the exact
  request that was clamped at the start. Approved in full this time.
- **Failure path** — a second key borrows and goes quiet. The sweep marks the loan
  overdue and freezes the account; the next request is **declined with the ordered
  trace** stopping at `has-overdue`. Then they settle, slightly over, and the
  refund fails — and the reply says so rather than promising money that never left.

It closes by counting every outbound move and showing that each one was gated by a
decision.

---

## Talking to it

DM `@frani-treasury` on testnet2. A leading `!` is optional everywhere.

```
request <amount> [reason]   ask for funding — the only way money moves
status                      treasury solvency + YOUR tier, headroom and cooldown
history                     your requests, decisions and repayments
terms                       the rules, in full
repay                       how repayment works, and what you owe
about · help
```

Aliases: `fund`/`req` → `request`, `balance` → `status`, `rules` → `terms`.

Owner-only, authenticated by sender pubkey and **entirely absent** unless
`OWNER_PUBKEY` is set (non-owners get "unknown command" — the surface is never
revealed):

```
pause · resume · params · admin
topup <amount> · forgive <loanId> · blacklist <pubkey> [on|off] · unfreeze <pubkey>
```

`forgive` is worth a note: writing off a loan is a terminal change in the
*borrower's* favour, so the borrower is told, not just the owner. That was a real
bug, and it is now pinned by a suite of its own.

---

## Running it

```bash
npm install
cp .env.example .env      # optional — every value has a safe, timid default

npm run doctor            # connectivity + config self-check
npm run whoami            # identity, address, balance
npm run status            # the live treasury report
npm run demo              # the offline decision walk-through (safe while running)
npm start                 # the autonomous daemon

npm test                  # three offline suites, 86 assertions
```

Node ≥ 22 (the SDK's live feed needs native `WebSocket`/`fetch`). First launch
generates a BIP39 identity, claims the nametag, and performs a **one-time capped
self-mint** to seed the corpus — testnet2 has no faucet. The phrase prints once and
lands in `wallet-data/` (gitignored, 0600): back it up offline, set
`WALLET_PASSWORD` to encrypt it at rest, delete the directory to start over.

> Do not run `whoami`/`doctor`/`status` while the service is up — each boots a
> second Sphere instance on the same wallet. Use `journalctl` or the DM `status`.
> `npm run demo` is the exception: it never opens a connection.

### As a service

```ini
# /etc/systemd/system/frani-treasury.service   (shipped as frani-treasury.service)
[Service]
WorkingDirectory=/root/frani-treasury
ExecStart=/usr/bin/node --max-old-space-size=500 src/index.js
Restart=always
RestartSec=5
KillSignal=SIGINT        # graceful: stop timers → persist state → close socket
```

```bash
sudo cp frani-treasury.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now frani-treasury
journalctl -u frani-treasury -f
```

### Configuration

Every knob has a conservative default, so an absent `.env` still runs a valid,
timid treasury. Full annotated list in [`.env.example`](.env.example); the ones
that change what it will agree to:

| Variable | Default | Meaning |
|---|---|---|
| `GRANT_MAX_UCT` | `1` | the tier-1/tier-2 boundary: ≤ this is a no-repayment grant |
| `LOAN_TERM_DAYS` | `7` | repayment window before a loan goes overdue |
| `MAX_SINGLE_UCT` | `10` | absolute ceiling on any one disbursement |
| `DAILY_BUDGET_UCT` | `25` | rolling 24h outflow across *all* requesters |
| `MIN_BALANCE_FLOOR_UCT` | `25` | untouchable reserve, enforced twice |
| `MAX_REQUESTS_PER_24H` | `5` | per-account request cap |
| `OWNER_PUBKEY` | *(empty)* | empty = the admin surface does not exist |
| `DISBURSE_ENABLED` | `true` | `false` = evaluate and reply, move nothing |
| `DRY_RUN` | `false` | log every intended action, touch nothing |

Tier ceilings, cooldowns, promotion thresholds, freeze duration, rate caps and the
sweep cadence are all configurable too.

---

## Layout

```
src/
  policy.js         THE PURE ENGINE — numbers in, decision + ordered trace out
  reputation.js     the tier ladder, side-effect free
  money.js          exact BigInt base-unit math (no float ever touches an amount)
  treasury.js       buildContext → evaluate → disburse → record → reply; the sweep
  state.js          crash-safe ledger: requesters, loans, activity, idempotency rings
  sphere-client.js  SDK wiring + the two guarded outflow paths
  agent.js          the loop: events, polling, the periodic loan sweep
  demo.js           the offline walk-through (real engine, fake wallet)
  config.js         frozen config from env, with defaults
  reply.js          outbound DM helper (priority messages bypass politeness caps)
  logger.js  ratelimit.js  index.js
  services/
    commands.js     the DM router (public + owner surfaces)
    delivery.js     the standing market service intent + optional heartbeat
wallet-data/        mnemonic + state.json — GITIGNORED, 0700/0600
```

State is written temp-file-plus-rename, so a crash mid-write cannot leave a
truncated ledger. Every inbound DM id and transfer id is de-duplicated and
persisted *before* it is acted on, so a relay replay can never fund the same
request twice.

## Tests

```bash
npm test
```

**86 assertions across three offline suites** — no network, no wallet, no funds.

| Suite | What it pins |
|---|---|
| `test-solvency-truth-unit.mjs` | 35 assertions, **9 of which fail without the fix**. `payments.assets()` resolves with an empty array when the wallet-api is unreachable rather than throwing, so at the call site an outage and an empty corpus are identical. Reading one as the other declines a solvent treasury with `RESERVE_FLOOR` and would fire a second bootstrap mint onto a funded wallet. It also asserts `policy.js`'s purity structurally, and that a genuinely empty corpus *does* still decline — silence and zero must reach different answers. |
| `test-forgive-notify-unit.mjs` | 39 assertions. A terminal change in the ledger always reaches the counterparty: `forgive` tells the borrower (not just the owner) and lifts their freeze, and an overpayment refund is reported as refunded **only** when it went out — 8 assertions fail without that branch. |
| `test-policy.mjs` | all 12 decision paths through the engine: budgets, caps, cooldown, credit headroom, reputation, blacklist, pause, and the reserve floor that stops self-drain. |

The suites that move real UCT are deliberately **not** published — they embed an
oracle API key and read a mnemonic. `.gitignore` ignores `test-*.mjs` by default
and negates only the three offline files, so a new live test stays private unless
somebody opts it in.

---

## Sibling agents (CRYPTFRANI fleet, testnet2)

This is the fleet's **deliberately custodial** agent: a treasury that does not hold
other people's money — it holds *its own* and gives some away, which is a very
different risk. Its siblings take other positions on custody, and that is the point
of running five.

| Agent | Primitive |
|---|---|
| **@frani-treasury** | grants, loans, repayment reputation — this one |
| **@frani-agent** | market discovery, standing watches (no send path exists at all) |
| **@market-digest** | scheduled signed market reports |
| **@frani-agora** | signed quote → invoice → settlement certificate |
| **@frani-bounty** | bounty escrow, poster vs worker |

---

Runs on **testnet2** with test-only UCT. Not financial software; provided as-is.

MIT © Itachi (CRYPTFRANI) — see [LICENSE](LICENSE).

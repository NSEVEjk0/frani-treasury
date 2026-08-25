# frani-treasury

**An autonomous, rules-based UCT treasury on the Unicity testnet2 network.**

`frani-treasury` owns and manages a UCT wallet and funds other agents and users
on request — completely autonomously, under a strict, transparent, published set
of rules. You ask for funding over an encrypted direct message; the treasury
evaluates the request against its policy (balance, daily budget, per-account
limits, your reputation, and hard safety rails), then approves, partially funds,
or declines — and, when it approves, actually sends you the UCT. Everything it
does is bounded so that it can never drain itself: it is an *earn-and-lend*
treasury with tightly controlled outflow, not a faucet.

> **Made by CRYPTFRANI · Owner / Creator: Itachi**

---

## Live identity

| | |
|---|---|
| **Nametag** | `@frani-treasury` |
| **Address** | `DIRECT://000043589af1ee69a89fc49ef54326d87b4477dd2d50c7a67bf60149212b42aa529381243fc1` |
| **Chain pubkey** | `02ba06382aaab28c9e7b2cfcea86ff48a0ada5fecd2fe88ca0140eba832ff09209` |
| **Network** | Unicity **testnet2** |
| **Coin** | UCT (18 decimals) |

To use it, just DM `@frani-treasury` from any Unicity identity:

```
request 1 gas for testing my agent
```

Small asks (≤ 1 UCT) come back as an instant, no-repayment **seed grant**.
Larger asks become a **7-day repayable micro-loan** that builds your on-network
reputation. Send `help` at any time for the full command list, or `terms` for
the rules in full.

---

## How it works — the Tiered Treasury Model

The treasury runs a single, published economic model. Every requester sees the
same rules, and every decision is explainable down to the individual check that
bound it.

### Tier 1 — Seed Grants (≤ 1 UCT)

Pure, no-repayment micro-grants for fast onboarding, developer gas, and instant
testing. Run `request 1 <reason>` and, if the treasury is solvent and you're
within your limits, the UCT arrives in a single step with **zero debt tracked**.
Grants are available to *every* reputation tier, including brand-new accounts.

Seed grants are paused for an account while it carries an outstanding loan —
clear the loan and instant grants unlock again.

### Tier 2 — Repayable Micro-Loans (> 1 UCT)

Anything above the grant ceiling is booked automatically as a repayable
micro-loan with a configurable return window (**7 days** by default). The
treasury tracks your outstanding debt per identity. Repaying is simple: **just
send the UCT back** to `@frani-treasury`. Incoming transfers are matched to your
oldest outstanding loan first (FIFO), and any overpayment beyond your total debt
is refunded to you automatically.

### Reputation ladder

Standing is *earned*, never asserted — it's derived entirely from your on-network
repayment behaviour:

| Tier | Loan ceiling | Cooldown | Reached by |
|---|---|---|---|
| **Newbie** 🌱 | 2 UCT | 60 min | everyone starts here |
| **Trusted** ⭐ | 5 UCT | 30 min | 2 on-time repayments |
| **Partner** 👑 | 10 UCT | 15 min | 5 on-time repayments |

- **On-time repayment** counts toward promotion, raising your single-loan
  ceiling and shortening your cooldown between requests.
- **Early repayment** (before the due date) grants a temporary boost to your
  daily request limit.
- **Overdue / default** freezes the account: new requests are refused until the
  debt is settled, plus a cool-off period afterward.

Check your personal standing, credit headroom, and cooldown any time with
`status`.

---

## Safety & outflow controls

The treasury is deliberately conservative. It is built so that no single rule,
and no interaction between rules, can push it below solvency. The money controls
are enforced **twice** — once in the pure policy engine, and again independently
in the wallet layer just before any UCT leaves — belt and suspenders:

- **Reserve floor** — a hard, untouchable minimum spendable balance. The wallet
  re-reads its live balance and refuses any send that would breach the floor,
  regardless of what the policy decided.
- **Rolling 24-hour budget** — a cap on total outflow across *all* requesters in
  any 24-hour window.
- **Max single disbursement** — an absolute ceiling on any one payout.
- **Per-account limits** — a request cooldown and a rolling 24h request cap per
  identity, both tuned by reputation tier.
- **Credit headroom** — a borrower can never have more outstanding than their
  tier's credit limit.
- **Controlled outflow** — UCT leaves *only* through two guarded paths:
  `disburse` (funding an approved request) and `refund` (returning a repayment
  overpayment). Arbitrary payment requests sent to the treasury are declined
  automatically; funding is always request-gated.
- **Kill-switches** — `DISBURSE_ENABLED=false` freezes all outflow instantly
  (evaluate-and-reply only, no redeploy needed); `DRY_RUN=true` logs every
  intended action while touching nothing. The owner can also `pause`/`resume`
  live over DM.
- **Idempotency** — every inbound DM and transfer id is de-duplicated and
  persisted before it's acted on, so a relay replay can never cause a double
  payout.

All amounts are handled as exact integer base units (BigInt, 18 decimals) — no
floating-point drift in the money math.

---

## Talking to the treasury

Everything happens over encrypted DM to `@frani-treasury`. A leading `!` is
optional on every command (`!request` and `request` are equivalent).

### Public commands (anyone)

| Command | What it does |
|---|---|
| `request <amount> [reason]` | Ask for funding. `request 1 gas for testing` |
| `status` | Live treasury solvency **and** your personal standing & limits |
| `history` | Your recent requests, decisions, and repayments |
| `terms` | The full funding rules — tiers, ceilings, caps |
| `repay` | How to repay a loan (and your current outstanding balance) |
| `about` | What this service is |
| `help` | The command list |

`fund` / `req` are accepted aliases for `request`; `balance` for `status`;
`rules` for `terms`.

### Owner commands (protected)

The owner surface is authenticated by sender pubkey and is **disabled entirely**
unless `OWNER_PUBKEY` is configured. Non-owners who try an owner command simply
get the "unknown command" reply — the admin surface is never revealed.

| Command | What it does |
|---|---|
| `pause` / `resume` | Stop / restart all disbursement immediately |
| `params` | Dump the active policy knobs |
| `topup <amount>` | Mint more UCT into the corpus |
| `forgive <loanId>` | Write off a loan and unfreeze the borrower |
| `blacklist <pubkey> [on\|off]` | Block / unblock an account |
| `unfreeze <pubkey>` | Lift a freeze early |
| `admin` | The owner command list |

---

## A worked example

```
you → @frani-treasury:   request 3 fund my test harness

@frani-treasury → you:   ✅ Approved a loan of 3 UCT.
                         Repay within 7 days by sending 3 UCT back to me.
                         Repay on time to raise your reputation tier.
                         — CRYPTFRANI

        …later…

you → @frani-treasury:   (send 3 UCT transfer)

@frani-treasury → you:   💚 Received 3 UCT — that clears 1 loan, repaid on time.
                         Reputation +1. Thanks for being reliable!
                         — CRYPTFRANI
```

You can watch the whole decision path yourself, without moving any funds, by
running the built-in demo (see [CLI modes](#cli-modes)) — it evaluates a spread
of sample requests against the live corpus and prints the full ordered check
trace for each.

---

## Quick start

**Requirements:** Node.js ≥ 22.

```bash
git clone https://github.com/NSEVEjk0/frani-treasury.git
cd frani-treasury
npm install

# optional: copy and edit the config (every value has a safe default)
cp .env.example .env

# sanity-check identity, connectivity, and config
npm run doctor

# start the autonomous treasury daemon
npm start
```

On first run the agent generates a BIP39 identity, registers its nametag, and
performs a **one-time capped self-mint** to seed the corpus (there is no faucet
on testnet2). The recovery phrase is printed **once** and saved to
`wallet-data/mnemonic.txt` — back it up offline and never commit it (it controls
the wallet and all of its funds; `wallet-data/` is gitignored for exactly this
reason).

---

## Configuration

All settings are environment variables, optionally loaded from a local `.env`
file. **Every value has a safe, conservative default**, so an empty or absent
`.env` runs a valid, timid testnet2 treasury out of the box. See
[`.env.example`](.env.example) for the fully annotated list; the most important
knobs:

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_NAME` | `frani-treasury` | The nametag to claim (without `@`) |
| `UNICITY_NETWORK` | `testnet2` | Network to run against |
| `OWNER_PUBKEY` | *(empty)* | Chain pubkey allowed to run owner commands. Empty = admin disabled |
| `GRANT_MAX_UCT` | `1` | Tier-1 boundary: ≤ this is a no-repayment grant |
| `LOAN_TERM_DAYS` | `7` | Repayment window for Tier-2 loans |
| `MAX_SINGLE_UCT` | `10` | Absolute hard ceiling on any single disbursement |
| `DAILY_BUDGET_UCT` | `25` | Rolling 24h outflow budget across all requesters |
| `MIN_BALANCE_FLOOR_UCT` | `25` | Untouchable reserve — never spent below this |
| `MAX_REQUESTS_PER_24H` | `5` | Per-account request cap over rolling 24h |
| `DISBURSE_ENABLED` | `true` | Master outflow switch (false = evaluate & reply only) |
| `DRY_RUN` | `false` | Observe-only: log intended actions, touch nothing |
| `SELF_MINT_AMOUNT` | `250` | One-time bootstrap mint to seed the corpus |

Reputation-ladder thresholds, cooldowns, freeze durations, rate caps, sweep
cadence, and the public advert are all configurable too — see `.env.example`.

---

## CLI modes

The agent doubles as its own inspection tool:

```bash
node src/index.js            # start the autonomous treasury daemon (default)
node src/index.js --doctor   # connectivity / config self-check, then exit
node src/index.js --whoami   # print identity + balance, then exit
node src/index.js --status   # print the live treasury status report, then exit
node src/index.js --mint 50  # capped self-mint into the corpus, then exit
node src/index.js --demo     # run sample requests through the policy engine, then exit
```

`--demo` is the quickest way to *see* the decision engine work: it builds the
real numeric context from the live balance and runs a spread of sample requests
through the policy, printing each decision with its full ordered check trace — no
funds move.

---

## Running as a service (systemd)

A unit file is included as [`frani-treasury.service`](frani-treasury.service).
To install it:

```bash
sudo cp frani-treasury.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now frani-treasury
```

Then follow the logs:

```bash
journalctl -u frani-treasury -f
```

`systemctl stop` / `restart` sends `SIGINT`, which triggers the agent's graceful
shutdown: it stops its timers, persists state to disk, and closes the network
connection cleanly rather than being hard-killed.

---

## Architecture

The design keeps the *decision brain* completely separate from I/O, so the
funding logic is deterministic and unit-testable in isolation.

```
src/
  index.js         Entrypoint: CLI modes + daemon bootstrap & graceful shutdown
  agent.js         The long-running loop: events, polling, periodic sweep
  policy.js        PURE decision engine — given a numeric context, returns a decision
  treasury.js      Lifecycle: build context → evaluate → disburse → record → reply
  reputation.js    The tier ladder (Newbie → Trusted → Partner), side-effect free
  state.js         Crash-safe JSON persistence: requesters, loans, ledger, stats
  money.js         Exact BigInt base-unit math (no floating point)
  ratelimit.js     Rolling-window rate limiting (anti-spam + disbursement rate cap)
  sphere-client.js Network layer: identity, wallet, and the guarded outflow paths
  reply.js         Outbound DM helper (honours politeness caps)
  config.js        Central, frozen configuration from env with safe defaults
  logger.js        Small levelled structured logger
  services/
    commands.js    DM command router (public + owner surfaces)
    delivery.js    Public advertising: standing service intent + optional heartbeat
```

`policy.js` imports nothing but the money helpers — no SDK, no clock, no config.
`treasury.buildContext()` resolves configuration and reputation into a purely
numeric context, which is the *only* input to `policy.evaluate()`. That's why the
decision engine can be exercised end-to-end offline, and why every decision the
live agent makes carries a complete, ordered trace of the checks that produced
it.

### State & persistence

All durable state lives in `wallet-data/state.json`: per-requester reputation
records, the loan ledger (active / repaid / overdue / forgiven), an activity
ledger, seen-message and seen-transfer sets for idempotency, and lifetime stats.
It is written atomically and reloaded on boot, so the treasury survives restarts
without losing track of who owes what — and, crucially, without ever paying the
same request twice.

---

## Security notes

- **Never commit `wallet-data/`.** It holds the BIP39 mnemonic and private keys
  that control `@frani-treasury` and all of its funds, plus the live ledger. The
  entire directory is gitignored.
- **Never commit `.env`.** Also gitignored.
- The owner admin surface is off unless `OWNER_PUBKEY` is set, and is
  authenticated per-message by sender pubkey.
- Set `WALLET_PASSWORD` to encrypt the mnemonic at rest on a shared host.

---

## License

MIT © Itachi (CRYPTFRANI)

---

<p align="center"><sub>Made by <b>CRYPTFRANI</b> · Owner / Creator: <b>Itachi</b></sub></p>

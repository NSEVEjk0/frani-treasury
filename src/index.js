#!/usr/bin/env node
/**
 * frani-treasury — entrypoint
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Modes:
 *   node src/index.js               start the autonomous treasury daemon (default)
 *   node src/index.js --whoami      print identity + balance, then exit
 *   node src/index.js --doctor      connectivity / config self-check, then exit
 *   node src/index.js --status      print the live treasury status report, then exit
 *   node src/index.js --mint [amt]  capped self-mint into the corpus, then exit
 *   node src/index.js --demo        run sample requests through the policy engine, then exit
 */

import config from './config.js';
import { createLogger } from './logger.js';
import { SphereClient } from './sphere-client.js';
import policy from './policy.js';
import reputation from './reputation.js';

const log = createLogger('main');

const AMOUNT_RE = /^\d+(\.\d+)?$/;

function banner() {
  log.info('──────────────────────────────────────────────');
  log.info(' frani-treasury · autonomous rules-based UCT treasury (Unicity testnet2)');
  log.info(` owner: ${config.owner}   ·   made by ${config.brand}`);
  log.info(` network: ${config.network}   dry-run: ${config.safety.dryRun}`);
  log.info(` grants ≤ ${config.treasury.grantMaxWhole} UCT · loans to ${config.treasury.maxSingleWhole} UCT · reserve floor ${config.treasury.minBalanceFloorWhole} UCT`);
  log.info('──────────────────────────────────────────────');
}

async function reportStatus(client) {
  const balance = await client.spendableWhole();
  log.info(`Identity : ${client.describe()}`);
  log.info(`Pubkey   : ${client.identity.chainPubkey ?? '(n/a)'}  (set as OWNER_PUBKEY to enable admin)`);
  log.info(`Coin     : ${client.coin.symbol} (${client.coin.decimals} decimals)`);
  log.info(`Corpus   : ${balance} ${client.coin.symbol} (spendable) · floor ${config.treasury.minBalanceFloorWhole}`);
  log.info(`Funding  : ${config.safety.disburseEnabled ? 'ENABLED' : 'DISABLED'} · daily budget ${config.treasury.dailyBudgetWhole} ${client.coin.symbol}`);
  log.info(`Admin    : ${config.admin.enabled ? 'enabled (owner DM)' : 'disabled'}`);
  log.info(`Wallet   : ${config.walletDir}  (device ${client.deviceId})`);
}

/** Print the shared treasury status report (same figures the DM `status` shows). */
async function printStatus(client) {
  const { State } = await import('./state.js');
  const { treasuryStatusLines } = await import('./services/commands.js');
  const state = State.load();
  const lines = await treasuryStatusLines(client, state, Date.now());
  log.info('\n' + lines.join('\n'));
}

/**
 * Demonstrate the decision engine end-to-end without moving funds: build the
 * real numeric context from the live balance, then run a spread of sample
 * requests through the pure policy and print each decision with its full,
 * ordered checks trace — exactly what the treasury evaluates on a live DM.
 */
async function runDemo(client) {
  const { State } = await import('./state.js');
  const state = State.load();
  const now = Date.now();
  const decimals = client.coin.decimals;

  const scenario = async (title, { rec, requestedWhole }) => {
    const { buildContext } = await import('./treasury.js');
    const ctx = await buildContext(client, state, rec, now);
    const decision = policy.evaluate({ requestedBase: client.toBase(requestedWhole), nowMs: now }, ctx);
    log.info(`\n── ${title} ──`);
    log.info(`request  : ${requestedWhole} ${client.coin.symbol}  ·  requester tier: ${reputation.describeTier(reputation.tierOf(rec))}`);
    log.info(`decision : ${decision.decision.toUpperCase()}${decision.kind ? ` (${decision.kind})` : ''} → ${client.fmt(decision.amountBase)}  [${decision.code}]`);
    log.info(`reason   : ${decision.reason}`);
    for (const c of decision.checks) log.info(`   ${c.ok ? '✓' : '✗'} ${c.name.padEnd(18)} ${c.detail ?? ''}`);
  };

  const fresh = () => reputation.freshRequester('demo-newbie-pubkey', 'demo-newbie', now);
  const partner = () => {
    const r = reputation.freshRequester('demo-partner-pubkey', 'demo-partner', now);
    r.onTimeRepayments = config.treasury.tiers.partner.promoteAtOnTime; // promoted to Partner
    return r;
  };

  log.info('\n════════ frani-treasury · decision engine demo ════════');
  log.info('(no funds move — this evaluates sample requests against the live corpus)');
  await scenario('Newbie asks 1 UCT → instant SEED GRANT', { rec: fresh(), requestedWhole: '1' });
  await scenario('Newbie asks 5 UCT → clamped to a LOAN at their tier ceiling', { rec: fresh(), requestedWhole: '5' });
  await scenario('Partner asks 8 UCT → larger LOAN (higher ceiling)', { rec: partner(), requestedWhole: '8' });
  await scenario('Anyone asks 0 → rejected (invalid amount)', { rec: fresh(), requestedWhole: '0' });
  log.info('\nLive requests are made over DM: `request <amount> <reason>` to @' + config.nametag + '.');
  log.info('════════════════════════════════════════════════════════\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  banner();

  const client = await SphereClient.boot();

  // ── one-shot inspection / maintenance modes ───────────────────────────────
  if (args.has('--doctor')) {
    await client.ensureNametag();
    await reportStatus(client);
    log.info(`Connection: ${client.sphere.payments.connectionStatus?.() ?? 'n/a'}`);
    log.info('Doctor check complete. ✅');
    await client.destroy();
    process.exit(0); // one-shot modes force exit — open sockets would otherwise linger
  }

  if (args.has('--whoami')) {
    await reportStatus(client);
    await client.destroy();
    process.exit(0);
  }

  if (args.has('--status')) {
    await printStatus(client);
    await client.destroy();
    process.exit(0);
  }

  if (args.has('--mint')) {
    await client.ensureNametag();
    const amt = argv.find((a) => AMOUNT_RE.test(a)) ?? config.safety.selfMintAmountWhole;
    await client.mint(amt);
    await reportStatus(client);
    await client.destroy();
    process.exit(0);
  }

  if (args.has('--demo')) {
    await runDemo(client);
    await client.destroy();
    process.exit(0);
  }

  // ── default: run the autonomous treasury daemon ────────────────────────────
  await client.ensureNametag();
  await client.bootstrapMintIfNeeded();
  await reportStatus(client);

  const { startAgent } = await import('./agent.js');
  const controller = new AbortController();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal} — shutting down gracefully…`);
    controller.abort();
    setTimeout(async () => {
      await client.destroy();
      process.exit(0);
    }, 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await startAgent(client, controller.signal);
  await client.destroy();
}

main().catch((err) => {
  log.error('Fatal:', err?.stack ?? err?.message ?? err);
  process.exit(1);
});

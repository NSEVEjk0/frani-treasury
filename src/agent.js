/**
 * frani-treasury — the autonomous loop
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * The long-running daemon. It keeps the treasury alive and reacting:
 *   • publishes the standing `service` advert so funding is discoverable
 *   • drains transfers/DMs that arrived while offline, then processes them
 *   • reacts to events: message:dm (commands), transfer:incoming (repayments &
 *     donations), payment_request:incoming (declined — outflow is disburse-only)
 *   • wakes on a slow timer to sweep loans (due-soon reminders, overdue freezes),
 *     re-assert the service intent, and optionally broadcast a solvency heartbeat
 *   • runs a receive() safety-net poll so nothing is missed if an event is dropped
 *
 * Everything is event-driven or slow-polled with awaited, non-overlapping passes
 * — no busy loops, tiny CPU/RAM footprint. The loop unwinds cleanly on abort.
 */

import { coinIdsMatch } from '@unicitylabs/sphere-sdk';

import config from './config.js';
import { createLogger } from './logger.js';
import { State, normalizeKey } from './state.js';
import { RateLimiter } from './ratelimit.js';
import treasury from './treasury.js';
import { handleDm } from './services/commands.js';
import { ensureServiceIntent, broadcastHeartbeat } from './services/delivery.js';

const log = createLogger('agent');

/**
 * Run `fn` every `ms`, non-overlapping (awaits each run before scheduling the
 * next), stopping cleanly on abort. Timers are NOT unref'd — they keep the
 * process alive for the lifetime of the loop.
 */
function every(ms, fn, signal, label) {
  let timer = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const tick = async () => {
    if (stopped || signal.aborted) return;
    try {
      await fn();
    } catch (err) {
      log.error(`[${label}] pass error: ${err?.stack ?? err?.message ?? err}`);
    }
    if (stopped || signal.aborted) return;
    timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  signal.addEventListener('abort', stop, { once: true });
  return stop;
}

/** Sum the UCT value (base units) of an incoming transfer. */
function uctAmount(client, transfer) {
  return (transfer.tokens ?? [])
    .filter((t) => coinIdsMatch(t.coinId, client.coin.coinId))
    .reduce((acc, t) => acc + BigInt(t.amount ?? '0'), 0n);
}

export async function startAgent(client, signal) {
  const state = State.load();
  client.attachState(state); // the client keeps the lag-free book balance in state
  const rateLimit = new RateLimiter();
  const sym = client.coin.symbol;
  const selfNorm = new Set([...client.selfPubkeys()].map(normalizeKey));
  const t = config.treasury;

  const balance = await client.effectiveSpendableWhole(); // anchors/reconciles the book to chain
  log.info('──────────────────────────────────────────────');
  log.info(' frani-treasury — services starting');
  log.info(`   identity    : ${client.describe()}`);
  log.info(`   corpus      : ${balance} ${sym}  (reserve floor ${t.minBalanceFloorWhole} ${sym})`);
  log.info(`   funding      : ${config.safety.disburseEnabled && !state.paused ? 'OPEN' : 'PAUSED'} · grants ≤ ${t.grantMaxWhole} ${sym} · loans to ${t.maxSingleWhole} ${sym}`);
  log.info(`   daily budget : ${t.dailyBudgetWhole} ${sym} (rolling 24h) · ${t.maxRequestsPer24h} requests/24h per account`);
  log.info(`   loan term    : ${t.loanTermDays}d · sweep every ${Math.round(config.schedule.sweepMs / 60_000)}m · receive net ${Math.round(config.schedule.receivePollMs / 1000)}s`);
  log.info(`   admin        : ${config.admin.enabled ? 'enabled (owner DM)' : 'disabled (no OWNER_PUBKEY)'} · dry-run ${config.safety.dryRun}`);
  log.info(`   active loans : ${state.allLoans().filter((l) => l.status === 'active' || l.status === 'overdue').length} · lifetime grants ${state.stats.grantsCount} · loans ${state.stats.loansCount}`);
  log.info('──────────────────────────────────────────────');

  // ── event handlers ──────────────────────────────────────────────────────────
  async function onTransfer(transfer) {
    if (signal.aborted || !transfer?.id) return;
    if (!state.markTransferSeen(transfer.id)) return; // relay / receive() double-delivery
    state.save();
    if (selfNorm.has(normalizeKey(transfer.senderPubkey))) return; // ignore our own change/outputs
    const amountBase = uctAmount(client, transfer);
    if (amountBase <= 0n) return; // non-UCT or empty transfer
    try {
      await treasury.applyIncomingRepayment(client, state, rateLimit, { transfer, amountBase });
    } catch (err) {
      log.error(`transfer handler error: ${err?.stack ?? err?.message ?? err}`);
    }
  }

  async function onDm(dm) {
    if (signal.aborted || !dm?.id) return;
    if (selfNorm.has(normalizeKey(dm.senderPubkey))) return; // never talk to ourselves
    if (!state.markDmSeen(dm.id)) return; // dedup replays → at-most-once handling (no double-pay)
    state.save();
    try {
      await handleDm(client, state, rateLimit, dm);
    } catch (err) {
      log.error(`dm handler error: ${err?.stack ?? err?.message ?? err}`);
    }
  }

  async function onPaymentRequest(pr) {
    if (signal.aborted || !pr?.id) return;
    const who = pr.senderNametag ? `@${pr.senderNametag}` : pr.senderPubkey;
    let amt = '?';
    try {
      amt = client.toWhole(BigInt(pr.amount ?? '0'));
    } catch {
      /* leave as ? */
    }
    // The treasury pays ONLY through the guarded disburse/refund paths after a
    // policy decision — it never fulfils an arbitrary inbound payment request.
    log.info(`Incoming payment request from ${who} for ${amt} ${sym} — declining (funding is request-gated).`);
    if (config.safety.dryRun) return;
    try {
      await client.sphere.payments.requests.decline(pr.id);
    } catch (err) {
      log.warn(`Could not decline payment request ${pr.id}: ${err?.message ?? err}`);
    }
  }

  async function drainIncoming(why) {
    try {
      const { transfers } = await client.sphere.payments.receive();
      if (transfers?.length) log.info(`receive() surfaced ${transfers.length} transfer(s) [${why}].`);
      for (const tr of transfers ?? []) await onTransfer(tr);
    } catch (err) {
      log.warn(`receive() failed [${why}]: ${err?.message ?? err}`);
    }
  }

  // ── periodic sweep: loans + intent + heartbeat ───────────────────────────────
  async function sweep(why) {
    if (signal.aborted) return;
    try {
      await treasury.sweepLoans(client, state, rateLimit, Date.now());
    } catch (err) {
      log.error(`loan sweep error [${why}]: ${err?.stack ?? err?.message ?? err}`);
    }
    await ensureServiceIntent(client, state); // re-assert if it expired
    try {
      await broadcastHeartbeat(client, state, rateLimit);
    } catch (err) {
      log.warn(`heartbeat error: ${err?.message ?? err}`);
    }
  }

  // ── 1) advertise ─────────────────────────────────────────────────────────────
  await ensureServiceIntent(client, state);

  // ── 2) process anything that landed while we were offline ────────────────────
  await drainIncoming('startup');

  // ── 3) subscribe to live events ──────────────────────────────────────────────
  const unsubs = [];
  try {
    unsubs.push(client.sphere.on('transfer:incoming', (tr) => void onTransfer(tr)));
    unsubs.push(client.sphere.on('message:dm', (dm) => void onDm(dm)));
    unsubs.push(client.sphere.on('payment_request:incoming', (pr) => void onPaymentRequest(pr)));
    log.info('Subscribed to transfer / DM / payment-request events.');
  } catch (err) {
    log.warn(`Event subscription issue: ${err?.message ?? err}`);
  }

  // ── 4) periodic passes: loan sweep + receive safety-net ──────────────────────
  const stopSweep = every(config.schedule.sweepMs, () => sweep('tick'), signal, 'sweep');
  const stopReceive = every(config.schedule.receivePollMs, () => drainIncoming('poll'), signal, 'receive');

  // First sweep shortly after boot (catch loans that went overdue while offline).
  const bootSweep = setTimeout(() => void sweep('startup'), 3000);

  log.info('frani-treasury is live. Ctrl-C to stop.');

  // ── stay alive until aborted, then unwind ────────────────────────────────────
  await new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

  log.info('Stopping services…');
  clearTimeout(bootSweep);
  stopSweep();
  stopReceive();
  for (const u of unsubs) {
    try {
      u?.();
    } catch {
      /* ignore */
    }
  }
  state.save();
  log.info('Services stopped; state persisted.');
}

export default startAgent;

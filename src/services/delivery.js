/**
 * frani-treasury — public advertising
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * How the treasury announces itself to the network:
 *   • ensureServiceIntent — keep a standing `service` intent on the market board
 *     so other agents can discover that funding is available here. Reconciled
 *     against the server: re-posted only if the previously stored one is gone.
 *   • broadcastHeartbeat  — optional public solvency line (off by default),
 *     a transparent "the treasury is open, here's what's left today" signal.
 */

import config from '../config.js';
import { createLogger } from '../logger.js';
import { treasuryStatusLines } from './commands.js';

const log = createLogger('delivery');

const DAY_MS = 86_400_000;

/**
 * Publish (or re-publish) the standing `service` intent advertising the
 * treasury. Idempotent: if the stored intent is still active on the server we
 * leave it be.
 */
export async function ensureServiceIntent(client, state) {
  if (!config.publish.serviceIntentEnabled) return;
  if (config.safety.dryRun) {
    log.warn(`[DRY_RUN] Would publish the @${config.nametag} service intent.`);
    return;
  }
  try {
    if (state.serviceIntentId) {
      const mine = await client.sphere.market.getMyIntents();
      const alive = mine.some((m) => m.id === state.serviceIntentId && m.status === 'active');
      if (alive) {
        log.info(`Service intent already live (${String(state.serviceIntentId).slice(0, 10)}…).`);
        return;
      }
    }
    const result = await client.sphere.market.postIntent({
      description: config.publish.serviceDescription,
      intentType: 'service',
      category: 'data',
      currency: config.coinSymbol,
      contactHandle: client.nametag ? `@${client.nametag}` : undefined,
      expiresInDays: config.publish.intentExpiresInDays,
    });
    state.setServiceIntentId(result.intentId);
    state.save();
    log.info(`Published service intent ${String(result.intentId).slice(0, 10)}… (expires ${result.expiresAt}).`);
  } catch (err) {
    log.warn(`Could not publish service intent (non-fatal): ${err?.message ?? err}`);
  }
}

/**
 * Optional public transparency heartbeat: a short line on the broadcast channel
 * summarising how open the treasury is right now. Off unless BROADCAST_ENABLED.
 */
export async function broadcastHeartbeat(client, state, rateLimit) {
  if (!config.publish.broadcastEnabled) return;
  if (!rateLimit.allow('action', config.safety.maxActionsPerHour)) return;
  const now = Date.now();
  const balanceBase = await client.spendableBase();
  const budgetBase = client.toBase(config.treasury.dailyBudgetWhole);
  const spentBase = state.disbursedInWindowBase(DAY_MS, now);
  const left = budgetBase - spentBase > 0n ? budgetBase - spentBase : 0n;
  const open = config.safety.disburseEnabled && !state.paused;
  const line =
    `🏦 frani-treasury ${open ? 'OPEN' : 'PAUSED'} · corpus ${client.fmt(balanceBase)} · ` +
    `${client.fmt(left)} of today's budget left · DM \`request <amount> <reason>\` for funding. ` +
    `Grants ≤ ${config.treasury.grantMaxWhole} UCT, larger = 7-day loans. Made by ${config.brand}.`;
  await client.broadcast(line);
}

export default { ensureServiceIntent, broadcastHeartbeat };

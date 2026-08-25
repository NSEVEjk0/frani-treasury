/**
 * frani-treasury — Sphere client: identity, wallet, and money primitives
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Wraps @unicitylabs/sphere-sdk for a headless Node.js agent on testnet2:
 *   • builds Node providers (storage + Nostr transport + aggregator oracle)
 *     and the required wallet-api transport layer
 *   • load-or-create identity from a locally-persisted BIP39 mnemonic
 *   • registers the @nametag, resolves the UCT coin, checks balance
 *   • capped self-mint to seed the treasury corpus (no faucet on testnet2)
 *   • exposes ONE guarded outbound primitive — `disburse` — plus `refund`
 *
 * Money policy = EARN + CONTROLLED OUTFLOW. Outbound UCT leaves ONLY through
 * `disburse` (funding a vetted request) or `refund` (returning a repayment
 * overpayment). Both honour DRY_RUN, the DISBURSE_ENABLED kill-switch, and an
 * independent min-balance floor re-check — so even a bug in the policy engine
 * cannot push the corpus below its reserve.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  Sphere,
  NETWORKS,
  isSphereError,
  isValidNametag,
  getCoinIdBySymbol,
  getTokenDecimals,
} from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

import config from './config.js';
import { createLogger } from './logger.js';
import { toBaseUnits, toWholeString } from './money.js';

const log = createLogger('sphere');

// Re-export the money helpers so callers can import them from the client too.
export { toBaseUnits, toWholeString };

// ── small utilities ─────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function fmtErr(err) {
  if (isSphereError(err)) return `${err.code}: ${err.message}`;
  return err?.message ?? String(err);
}

// ── file-backed identity bits ───────────────────────────────────────────────
function walletPaths() {
  const dir = resolve(config.walletDir);
  return {
    dir,
    mnemonic: join(dir, 'mnemonic.txt'),
    deviceId: join(dir, 'device-id.txt'),
  };
}

function ensureWalletDir() {
  const { dir } = walletPaths();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function loadOrCreateDeviceId() {
  const { deviceId } = walletPaths();
  if (existsSync(deviceId)) return readFileSync(deviceId, 'utf8').trim();
  const id = `${config.nametag}-${randomUUID()}`;
  writeFileSync(deviceId, `${id}\n`, { mode: 0o600 });
  return id;
}

function readMnemonicFile() {
  const { mnemonic } = walletPaths();
  return existsSync(mnemonic) ? readFileSync(mnemonic, 'utf8').trim() : undefined;
}

function saveMnemonicFile(phrase) {
  const { mnemonic } = walletPaths();
  writeFileSync(mnemonic, `${phrase}\n`, { mode: 0o600 });
}

function printMnemonicBanner(phrase, saved) {
  const line = '═'.repeat(72);
  log.warn(`\n${line}`);
  log.warn(`  🔑  NEW IDENTITY CREATED FOR @${config.nametag}`);
  log.warn('  This BIP39 recovery phrase controls the treasury wallet AND its funds.');
  log.warn('  BACK IT UP OFFLINE. It is shown ONCE and never printed again.');
  log.warn(line);
  log.warn(`  ${phrase}`);
  log.warn(line);
  log.warn(
    saved
      ? `  Also saved (mode 0600) to ${walletPaths().mnemonic}`
      : '  Not written to disk (WALLET_PASSWORD set).',
  );
  log.warn(`${line}\n`);
}

// ── token registry fallback (used when the SDK cache is not yet populated) ──
async function fetchRegistrySymbol(symbol) {
  const net = NETWORKS[config.network] ?? NETWORKS.testnet2 ?? NETWORKS.testnet;
  const url = net?.tokenRegistryUrl;
  if (!url) return undefined;
  const res = await withTimeout(fetch(url), 15_000, 'token-registry fetch');
  if (!res.ok) throw new Error(`token registry HTTP ${res.status}`);
  const listJson = await res.json();
  const arr = Array.isArray(listJson) ? listJson : [];
  return arr.find(
    (e) => e?.assetKind === 'fungible' && String(e?.symbol).toUpperCase() === symbol.toUpperCase(),
  );
}

async function resolveCoin(symbol) {
  let coinId;
  try {
    coinId = getCoinIdBySymbol(symbol) || undefined;
  } catch {
    /* registry not loaded yet */
  }
  let decimals;
  if (coinId) {
    try {
      const d = getTokenDecimals(coinId);
      if (Number.isFinite(d)) decimals = d;
    } catch {
      /* fall through to registry */
    }
  }
  if (!coinId || decimals == null) {
    const entry = await fetchRegistrySymbol(symbol);
    if (!entry) throw new Error(`Coin symbol "${symbol}" not found in the testnet2 registry`);
    coinId = coinId ?? entry.id;
    decimals = decimals ?? entry.decimals;
  }
  log.info(`Resolved ${symbol}: coinId=${coinId.slice(0, 12)}… decimals=${decimals}`);
  return { symbol, coinId, decimals };
}

/**
 * SphereClient — the treasury's handle on the network. Bundles the initialized
 * Sphere instance, the resolved coin, and guarded high-level actions.
 */
export class SphereClient {
  constructor(sphere, coin, deviceId, created) {
    this.sphere = sphere;
    this.coin = coin;
    this.deviceId = deviceId;
    this.created = created;
  }

  /** Boot providers + identity. Load-or-create from the local mnemonic file. */
  static async boot() {
    ensureWalletDir();
    const deviceId = loadOrCreateDeviceId();

    const base = createNodeProviders({
      network: config.network,
      dataDir: resolve(config.walletDir),
      walletFileName: config.walletFileName,
      oracle: { apiKey: config.oracleApiKey },
      market: true,
    });

    const providers = createWalletApiProviders(base, {
      baseUrl: config.walletApiUrl,
      network: config.network,
      deviceId,
    });

    const fileMnemonic = config.password ? undefined : readMnemonicFile();
    const initOpts = {
      ...providers,
      network: config.network, // engine/registry network — must match walletApi.network
      market: true,
      communications: {},
      dmSince: Math.floor(Date.now() / 1000) - 86_400, // catch DMs from the last 24h on connect
      ...(config.password ? { password: config.password } : {}),
      ...(fileMnemonic ? { mnemonic: fileMnemonic } : { autoGenerate: true }),
    };

    log.info(`Connecting to ${config.network} as @${config.nametag} (device ${deviceId})…`);
    const { sphere, created, generatedMnemonic } = await withTimeout(
      Sphere.init(initOpts),
      60_000,
      'Sphere.init',
    );

    if (created && generatedMnemonic) {
      const shouldSave = !config.password; // don't scatter a plaintext phrase when encrypting the store
      if (shouldSave) saveMnemonicFile(generatedMnemonic);
      printMnemonicBanner(generatedMnemonic, shouldSave);
    } else {
      log.info(created ? 'New wallet created.' : 'Existing wallet loaded.');
    }

    const coin = await resolveCoin(config.coinSymbol);
    const client = new SphereClient(sphere, coin, deviceId, created);
    log.info(`Identity ready: ${client.describe()}`);
    return client;
  }

  // ── identity accessors ────────────────────────────────────────────────────
  get identity() {
    return this.sphere.identity ?? {};
  }

  get nametag() {
    return this.identity.nametag?.replace(/^@/, '') || null;
  }

  get address() {
    return this.identity.directAddress || this.identity.chainPubkey || null;
  }

  /** Both key encodings that may echo back as "self" on the relay. */
  selfPubkeys() {
    const set = new Set();
    const cp = this.identity.chainPubkey;
    if (cp) {
      set.add(cp);
      if (cp.length === 66) set.add(cp.slice(2)); // 32-byte x-only form
    }
    return set;
  }

  describe() {
    return `@${this.nametag ?? '(unregistered)'} · ${this.address ?? '?'}`;
  }

  // ── balance ───────────────────────────────────────────────────────────────
  async spendableBase() {
    const assets = await this.sphere.payments.assets(this.coin.coinId);
    const a = assets.find((x) => x.coinId === this.coin.coinId);
    if (!a) return 0n;
    return BigInt(a.confirmedAmount ?? a.totalAmount ?? '0');
  }

  async spendableWhole() {
    return toWholeString(await this.spendableBase(), this.coin.decimals);
  }

  toBase(whole) {
    return toBaseUnits(whole, this.coin.decimals);
  }

  toWhole(base) {
    return toWholeString(base, this.coin.decimals);
  }

  fmt(base) {
    return `${this.toWhole(base)} ${this.coin.symbol}`;
  }

  // ── nametag ────────────────────────────────────────────────────────────────
  async ensureNametag() {
    if (this.nametag) {
      log.info(`Nametag already held: @${this.nametag}`);
      return this.nametag;
    }
    if (!isValidNametag(config.nametag)) {
      log.warn(`Configured nametag "${config.nametag}" is invalid; running keys-only.`);
      return null;
    }
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would register nametag @${config.nametag}.`);
      return null;
    }
    try {
      const available = await this.sphere.isNametagAvailable(config.nametag);
      if (!available) {
        log.warn(`Nametag @${config.nametag} is taken by another identity; running keys-only.`);
        return null;
      }
      await this.sphere.registerNametag(config.nametag);
      log.info(`Registered nametag @${config.nametag}.`);
      return config.nametag;
    } catch (err) {
      log.warn(`Nametag registration failed (non-fatal): ${fmtErr(err)}`);
      return null;
    }
  }

  // ── minting (testnet2 corpus self-funding; no faucet) ───────────────────────
  async mint(whole) {
    const base = this.toBase(whole);
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would self-mint ${whole} ${this.coin.symbol}.`);
      return { success: false, dryRun: true };
    }
    log.info(`Self-minting ${whole} ${this.coin.symbol} into the treasury corpus…`);
    const result = await this.sphere.payments.mint(this.coin.coinId, base);
    if (result?.success) {
      log.info(`Minted ${whole} ${this.coin.symbol} (token ${String(result.tokenId).slice(0, 12)}…).`);
    } else {
      log.error(`Mint failed: ${result?.error ?? 'unknown error'}`);
    }
    return result;
  }

  /** One-time bootstrap mint on first run if enabled and below the reserve floor. */
  async bootstrapMintIfNeeded() {
    if (!config.safety.selfMintEnabled) return;
    const balance = await this.spendableBase();
    const floor = this.toBase(config.treasury.minBalanceFloorWhole);
    if (balance >= floor) {
      log.info(`Corpus ${this.toWhole(balance)} ${this.coin.symbol} ≥ reserve floor; no bootstrap needed.`);
      return;
    }
    log.info(`Corpus below reserve floor — bootstrapping with a capped self-mint.`);
    await this.mint(config.safety.selfMintAmountWhole);
  }

  // ── outbound payment (controlled outflow: disburse + refund only) ────────────
  /**
   * Low-level guarded send. Independent of the policy engine, this ALWAYS:
   *   • refuses non-positive amounts
   *   • honours DRY_RUN
   *   • re-checks the reserve floor against a fresh balance read
   *   • never blindly retries an unconfirmed certification (double-pay guard)
   */
  async _send(recipient, base, memo) {
    if (base <= 0n) return { skipped: 'non-positive amount' };
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would send ${this.toWhole(base)} ${this.coin.symbol} to ${recipient}.`);
      return { dryRun: true };
    }
    const balance = await this.spendableBase();
    const floor = this.toBase(config.treasury.minBalanceFloorWhole);
    if (balance - base < floor) {
      log.warn(
        `Refusing send of ${this.toWhole(base)} — would breach reserve floor ` +
          `(${this.toWhole(balance)} → below ${config.treasury.minBalanceFloorWhole}).`,
      );
      return { skipped: 'reserve-floor' };
    }
    try {
      const result = await this.sphere.payments.send({
        recipient,
        amount: base.toString(),
        coinId: this.coin.coinId,
        memo,
      });
      if (result?.error) log.error(`Send error: ${result.error}`);
      else log.info(`Sent ${this.toWhole(base)} ${this.coin.symbol} to ${recipient} (${result.status}).`);
      return result;
    } catch (err) {
      // Never blindly re-send on an unconfirmed certification (double-pay risk).
      if (isSphereError(err) && err.code === 'CERTIFICATION_UNCONFIRMED') {
        log.warn(`Send certification unconfirmed to ${recipient} — NOT retrying (double-pay guard).`);
        return { unconfirmed: true };
      }
      log.error(`Send failed to ${recipient}: ${fmtErr(err)}`);
      return { error: fmtErr(err) };
    }
  }

  /**
   * Disburse funding for an approved request. This is the ONLY path that pays
   * out grants/loans, and it is gated by the DISBURSE_ENABLED master switch in
   * addition to every guard in `_send`.
   */
  async disburse(recipient, base, memo) {
    if (!config.safety.disburseEnabled) {
      log.warn(`DISBURSE_ENABLED=false — not disbursing ${this.toWhole(base)} ${this.coin.symbol} to ${recipient}.`);
      return { skipped: 'disburse-disabled' };
    }
    return this._send(recipient, base, memo);
  }

  /** Refund an overpaid repayment surplus (never keep more than the debt). */
  async refund(recipient, base, memo = `${config.nametag} refund`) {
    if (!config.safety.autoRefundOverpayment) return { skipped: 'refunds disabled' };
    log.info(`Refunding ${this.toWhole(base)} ${this.coin.symbol} to ${recipient}.`);
    return this._send(recipient, base, memo);
  }

  // ── payment requests (a one-click repayment invoice) ─────────────────────────
  async requestPayment(recipient, whole, memo) {
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would request ${whole} ${this.coin.symbol} from ${recipient} (${memo}).`);
      return { success: false, dryRun: true };
    }
    try {
      const result = await this.sphere.payments.requests.create(recipient, {
        coinId: this.coin.coinId,
        amount: this.toBase(whole).toString(),
        memo,
      });
      if (result?.success) log.info(`Payment request sent to ${recipient} for ${whole} ${this.coin.symbol}.`);
      else log.warn(`Payment request to ${recipient} failed: ${result?.error ?? 'unknown'}`);
      return result;
    } catch (err) {
      log.error(`Payment request failed to ${recipient}: ${fmtErr(err)}`);
      return { success: false, error: fmtErr(err) };
    }
  }

  // ── messaging ────────────────────────────────────────────────────────────────
  async sendDM(recipient, content) {
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would DM ${recipient}: ${content.slice(0, 80)}…`);
      return { dryRun: true };
    }
    try {
      const dm = await this.sphere.communications.sendDM(recipient, content);
      log.info(`DM sent to ${recipient} (${String(dm?.id ?? '').slice(0, 10)}…).`);
      return dm;
    } catch (err) {
      log.error(`DM failed to ${recipient}: ${fmtErr(err)}`);
      return { error: fmtErr(err) };
    }
  }

  /** Publish a public broadcast (optional transparency heartbeat). Honours DRY_RUN. */
  async broadcast(content, tags = config.publish.broadcastTags) {
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would broadcast (${content.length} chars; tags ${tags.join(',')}).`);
      return { dryRun: true };
    }
    try {
      const msg = await this.sphere.communications.broadcast(content, tags);
      log.info(`Broadcast published (${String(msg?.id ?? '').slice(0, 10)}…; tags ${tags.join(',')}).`);
      return msg;
    } catch (err) {
      log.warn(`Broadcast failed: ${fmtErr(err)}`);
      return { error: fmtErr(err) };
    }
  }

  /** secp256k1 signature over `message` using the agent's chain key. */
  signMessage(message) {
    return this.sphere.signMessage(message);
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    try {
      await this.sphere.destroy?.();
      log.info('Sphere connection closed.');
    } catch (err) {
      log.warn(`Error during shutdown: ${fmtErr(err)}`);
    }
  }
}

export default SphereClient;

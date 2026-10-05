/**
 * Imported-wallet sync: ERC-20 transfers in and out of each imported wallet,
 * booked to the org's ledger as `wallet` rows.
 *
 * Read only. Nothing here signs or moves money; a wallet is watched on the
 * chain its row names, through the RPC configured for that chain
 * (WALLET_SYNC.rpcs), and a chain with none is an error on the wallet rather
 * than a silent gap.
 *
 * Per wallet, a cursor (the last block booked) walks forward in windows of at
 * most WALLET_SYNC.maxBlockSpan, up to WALLET_SYNC.windowsPerTick per run, and
 * stops WALLET_SYNC.confirmations behind the head. The cursor moves only past
 * a window whose every transfer was booked or deliberately skipped:
 *
 * - An RPC failure, a price feed or ECB outage, or a token read that fails
 *   in transport holds the window; the next run tries it again. The wallet
 *   shows why, with any URL removed (an RPC URL usually carries its API key).
 * - A window the RPC refuses as too large is halved until it answers.
 * - A token with no `decimals()` is counted in `sync.skipped`, not booked at
 *   a guessed scale. A token with no price is booked unvalued.
 *
 * The first run starts at the head unless the wallet carries a start day
 * (`sync.from`, the `ledger.historicalSync` capability), in which case it
 * starts at the first block of that day. A wallet whose address is one of the
 * org's own Zold accounts is not synced: the statement writer books it.
 *
 * Covered: ERC-20 Transfer events. NOT covered: native ETH (no log; needs
 * traces), NFTs (dropped by the strict event decode), and rebasing tokens,
 * whose balance moves without a transfer.
 */
import { readLogWindow } from "../log-range.js";
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  formatUnits,
  http,
} from "viem";
import { CHAIN_ID, WALLET_SYNC } from "../config.js";
import { loadDeployments } from "../config/deployments.js";
import { applyRules } from "../domain/coa.js";
import type { ImportedWallet, LedgerEntry } from "../domain/types.js";
import {
  cleanSymbol,
  toWalletEntry,
  usableDecimals,
  walletEntryId,
  walletEntryKey,
  type RawTransfer,
  type TokenClass,
  type TokenInfo,
} from "../domain/wallet-transfers.js";
import { store } from "../store.js";
import { classifyToken, emoneySymbol } from "./token-class.js";
import { loadTokenLists, type TokenListsResult } from "./token-lists.js";
import { valueTransfer, type ValuationQuery, type ValuationResult } from "./valuation.js";

/** What the sync needs from a chain. A seam, so the loop is tested offline. */
export interface ChainReader {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlockTime(blockNumber: bigint): Promise<string>;
  getTransferLogs(q: {
    address: `0x${string}`;
    direction: "in" | "out";
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawTransfer[]>;
  /** Resolves without `decimals` when the contract has none; THROWS when the
   *  RPC could not be asked, so the caller holds the window. */
  tokenInfo(address: `0x${string}`): Promise<TokenInfo>;
}

export interface SyncOptions {
  value?: (q: ValuationQuery) => Promise<ValuationResult>;
  lists?: () => Promise<TokenListsResult>;
  now?: () => string;
}

/** The app chain's own EURe deployment counts as e-money too. */
function appChainEmoney(): Record<number, Record<string, string>> | undefined {
  try {
    return { [CHAIN_ID]: { [loadDeployments(CHAIN_ID).eure.toLowerCase()]: "EURe" } };
  } catch {
    return undefined;
  }
}

/** Thrown to hold the window: nothing in it is written, the cursor stays. */
class HoldWindow extends Error {}

/** The first block whose timestamp is at or after `iso`. Binary search over
 *  block times: about 25 reads on mainnet. */
export async function firstBlockAtOrAfter(reader: ChainReader, iso: string, head: bigint): Promise<bigint> {
  const target = Date.parse(iso);
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (Date.parse(await reader.getBlockTime(mid)) >= target) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/**
 * The error as the wallet row may show it. viem puts the request URL in its
 * messages, and a hosted RPC URL is its API key; members with `wallets.read`
 * see this text. Short message only, every URL removed.
 */
export function publicSyncError(e: unknown): string {
  // A Node transport error names the host ("getaddrinfo ENOTFOUND key.provider.com",
  // "connect ECONNREFUSED 10.0.0.2:8545"), and some providers put the key in
  // the host. Only viem's short message, or a message this module wrote
  // itself, is shown; anything else is summarised.
  if (!(e instanceof BaseError) && !(e instanceof HoldWindow) && !(e instanceof SyncRefusal)) {
    return "the network did not answer";
  }
  const raw = String((e as any)?.shortMessage ?? (e as any)?.message ?? e);
  const firstLine = raw.split("\n").find((l) => l.trim()) ?? "sync failed";
  return firstLine
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[address removed]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[address removed]")
    .slice(0, 200);
}

/** An error this module raised with text written for the wallet row. */
export class SyncRefusal extends Error {}

function patchSync(walletId: string, sync: Partial<ImportedWallet["sync"]>): boolean {
  const current = store.findImportedWallet(walletId);
  if (!current) return false;
  store.updateImportedWallet(walletId, { sync: { ...current.sync, ...sync } });
  return true;
}

/** Addresses the org holds, other than this wallet: its other imported
 *  wallets and its Zold accounts (on the app chain). */
function ownAddressesOf(wallet: ImportedWallet) {
  return [
    ...store
      .importedWalletsOf(wallet.orgId)
      .filter((w) => w.id !== wallet.id)
      .map((w) => ({ chainId: w.chainId, address: w.address })),
    ...store.accounts
      .filter((a) => a.orgId === wallet.orgId && a.address)
      .map((a) => ({ chainId: CHAIN_ID, address: a.address! })),
  ];
}

/** One window's transfers, in and out, each log once, in chain order. */
async function windowTransfers(reader: ChainReader, wallet: ImportedWallet, fromBlock: bigint, toBlock: bigint) {
  const [inbound, outbound] = await Promise.all([
    reader.getTransferLogs({ address: wallet.address, direction: "in", fromBlock, toBlock }),
    reader.getTransferLogs({ address: wallet.address, direction: "out", fromBlock, toBlock }),
  ]);
  const seen = new Map<string, RawTransfer>();
  for (const t of [...inbound, ...outbound]) seen.set(`${t.txHash.toLowerCase()}:${t.logIndex}`, t);
  return [...seen.values()].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
}

/** The largest window from `fromBlock` the RPC will answer. */
async function readWindow(reader: ChainReader, wallet: ImportedWallet, fromBlock: bigint, safeHead: bigint) {
  const { toBlock, result } = await readLogWindow(fromBlock, safeHead, WALLET_SYNC.maxBlockSpan, (from, to) => windowTransfers(reader, wallet, from, to));
  return { toBlock, transfers: result };
}

export async function syncWallet(
  wallet: ImportedWallet,
  reader: ChainReader,
  opts: SyncOptions = {},
): Promise<{ added: number; skipped: number }> {
  const now = opts.now ?? (() => new Date().toISOString());
  const value = opts.value ?? valueTransfer;
  const loadLists = opts.lists ?? (() => loadTokenLists());
  let listsOnce: Promise<TokenListsResult> | undefined;
  const extraEmoney = appChainEmoney();
  let added = 0;
  let skipped = 0;
  try {
    const own = ownAddressesOf(wallet);
    if (wallet.chainId === CHAIN_ID && store.accounts.some((a) => a.orgId === wallet.orgId && a.address?.toLowerCase() === wallet.address.toLowerCase())) {
      patchSync(wallet.id, { status: "error", error: "This is the organisation's own Zold account, which is already in the books." });
      return { added, skipped };
    }
    const reported = await reader.getChainId();
    if (reported !== wallet.chainId) {
      throw new SyncRefusal(`the RPC configured for chain ${wallet.chainId} reports chain ${reported}`);
    }
    const head = await reader.getBlockNumber();
    const safeHead = head - BigInt(WALLET_SYNC.confirmations);
    if (safeHead < 0n) return { added, skipped };

    let cursor: bigint;
    if (wallet.sync.cursor !== undefined) {
      cursor = BigInt(wallet.sync.cursor);
    } else if (wallet.sync.from) {
      cursor = (await firstBlockAtOrAfter(reader, `${wallet.sync.from}T00:00:00.000Z`, safeHead)) - 1n;
    } else {
      patchSync(wallet.id, { cursor: safeHead.toString(), status: "synced", lastSyncedAt: now(), error: undefined });
      return { added, skipped };
    }

    const known = new Set(store.ledgerOf(wallet.orgId).map((e) => e.id));
    const blockTimes = new Map<bigint, string>();
    const tokens = new Map<string, TokenInfo>();
    for (let w = 0; w < WALLET_SYNC.windowsPerTick && cursor < safeHead; w++) {
      const fromBlock = cursor + 1n;
      const { toBlock, transfers } = await readWindow(reader, wallet, fromBlock, safeHead);

      const contacts = store.contactsOf(wallet.orgId);
      const fresh: LedgerEntry[] = [];
      let windowSkipped = 0;
      let lastSkipReason: string | undefined;
      for (const t of transfers) {
        if (known.has(walletEntryId(wallet.orgId, wallet.address, wallet.chainId, t.txHash, t.logIndex))) continue;
        const blockTime = t.blockTime ?? blockTimes.get(t.blockNumber) ?? (await reader.getBlockTime(t.blockNumber));
        blockTimes.set(t.blockNumber, blockTime);
        const tokenKey = t.token.toLowerCase();
        const token = tokens.get(tokenKey) ?? (await reader.tokenInfo(t.token));
        tokens.set(tokenKey, token);

        const countable = usableDecimals(token.decimals) && t.valueUnits > 0n;
        // E-money is at par and needs no list; everything else is classed by
        // the lists, which are loaded once per run and only when needed.
        let tokenClass: TokenClass | undefined = emoneySymbol(wallet.chainId, t.token, extraEmoney) ? "emoney" : undefined;
        if (!tokenClass && countable) {
          const lists = await (listsOnce ??= loadLists());
          if (!lists.ok) throw new HoldWindow(`Waiting for the token lists: ${lists.reason}.`);
          tokenClass = classifyToken(wallet.chainId, t.token, lists.lists.has, extraEmoney);
        }
        const amount = countable ? Number(formatUnits(t.valueUnits, token.decimals as number)) : 0;
        const valuation: ValuationResult | undefined =
          !countable || tokenClass === "unlisted"
            ? undefined
            : tokenClass === "emoney"
              ? { ok: true, valuation: { eurPerUnit: 1, eurValue: Math.round(amount * 100) / 100, source: "EURe e-money at par", asOf: blockTime.slice(0, 10), symbol: "EURe" } }
              : await value({ chainId: wallet.chainId, token: t.token, amount, blockTime });
        if (valuation && !valuation.ok && valuation.transient) throw new HoldWindow(`Waiting for a price: ${valuation.reason}.`);
        const r = toWalletEntry({
          wallet,
          tokenClass: tokenClass ?? "unlisted",
          transfer: { ...t, blockTime },
          token,
          valuation: valuation?.ok ? valuation.valuation : undefined,
          valuationFailure: valuation && !valuation.ok ? valuation.reason : undefined,
          contacts,
          ownAddresses: own,
          now: now(),
        });
        if ("skip" in r) {
          // Self-transfers and zero values book nothing by design. A token
          // that will not say its decimals is a gap in the books: counted.
          if (token.decimals === undefined) {
            windowSkipped++;
            lastSkipReason = `${r.skip} (${walletEntryKey(wallet.address, wallet.chainId, t.txHash, t.logIndex)})`;
          }
          continue;
        }
        known.add(r.entry.id);
        fresh.push(r.entry);
      }

      // Removed while we read the chain: book nothing for it.
      if (!store.findImportedWallet(wallet.id)) return { added, skipped };
      store.batched(() => {
        if (fresh.length) store.addLedgerEntries(applyRules(store.rulesOf(wallet.orgId), fresh).entries);
        const prior = store.findImportedWallet(wallet.id)?.sync.skipped ?? 0;
        patchSync(wallet.id, {
          cursor: toBlock.toString(),
          status: toBlock >= safeHead ? "synced" : "syncing",
          lastSyncedAt: now(),
          error: undefined,
          ...(windowSkipped ? { skipped: prior + windowSkipped, lastSkipReason } : {}),
        });
      });
      added += fresh.length;
      skipped += windowSkipped;
      cursor = toBlock;
    }
    return { added, skipped };
  } catch (e) {
    const shown = e instanceof HoldWindow ? e.message : publicSyncError(e);
    if (!(e instanceof HoldWindow)) console.error(`wallet sync: ${wallet.id} on chain ${wallet.chainId}: ${shown}`);
    patchSync(wallet.id, { status: "error", error: shown });
    return { added, skipped };
  }
}

// ── The live reader and the poll ────────────────────────────────────────────

const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
} as const;

const ERC20_META = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/** The contract answered, and the answer is unusable: no such function, or
 *  return data that does not decode (a token anyone can deploy may answer
 *  `decimals()` with one byte, and that must not hold the window forever).
 *  A lasting fact about the token. Anything else (timeout, 429, a dropped
 *  connection) is the RPC, and is thrown. */
export function contractHasNo(e: unknown): boolean {
  return (
    e instanceof BaseError &&
    Boolean(
      e.walk(
        (x) =>
          x instanceof ContractFunctionRevertedError ||
          x instanceof ContractFunctionZeroDataError ||
          /^(Abi|InvalidAbi).*Error$/.test((x as { name?: string })?.name ?? ""),
      ),
    )
  );
}

/** Token metadata never changes; only a complete answer is cached. */
const tokenCache = new Map<string, TokenInfo>();

export function viemReader(chainId: number, rpcUrl: string): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000 }) });
  const read = async <T>(address: `0x${string}`, functionName: "decimals" | "symbol"): Promise<T | undefined> => {
    try {
      return (await client.readContract({ address, abi: ERC20_META, functionName })) as T;
    } catch (e) {
      if (contractHasNo(e)) return undefined;
      throw e;
    }
  };
  // A chain id never changes under one URL; asking every tick is RPC quota.
  let chainIdOnce: Promise<number> | undefined;
  return {
    getChainId: () => (chainIdOnce ??= client.getChainId().catch((e) => { chainIdOnce = undefined; throw e; })),
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async getBlockTime(blockNumber) {
      const b = await client.getBlock({ blockNumber });
      return new Date(Number(b.timestamp) * 1000).toISOString();
    },
    async getTransferLogs({ address, direction, fromBlock, toBlock }) {
      // strict: an NFT's Transfer has the same topic with three indexed
      // arguments; it does not decode against this event and is dropped.
      const logs = await client.getLogs({
        event: TRANSFER_EVENT,
        args: direction === "in" ? { to: address } : { from: address },
        fromBlock,
        toBlock,
        strict: true,
      });
      return logs
        .filter((l) => l.transactionHash && l.logIndex != null && l.blockNumber != null)
        .map((l) => ({
          chainId,
          token: l.address,
          from: l.args.from,
          to: l.args.to,
          valueUnits: l.args.value,
          txHash: l.transactionHash!,
          logIndex: Number(l.logIndex),
          blockNumber: l.blockNumber!,
        }));
    },
    async tokenInfo(address) {
      const key = `${chainId}:${address.toLowerCase()}`;
      const hit = tokenCache.get(key);
      if (hit) return hit;
      const decimals = await read<number>(address, "decimals");
      // A symbol that is not a string (old bytes32 tokens) is only a label.
      const symbol = await read<unknown>(address, "symbol").catch(() => undefined);
      const info: TokenInfo = {
        address,
        ...(typeof symbol === "string" ? { symbol: cleanSymbol(symbol) } : {}),
        ...(usableDecimals(decimals) ? { decimals } : {}),
      };
      if (info.decimals !== undefined) tokenCache.set(key, info);
      return info;
    },
  };
}

const readers = new Map<number, ChainReader>();
let polling = false;

/** One pass over every imported wallet. One at a time, like the deposit scan;
 *  one wallet's failure is on its own row and does not stop the others. */
export async function pollWalletSyncOnce(): Promise<number> {
  if (!WALLET_SYNC.enabled || polling) return 0;
  polling = true;
  try {
    let added = 0;
    for (const wallet of [...store.importedWallets]) {
      const rpc = WALLET_SYNC.rpcs[wallet.chainId];
      if (!rpc) {
        const error = `Zold does not read network ${wallet.chainId} yet, so nothing from this wallet is booked.`;
        if (wallet.sync.error !== error) {
          console.log(`wallet sync: ${wallet.id} is on chain ${wallet.chainId}, which has no WALLET_SYNC_RPC_${wallet.chainId}`);
          patchSync(wallet.id, { status: "error", error });
        }
        continue;
      }
      if (!readers.has(wallet.chainId)) readers.set(wallet.chainId, viemReader(wallet.chainId, rpc));
      added += (await syncWallet(wallet, readers.get(wallet.chainId)!)).added;
    }
    return added;
  } finally {
    polling = false;
  }
}

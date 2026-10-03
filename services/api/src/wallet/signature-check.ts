/**
 * Whether an address signed a text message, asked of the chain it lives on.
 *
 * The one verifier for signed messages: the Safe attestation on a document
 * (routes/documents.ts) and the ownership proof of an imported wallet
 * (wallet-sync/ownership.ts) both come here.
 *
 * - An address with code is a contract wallet: its own
 *   `isValidSignature(hashMessage(text), signature)` decides (EIP-1271). A
 *   Safe answers for owner signatures and for a message it signed on chain
 *   (SignMessageLib), whose signature is empty.
 * - An address with no code, or with an EIP-7702 delegation, is an ordinary
 *   key: the signature must recover to it.
 * - A signature wrapped for a contract not yet deployed (ERC-6492) goes to
 *   viem's universal validator.
 *
 * Fails closed, and says which way: `rejected` is the chain's answer (or the
 * signature's own arithmetic) that this is not a valid signature; anything
 * else, a node that errors, times out or cannot be reached, is `unverified`,
 * never valid. The code is read first for that reason: viem's own
 * verifyMessage falls back to ECDSA when its chain call fails, which would
 * treat an unreachable chain as an answer.
 *
 * Reasons never carry the node's error text: a hosted RPC URL is its key.
 */
import {
  BaseError,
  encodeFunctionData,
  hashMessage,
  isAddressEqual,
  isErc6492Signature,
  parseErc6492Signature,
  recoverMessageAddress,
  type Hex,
  type PublicClient,
} from "viem";

export const EIP1271_MAGIC = "0x1626ba7e";
/** The whole first return word: the magic value, then zeros. A contract that
 *  echoes its calldata starts with the selector too, and is not a yes. */
const MAGIC_WORD = `${EIP1271_MAGIC}${"0".repeat(56)}`;

const ERC1271_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }],
    outputs: [{ type: "bytes4" }],
  },
] as const;

export type SignatureCheck =
  | { verdict: "valid"; method: "eip1271" | "ecdsa" }
  | { verdict: "rejected"; method: "eip1271" | "ecdsa"; reason: string }
  | { verdict: "unverified"; reason: string };

/** What the check needs from a chain client. */
export type SignatureClient = Pick<PublicClient, "getCode" | "call" | "verifyMessage">;

export interface SignedMessage {
  address: `0x${string}`;
  message: string;
  signature: Hex;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The node says the call reverted: JSON-RPC code 3, or an error carrying
 * revert data. A node's own failure (a -32603 internal error with no data, a
 * timeout, a dropped connection) is not the wallet refusing.
 */
function chainSaidNo(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const coded = e.walk((x) => typeof (x as { code?: unknown })?.code === "number") as { code?: number } | null;
  const withData = e.walk((x) => "data" in (x as object)) as { data?: unknown } | null;
  const raw = typeof withData?.data === "string" ? withData.data : (withData?.data as { data?: unknown } | undefined)?.data;
  const hasRevertData = typeof raw === "string" && /^0x[0-9a-fA-F]{2,}/.test(raw);
  if (coded?.code !== 3 && !hasRevertData) return undefined;
  const reason = /reverted with reason string '([^']{0,80})'|reverted: (.{0,80})$/m.exec(e.shortMessage ?? "") ?? undefined;
  return reason ? `the wallet refused the signature (${(reason[1] ?? reason[2]).trim()})` : "the wallet refused the signature";
}

async function check(client: SignatureClient, m: SignedMessage, expect?: "eip1271" | "ecdsa"): Promise<SignatureCheck> {
  let code: Hex | undefined;
  try {
    code = await client.getCode({ address: m.address });
  } catch {
    return { verdict: "unverified", reason: "the network did not answer" };
  }
  const isContract = Boolean(code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100"));

  if (!isContract && m.signature.length > 66 && isErc6492Signature(m.signature)) {
    // A counterfactual contract wallet: viem deploys it in a simulated call.
    // viem answers false for a node failure on this path as well as for a
    // refusal, so only "valid" is an answer here; anything else is unverified.
    try {
      const ok = await client.verifyMessage({ address: m.address, message: m.message, signature: m.signature });
      if (ok) return { verdict: "valid", method: "eip1271" };
    } catch {
      // fall through
    }
    return { verdict: "unverified", reason: "the wallet is not deployed, and its signature could not be confirmed" };
  }

  // A proof made by a contract wallet is not re-judged as a plain key because
  // a node shows no code (a node behind the deploy block, say).
  if (!isContract && expect === "eip1271") {
    return { verdict: "unverified", reason: "the network shows no wallet contract at this address" };
  }

  if (!isContract) {
    try {
      const signer = await recoverMessageAddress({ message: m.message, signature: m.signature });
      return isAddressEqual(signer, m.address)
        ? { verdict: "valid", method: "ecdsa" }
        : { verdict: "rejected", method: "ecdsa", reason: "the signature is not this address's" };
    } catch {
      return { verdict: "rejected", method: "ecdsa", reason: "the signature is not a valid signature" };
    }
  }

  // A wallet proven while it was not deployed keeps its ERC-6492 wrapper;
  // once deployed, the wallet itself judges the inner signature.
  const signature = m.signature.length > 66 && isErc6492Signature(m.signature) ? parseErc6492Signature(m.signature).signature : m.signature;
  try {
    const { data } = await client.call({
      to: m.address,
      data: encodeFunctionData({ abi: ERC1271_ABI, functionName: "isValidSignature", args: [hashMessage(m.message), signature] }),
    });
    if (!data || data === "0x") return { verdict: "rejected", method: "eip1271", reason: "the wallet does not answer EIP-1271" };
    return data.slice(0, 66).toLowerCase() === MAGIC_WORD
      ? { verdict: "valid", method: "eip1271" }
      : { verdict: "rejected", method: "eip1271", reason: "the wallet answered that the signature is not valid" };
  } catch (e) {
    const no = chainSaidNo(e);
    return no ? { verdict: "rejected", method: "eip1271", reason: no } : { verdict: "unverified", reason: "the network did not answer" };
  }
}

/** Check a signed text message against the chain `client` reads. */
export async function checkSignedMessage(
  client: SignatureClient,
  m: SignedMessage,
  opts: { timeoutMs?: number; expect?: "eip1271" | "ecdsa" } = {},
): Promise<SignatureCheck> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<SignatureCheck>((resolve) => {
    timer = setTimeout(
      () => resolve({ verdict: "unverified", reason: "the network did not answer in time" }),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([check(client, m, opts.expect), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

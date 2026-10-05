/**
 * Bring an existing Safe into Zold instead of deploying a new one.
 *
 * Two steps, and the chain decides the second:
 * - `prepare` checks the account may still change Safes and that the target
 *   has the shape Zold can sign for, then hands back the passkey's verifier
 *   address and the owner change the Safe's current owner must send
 *   (scripts/safe-import-owner-tx.ts builds the same thing offline). Nothing
 *   is stored.
 * - `confirm` reads the Safe again and binds it only when the verifier is an
 *   owner and every check in wallet/safe-import.ts passes. An RPC failure
 *   binds nothing.
 *
 * Never replaces a live Safe: once the account's own passkey Safe is active,
 * deployed, or holds anything, both routes refuse.
 */
import express from "express";
import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi } from "viem";
import { HARNESS } from "../config.js";
import { addrs } from "../chain.js";
import { store, type User } from "../store.js";
import { ADDRESS_RE } from "../domain/contacts.js";
import { partnerTimeout } from "../http.js";
import { requireCapability } from "../http/guards.js";
import { publicUser } from "../users/public-user.js";
import { wrap } from "./util.js";
import { CANDIDE, webauthnOwnerFromStore } from "../wallet/candide.js";
import { deployVerifierForOwner, relayReader } from "../recovery/recovered-passkey.js";
import {
  SafeImportRefusal,
  assertImportableShape,
  checkSafeForImport,
  jsonRpcReader,
  ownerChangeTransaction,
  passkeyVerifierAddress,
  readSafeForImport,
  verifierDeploymentTransaction,
  type ChainReader,
} from "../wallet/safe-import.js";
import { ownerChangeTxBuilderJson, txBuilderFileName } from "../wallet/safe-tx-builder.js";

export interface SafeImportDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
  /** Tests pass canned chain answers; production reads the smart-account chain. */
  reader?: () => ChainReader;
  /** Tests skip the relayed verifier deployment. */
  deployVerifier?: (owner: { x: bigint; y: bigint }) => Promise<string | undefined>;
  /** Tests name the tokens; production reads EURe and USDC from deployments.json. */
  tokens?: () => Hex[];
  /** Tests fix the Transaction Builder file's createdAt. */
  now?: () => number;
}

type Hex = `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000";
/** Chosen, not measured: up to 20 s for the RPC to show the verifier's code. */
const VERIFIER_RECEIPT_TIMEOUT_MS = 60_000;
const VERIFIER_CODE_POLLS = 10;
const VERIFIER_CODE_POLL_MS = 2_000;
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

class Refusal extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
  }
}

const tx = (t: { to: string; value: bigint; data: string }) => ({ to: t.to, value: t.value.toString(), data: t.data });

export function createSafeImportRouter(deps: SafeImportDeps) {
  const router = express.Router();
  const reader = deps.reader ?? (() => jsonRpcReader(CANDIDE.rpcUrl, () => partnerTimeout()));
  const deployVerifier = deps.deployVerifier ?? deployVerifierForOwner;
  const tokens = deps.tokens ?? (() => [addrs().eure, addrs().usdc]);
  const now = deps.now ?? Date.now;

  /** Anything at `address` on the smart-account chain: ETH, EURe or USDC. */
  const holdsFunds = async (r: ChainReader, address: Hex): Promise<boolean> => {
    if ((await r.getBalance(address)) > 0n) return true;
    for (const token of tokens()) {
      const raw = await r.call(token, encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [address] }));
      if ((decodeFunctionResult({ abi: ERC20, functionName: "balanceOf", data: raw }) as bigint) > 0n) return true;
    }
    return false;
  };

  /**
   * The account may still take an existing Safe: a passkey, a plan that was
   * never activated or deployed, and nothing sitting at its counterfactual
   * address (money there would be stranded once the plan is replaced).
   */
  const eligible = async (user: User, r: ChainReader, target: string) => {
    if (HARNESS.enabled) throw new Refusal(409, "importing a Safe needs a real chain — the local harness has none", "NO_CHAIN");
    const plan = user.passkeySafe;
    if (!user.passkey?.publicKey || !plan) throw new Refusal(409, "register a passkey before importing a Safe", "NO_PASSKEY");
    if (plan.status === "active") {
      throw new Refusal(409, "this account already has an active Safe; an import never replaces a live Safe", "SAFE_ACTIVE");
    }
    if (!ADDRESS_RE.test(target) || target.toLowerCase() === ZERO) throw new Refusal(400, "address must be a 0x address", "BAD_ADDRESS");
    const address = getAddress(target) as Hex;
    if (address.toLowerCase() === plan.address.toLowerCase()) {
      throw new Refusal(400, "that is this account's own planned Safe — deploy it instead", "OWN_PLAN");
    }
    const other = store.findUserByAddress(address) ??
      store.users.find((u) => u.id !== user.id && u.passkeySafe?.address.toLowerCase() === address.toLowerCase());
    if (other && other.id !== user.id) throw new Refusal(409, "another account is already bound to that Safe", "ADDRESS_IN_USE");
    const planCode = await r.getCode(plan.address);
    if (planCode && planCode !== "0x") {
      throw new Refusal(409, "this account's own Safe is already deployed; an import never replaces a live Safe", "SAFE_DEPLOYED");
    }
    // A new account's address is the zero address until its Safe exists, and
    // the zero address holds burned ETH on every chain: it is never theirs.
    for (const a of new Set([plan.address.toLowerCase(), user.address.toLowerCase()].filter((a) => a !== ZERO))) {
      if (await holdsFunds(r, a as Hex)) {
        throw new Refusal(409, `${a} holds funds; move them before binding the account to another Safe`, "PLAN_HAS_FUNDS");
      }
    }
    const owner = webauthnOwnerFromStore(plan.passkeyPublicKey);
    return { plan, address, owner, verifier: passkeyVerifierAddress(owner.x, owner.y) };
  };

  const answer = (res: express.Response, err: unknown) => {
    if (err instanceof Refusal || err instanceof SafeImportRefusal) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    // A failed read is not an answer: nothing was bound.
    return res.status(502).json({ error: `chain read failed, nothing was changed: ${(err as any)?.message ?? err}`, code: "RPC_FAILED" });
  };

  const userFor = (req: express.Request, res: express.Response): User | undefined => {
    const user = store.findUser(req.params.id);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return undefined;
    }
    if (!deps.requireUserSession(req, res, user.id)) return undefined;
    if (!requireCapability(user, "safe", res)) return undefined;
    return user;
  };

  router.post(
    "/users/:id/safe/import/prepare",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      try {
        const r = reader();
        const { address, owner, verifier } = await eligible(user, r, String(req.body?.address ?? "").trim());
        const state = await readSafeForImport(r, address);
        // Refuse now what confirm would refuse later, before anyone signs.
        assertImportableShape(state);
        const verifierCode = await r.getCode(verifier);
        const verifierDeployed = Boolean(verifierCode && verifierCode !== "0x");
        const alreadyOwner = state.owners.some((o) => o.toLowerCase() === verifier.toLowerCase());
        const deploy = verifierDeployed ? null : verifierDeploymentTransaction(owner.x, owner.y);
        const createdAt = now();
        const changes: Record<string, unknown> = {};
        if (!alreadyOwner) {
          for (const mode of ["add", "swap"] as const) {
            try {
              const c = ownerChangeTransaction({ safe: address, owners: state.owners, threshold: state.threshold, verifier, mode });
              changes[mode] = {
                ...tx(c),
                resultOwners: c.resultOwners,
                // The browser only downloads this; it cannot build it.
                txBuilder: {
                  fileName: txBuilderFileName(address, CANDIDE.chainId.toString()),
                  json: ownerChangeTxBuilderJson({
                    chainId: CANDIDE.chainId.toString(), safe: address, owners: state.owners, verifier, mode, change: c, deploy, createdAt,
                  }),
                },
              };
            } catch (err: any) {
              changes[mode] = { refused: err?.message ?? String(err) };
            }
          }
        }
        res.json({
          safeAddress: address,
          chainId: Number(CANDIDE.chainId),
          owners: state.owners,
          threshold: state.threshold,
          verifier,
          verifierDeployed,
          alreadyOwner,
          // Any key may send this; confirm also sends it from the deployer if needed.
          deployVerifier: deploy ? tx(deploy) : null,
          ownerChange: alreadyOwner ? null : changes,
          script: `npm run safe:import-tx -- --chain ${CANDIDE.chainId} --safe ${address} --verifier ${verifier}`,
        });
      } catch (err) {
        answer(res, err);
      }
    }),
  );

  router.post(
    "/users/:id/safe/import/confirm",
    wrap(async (req, res) => {
      const user = userFor(req, res);
      if (!user) return;
      let bound: User;
      try {
        const r = reader();
        const { plan, address, owner, verifier } = await eligible(user, r, String(req.body?.address ?? "").trim());
        try {
          await checkSafeForImport(r, address, verifier);
        } catch (err) {
          if (!(err instanceof SafeImportRefusal) || err.code !== "VERIFIER_NO_CODE") throw err;
          // Every other check passed. The verifier is a permissionless
          // factory deployment; send it, wait for it, then check everything again.
          const hash = await deployVerifier(owner);
          if (!hash) throw err;
          // Bounded under Cloudflare's 100 s: past it the caller gets a 524
          // while this carries on. A slow block is "try again", not an error;
          // a retry finds the verifier deployed and goes straight through. 409,
          // not 504: Cloudflare replaces an origin 5xx body with its own page.
          const receipt = await relayReader()
            .waitForTransactionReceipt({ hash: hash as Hex, timeout: VERIFIER_RECEIPT_TIMEOUT_MS })
            .catch(() => {
              throw new Refusal(409, "the verifier deployment is still confirming on chain; try again in a minute", "VERIFIER_PENDING");
            });
          if (receipt.status !== "success") throw err;
          // A load-balanced RPC can answer from a node behind the receipt
          // (seen on sepolia.base.org). Wait for the code, bounded; still
          // missing afterwards is the same refusal.
          for (let i = 0; i < VERIFIER_CODE_POLLS; i++) {
            const code = await r.getCode(verifier);
            if (code && code !== "0x") break;
            await new Promise((ok) => setTimeout(ok, VERIFIER_CODE_POLL_MS));
          }
          await checkSafeForImport(r, address, verifier);
        }
        const now = new Date().toISOString();
        const alreadyBound = store.findUserByAddress(address) ??
          store.users.find((u) => u.id !== user.id && u.passkeySafe?.address.toLowerCase() === address.toLowerCase());
        if (alreadyBound && alreadyBound.id !== user.id) {
          throw new Refusal(409, "another account is already bound to that Safe", "ADDRESS_IN_USE");
        }
        bound = store.updateUser(user.id, {
          address,
          wallet: { type: "candide-safe", deployed: true },
          passkeySafe: {
            address,
            status: "active",
            threshold: 1,
            passkeyPublicKey: plan.passkeyPublicKey,
            createdAt: plan.createdAt,
            previousAddress: plan.address,
            importedAt: now,
          },
        });
      } catch (err) {
        return answer(res, err);
      }
      // Same next step as a fresh deployment: the IBAN link is a passkey
      // ceremony the client drives ("Activate IBAN with passkey").
      if (bound.kycStatus === "approved" && !bound.iban && bound.funding?.status !== "active") {
        bound = store.updateUser(user.id, {
          funding: {
            ...(bound.funding ?? {}),
            mode: "sandbox",
            status: "provisioning",
            detail: "Safe imported — approve IBAN issuance with your passkey",
          },
        });
      }
      res.status(201).json(publicUser(bound));
    }),
  );

  return router;
}

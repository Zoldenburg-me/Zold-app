/**
 * Who signs for a company org's Safe (design note §2.2, §7.3(11)): the Safe's
 * owners as the chain has them, joined to the org's members. No I/O; the
 * reads are wallet/org-signers.ts.
 *
 * The chain is the truth: an address signs iff the Safe lists it. A member is
 * matched first by the address their login passkey signs as, then by the
 * address Zold last added for them (Member.signerAddress, a label). The label
 * names an old owner after a passkey change; it never makes anyone a signer,
 * and signerRefusal (domain/safe-op-queue.ts) stays the one rule for who may
 * sign. An owner no member matches is listed, never hidden.
 */
import type { Member } from "./types.js";

type Address = `0x${string}`;

/** One member as the join needs them; built by wallet/org-signers.ts. */
export interface SignerMember {
  memberId: string;
  role: Member["role"];
  status: Member["status"];
  name?: string;
  /** Has a login: an invited member who has not accepted has none. */
  hasUser: boolean;
  /** The address their login passkey signs as; null without a P-256 passkey. */
  passkeyAddress: Address | null;
  /** Member.signerAddress. */
  label?: Address;
}

/**
 * Why an on-chain owner is not simply "this member signs":
 *  - passkey_changed: Zold added it for this member, whose login passkey now
 *    signs as another address; the Safe still lists the old one
 *  - not_an_owner: the member is deactivated or no longer has the owner role,
 *    and the Safe still lists their key
 *  - added_outside_zold: no member of this org; added in Safe{Wallet}
 */
export type OwnerNote = "passkey_changed" | "not_an_owner" | "added_outside_zold";

export interface OrgSigners {
  owners: { address: Address; memberId?: string; name?: string; note?: OwnerNote }[];
  /** The owners no member matches. */
  unknown: Address[];
  /** Every active owner member, signer or not. `passkey: false` is "no
   *  passkey yet"; `onChain: false` with a passkey is "not a signer". */
  members: { memberId: string; name?: string; passkey: boolean; signerAddress: Address | null; onChain: boolean; oldSignerOnChain?: Address }[];
}

const low = (a: string) => a.toLowerCase();
const isOwnerMember = (m: SignerMember) => m.status === "active" && m.role === "owner";

export function orgSigners(members: readonly SignerMember[], chainOwners: readonly Address[]): OrgSigners {
  const onChain = new Set(chainOwners.map(low));
  // First member wins an address: two members with one key are one owner.
  const first = (pick: (m: SignerMember) => Address | null | undefined, which: (m: SignerMember) => boolean) => {
    const map = new Map<string, SignerMember>();
    for (const m of members) {
      const a = which(m) ? pick(m) : undefined;
      if (a && !map.has(low(a))) map.set(low(a), m);
    }
    return map;
  };
  const signer = first((m) => m.passkeyAddress, isOwnerMember);
  const former = first((m) => m.passkeyAddress, (m) => !isOwnerMember(m) && m.hasUser);
  const labelled = first((m) => m.label, (m) => m.hasUser);

  const owners: OrgSigners["owners"] = chainOwners.map((address) => {
    const k = low(address);
    const s = signer.get(k);
    if (s) return { address, memberId: s.memberId, name: s.name };
    const l = labelled.get(k);
    const f = former.get(k) ?? (l && !isOwnerMember(l) ? l : undefined);
    if (f) return { address, memberId: f.memberId, name: f.name, note: "not_an_owner" };
    if (l) return { address, memberId: l.memberId, name: l.name, note: "passkey_changed" };
    return { address, note: "added_outside_zold" };
  });

  return {
    owners,
    unknown: owners.filter((o) => o.note === "added_outside_zold").map((o) => o.address),
    members: members.filter((m) => isOwnerMember(m) && m.hasUser).map((m) => {
      const old = m.label && low(m.label) !== low(m.passkeyAddress ?? "") && onChain.has(low(m.label)) ? m.label : undefined;
      return {
        memberId: m.memberId,
        name: m.name,
        passkey: !!m.passkeyAddress,
        signerAddress: m.passkeyAddress,
        onChain: !!m.passkeyAddress && onChain.has(low(m.passkeyAddress)),
        ...(old ? { oldSignerOnChain: old } : {}),
      };
    }),
  };
}

/** The op view's signer list (routes/business/safe-ops.ts): each owner with
 *  the active owner member whose passkey it is, and whether it signed. */
export function opSigners(members: readonly SignerMember[], chainOwners: readonly Address[], signedBy: readonly string[]) {
  const signed = new Set(signedBy.map(low));
  return orgSigners(members, chainOwners).owners.map((o) => ({
    address: o.address,
    ...(o.memberId && !o.note ? { memberId: o.memberId, name: o.name } : {}),
    signed: signed.has(low(o.address)),
  }));
}

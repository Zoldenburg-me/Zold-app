/**
 * What a transfer's owner sees of it. `reviewResolution` is the operator's
 * record (note, operator label, the error it was resolved from) and stays
 * server-side: the owner sees the state it resolved into, which `state`
 * already carries. Every user-facing route returns a transfer through this.
 */
import type { Transfer } from "../store/types.js";

export type UserTransfer = Omit<Transfer, "reviewResolution">;

export function userTransfer(t: Transfer): UserTransfer {
  const { reviewResolution: _operatorOnly, ...visible } = t;
  return visible;
}

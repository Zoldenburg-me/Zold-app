/**
 * Where an account stands, for the operator dashboard.
 *
 * The steps are the onboarding order (AGENTS.md "Identity is Monerium's"):
 * account → passkey → Safe → recovery choice → Monerium connected → IBAN
 * active. `stage` is the first step not done, so an account stuck at Monerium
 * reads as stuck there and not as "pending" in general.
 */
import type { User } from "../store.js";

export const ONBOARDING_STEPS = ["account", "passkey", "safe", "recovery", "monerium", "iban"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function safeIsLive(u: User): boolean {
  return u.passkeySafe?.status === "active" || Boolean(u.wallet?.deployed);
}

/** What the person chose for recovery, and whether the chain has it. */
export function recoveryEnrolment(u: User) {
  const ps = u.passkeySafe;
  const zoldenburg =
    ps?.recoveryChoice?.choice === "declined"
      ? "declined"
      : ps?.recovery?.status === "active"
        ? "active"
        : ps?.recoveryChoice?.choice === "zoldenburg" || ps?.recovery
          ? "pending"
          : "not_asked";
  return {
    zoldenburg: zoldenburg as "active" | "pending" | "declined" | "not_asked",
    chosenAt: ps?.recoveryChoice?.at,
    guardianAddress: ps?.recovery?.guardianAddress,
    enabledAt: ps?.recovery?.enabledAt,
    candide: ps?.candideRecovery
      ? { status: ps.candideRecovery.guardianStatus, channels: ps.candideRecovery.channels.map((c) => c.channel) }
      : undefined,
  };
}

/** Monerium's state for the connected profile, from the snapshot taken at
 *  connect. */
export function moneriumProfileState(u: User): string | undefined {
  const id = u.monerium?.profileId ?? u.funding?.moneriumProfileId;
  const profiles = Array.isArray(u.monerium?.profiles) ? u.monerium!.profiles : [];
  const p = profiles.find((x: any) => x?.id === id) ?? profiles[0];
  return typeof p?.state === "string" ? p.state : undefined;
}

export function onboardingOf(u: User) {
  const enrol = recoveryEnrolment(u);
  const done: Record<OnboardingStep, boolean> = {
    account: true,
    passkey: Boolean(u.passkey || u.passkeySafe?.passkeyPublicKey),
    safe: safeIsLive(u),
    recovery: enrol.zoldenburg !== "not_asked" || enrol.candide?.status === "active",
    monerium: Boolean(u.monerium?.connectedAt),
    iban: u.kycStatus === "approved" && Boolean(u.iban),
  };
  const stage = ONBOARDING_STEPS.find((s) => !done[s]) ?? "active";
  return { stage: stage as OnboardingStep | "active", done };
}

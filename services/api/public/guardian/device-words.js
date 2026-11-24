/* The passkey prompt, named for this device, for the guardian and recovery
   pages. They load their own modules only, so this repeats ui.js's
   Z.byDevice rather than pulling the app's UI kit in. A touch screen is a
   phone or tablet (Face ID or a fingerprint); a computer's prompt may be
   Touch ID, Windows Hello, its password, a phone or a security key, so there
   it is a passkey. Read at render time; outside a browser, the computer's
   wording. */
const onPhone = () => !!globalThis.matchMedia?.("(pointer: coarse)").matches;
export const byDevice = (phone, computer) => (onPhone() ? phone : computer);
export const passkeyName = () => byDevice("Face ID or fingerprint", "passkey");

/* Why a passkey prompt failed, from the WebAuthn error's name, or null for
   any other error. `creating` marks a create(): a security key that is full,
   or cannot store a discoverable passkey, refuses it, and Chromium and Safari
   report that as NotAllowedError, like a cancel, so the computer's wording
   names the key too. app/onboarding.js (obPasskeyRefusal) says the same;
   passkey-prompt-test holds the two equal. */
export function passkeyRefusal(e, creating) {
  if (e?.name === "NotAllowedError") {
    return creating
      ? byDevice("Face ID or fingerprint was cancelled, or it timed out. Try again when you’re ready.",
        "The passkey prompt was cancelled or timed out, or your security key couldn’t save the passkey. Try again, or use this computer’s own passkey or another security key.")
      : byDevice("Face ID or fingerprint was cancelled, or it timed out. Try again when you’re ready.",
        "The passkey prompt was cancelled, or it timed out. Try again when you’re ready.");
  }
  if (creating && (e?.name === "NotSupportedError" || e?.name === "ConstraintError")) {
    return byDevice("This phone can’t save a passkey for Zold. Check that Face ID or a fingerprint is set up, then try again.",
      "This security key can’t save a passkey for Zold: it may be full, or not store passkeys. Use this computer’s own passkey or another security key.");
  }
  if (e?.name === "SecurityError") return "This browser won’t use a passkey on this page’s address. Open Zold from its usual address and try again.";
  return null;
}

/* HTML-escape, for the same two pages (they do not load app/core.js). */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

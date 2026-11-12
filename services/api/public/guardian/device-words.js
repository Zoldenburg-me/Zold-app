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

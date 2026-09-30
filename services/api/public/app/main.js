/**
 * The page's entry points. LAST IN THE LOAD ORDER, and it has to be.
 *
 * Awaiting a fetch first does not guarantee later scripts have run: while the
 * parser waits on a later external script the event loop keeps running, so
 * /api/session can resolve before send.js exists. renderUser() would then hit
 * an undefined renderAutoConvert, resumeSession's catch would take the
 * ReferenceError for a dead session, and a returning user would be signed out.
 *
 * Called from here, every classic script has already executed, so there is no
 * forward reference left to lose the race.
 */
// Sign-in waits for this: which screens exist depends on it.
const capabilitiesLoaded = loadCapabilities();
// An invitation link lands here; it is redeemed once a session exists, so a
// person who first has to create an account keeps the token through signup.
{
  const invite = new URLSearchParams(location.search).get("invite");
  if (invite) {
    try { sessionStorage.setItem("zold-invite", invite); } catch {}
  }
}
resumeSession(capabilitiesLoaded);

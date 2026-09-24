/**
 * The page's entry points. LAST IN THE LOAD ORDER, and it has to be.
 *
 * These used to sit at the end of onboarding.js on the theory that both
 * begin by awaiting a fetch, so everything they touch would exist by the time
 * the fetch came back. That is not a guarantee. While the parser waits on a
 * later external script the event loop keeps running, so /api/session could
 * resolve before send.js had run; renderUser() then hit an undefined
 * renderAutoConvert, and resumeSession's catch took the ReferenceError for a
 * dead session and deleted the stored token. A returning user was signed out.
 *
 * Called from here, every classic script has already executed, so there is no
 * forward reference left to lose the race.
 */
loadCapabilities();
// An invitation link lands here; it is redeemed once a session exists, so a
// person who first has to create an account keeps the token through signup.
{
  const invite = new URLSearchParams(location.search).get("invite");
  if (invite) {
    try { sessionStorage.setItem("zold-invite", invite); } catch {}
  }
}
resumeSession();

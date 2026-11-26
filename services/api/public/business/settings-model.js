/**
 * Settings → Business profile, without the DOM.
 *
 * No imports, so scripts/business-access-test.ts loads it in node.
 */

/** The Settings section a link names in its URL (`?view=settings&sec=monerium`),
 *  so a link opened in a new tab lands where it points; null when none or unknown. */
export const settingsSecFrom = (search) => {
  const sec = new URLSearchParams(search || "").get("sec");
  return sec === "org" || sec === "monerium" || sec === "ai" ? sec : null;
};

/** May this member change the legal form here? An owner of a business org,
 *  only while the API says `entityLocked === false`; a missing flag reads as
 *  locked. PATCH /api/orgs/:id enforces the same. */
export const mayChangeEntity = (org) =>
  org?.type === "business" && org.role === "owner" && org.entityLocked === false;

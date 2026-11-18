/**
 * Settings → Business profile, without the DOM.
 *
 * No imports, so scripts/business-access-test.ts loads it in node.
 */

/** May this member change the legal form here? An owner of a business org,
 *  only while the API says `entityLocked === false`; a missing flag reads as
 *  locked. PATCH /api/orgs/:id enforces the same. */
export const mayChangeEntity = (org) =>
  org?.type === "business" && org.role === "owner" && org.entityLocked === false;

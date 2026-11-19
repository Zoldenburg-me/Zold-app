/**
 * An /api answer Zold did not write, for the ES-module pages (/recovery,
 * /guardian). Whatever stands in front of the API (Cloudflare Access on
 * app.zoldhq.com) answered, so the request never reached Zold and says nothing
 * about the session or the request. Zold's own 401 and 403 always carry
 * { error }. public/ui.js and admin/core.js are classic scripts and keep their
 * own copy of the same rule.
 */
export const isForeignAnswer = (res, data) => {
  if (res.type === "opaqueredirect") return true;
  if (res.status === 401 || res.status === 403) return typeof data?.error !== "string";
  const type = res.headers?.get("content-type");
  return Boolean(res.ok && type && !type.includes("json"));
};

export const UNREACHABLE = "Zold can’t be reached from here. Reload the page, or try again in a minute.";
/** A write may have reached Zold: the person checks before sending it again. */
export const WRITE_UNANSWERED = "Zold didn’t answer this. Reload the page, then check before you try it again.";

/** Throws when Zold did not write this answer; `write` picks the wording. */
export function refuseForeignAnswer(res, data, write) {
  if (!isForeignAnswer(res, data)) return;
  throw Object.assign(new Error(write ? WRITE_UNANSWERED : UNREACHABLE), { foreign: true });
}

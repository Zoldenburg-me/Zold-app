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

const foreignError = (write) => Object.assign(new Error(write ? WRITE_UNANSWERED : UNREACHABLE), { foreign: true });

/** Throws when Zold did not write this answer; `write` picks the wording. */
export function refuseForeignAnswer(res, data, write) {
  if (isForeignAnswer(res, data)) throw foreignError(write);
}

/** The body of an answer Zold wrote, or a throw. Zold answers every 2xx with
 *  JSON, so an empty 2xx (an answer lost on the way) and a body that is not
 *  JSON are not Zold's, whatever the content-type says. */
export async function readAnswer(res, write) {
  const text = await res.text().catch(() => "");
  let data = {};
  if (text.trim()) {
    try { data = JSON.parse(text); } catch { throw foreignError(write); }
  } else if (res.ok) throw foreignError(write);
  refuseForeignAnswer(res, data, write);
  return data ?? {};
}

/** /api/health, or null when Zold did not answer it: a gate's {} has no
 *  capabilities and says nothing about whether recovery is on. */
export const readHealth = (fetchFn = (path) => fetch(path)) =>
  fetchFn("/api/health").then((r) => r.json()).then((h) => (h?.capabilities ? h : null)).catch(() => null);

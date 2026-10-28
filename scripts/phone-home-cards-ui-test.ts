/**
 * The phone app's Home cards from the owner's Stitch design: Invoices (open
 * count, sum still owed, Create invoice), the backup-key set-up step, and
 * Copy IBAN while there is no activity yet.
 *
 * Pins: a draft, a paid or a received invoice is not open; an unread invoice
 * list says so instead of "0 open"; no organisation that may invoice, no
 * card; the backup step appears only after a signers read that worked, is
 * done only with an owner besides the passkey, and never pushes the recovery
 * banner aside; the IBAN is offered only once it is the verified account's.
 *
 * Runs the real classic scripts in load order with a stub DOM. What this
 * cannot show: the screens in a browser. Offline.
 *
 *   npm run phone:home-cards:test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "services/api/public");

const stub: any = new Proxy(function () {}, {
  get: (_t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : stub),
  set: () => true,
  apply: () => stub,
});
const storage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
};
const ctx: any = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob, Intl, TextEncoder, btoa, atob, JSON, Promise,
  addEventListener() {}, removeEventListener() {},
  PublicKeyCredential: function PublicKeyCredential() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  navigator: { userAgent: "test", language: "en", maxTouchPoints: 0, platform: "test" },
  location: { pathname: "/app", search: "", hash: "", host: "zold.test", origin: "https://zold.test", assign() {}, replace() {} },
  history: { state: null, replaceState() {}, pushState() {}, back() {} },
  localStorage: storage(),
  sessionStorage: storage(),
  fetch: () => Promise.reject(new Error("no network in this test")),
  scrollTo() {},
  document: {
    hidden: false,
    getElementById: () => stub,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => stub,
    addEventListener() {},
    body: stub, documentElement: stub, title: "",
  },
};
ctx.window = ctx;
vm.createContext(ctx);
const load = (f: string) => vm.runInContext(readFileSync(path.join(PUB, f), "utf8"), ctx, { filename: f });
load("ui.js");
for (const f of [
  "app/core.js", "app/dashboard.js", "app/transactions.js", "app/profile.js", "app/recovery.js", "app/monerium.js",
  "app/onboarding.js", "app/send.js", "app/signers.js", "app/phone.js", "app/phone-home.js", "app/phone-activity.js",
  "app/phone-send.js", "app/phone-add.js", "app/phone-getpaid.js", "app/phone-more.js", "app/settings.js", "app/desktop.js",
]) load(f);
const run = (code: string) => vm.runInContext(code, ctx);

const SAFE = "0x1111111111111111111111111111111111111111";
const IBAN = "DE89370400440532013000";
const done = {
  id: "u1", name: "Erika Muster", email: "e@example.test", kycStatus: "approved", address: SAFE, balanceEur: 0, iban: IBAN,
  passkey: { credentialId: "cred" }, passkeySafe: { status: "active", address: SAFE },
  monerium: { connectedAt: "2026-10-01T10:00:00Z", method: "oauth", profileId: "p1" }, funding: { mode: "sandbox", status: "active" },
  emailVerifiedAt: "2026-10-01T10:00:00Z",
};
const setUser = (u: any, extra = "") => run(`user = ${JSON.stringify(u)}; caps = { ...caps, sandbox: true }; capsLoaded = true; hist.length = 0; ${extra}`);
const flat = (html: string) => html.replace(/\s+/g, " ");
const home = () => flat(run("PH.home.html()"));

let pass = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); pass++; console.log(`  ok  ${name}`); };
const org = { id: "o1", type: "personal", capabilities: { invoices: { allowed: true } } };
const inv = (state: string, grossCents: number, direction = "outgoing") => ({ state, direction, issued: { grossCents, currency: "EUR" } });

await t("Invoices: counts sent, unpaid invoices and sums what is owed", () => {
  setUser(done, `phCache.signers = { owners: [{ kind: "passkey" }, { kind: "eoa" }] }; phCache.orgs = ${JSON.stringify([org])};
    phCache.invoices = { org: ${JSON.stringify(org)}, list: ${JSON.stringify([inv("LINK_CREATED", 120000), { ...inv("PAYING", 30050), overdue: true }, inv("DRAFT", 99900), inv("PAID", 5000), inv("RECONCILED", 5000), inv("DELETED", 5000), inv("SUBMITTED", 7000, "incoming")])} };`);
  const html = home();
  assert.match(html, /<h2 id="ph-inv-title">Invoices<\/h2><span class="z-fig">2 open<\/span>/);
  assert.match(html, /€1,500\.50 outstanding/);
  assert.match(html, /data-ph-org="o1" [^>]*href="\/business\?view=invoice-new"|href="\/business\?view=invoice-new"[^>]*data-ph-org="o1"|data-ph-org="o1"[^>]*>.*Create invoice/);
});

await t("Invoices: an unread list says so, never 0 open", () => {
  setUser(done, `phCache.invoices = { org: ${JSON.stringify(org)}, error: true };`);
  const html = home();
  assert.match(html, /Your invoices could not be read just now/);
  assert.doesNotMatch(html, /0 open/);
});

await t("Invoices: no organisation that may invoice, no card", () => {
  setUser(done, `phCache.invoices = { org: null };`);
  assert.doesNotMatch(home(), /ph-inv-title/);
});

await t("backup key: offered after a signers read with only the passkey", () => {
  setUser(done, `phCache.signers = { owners: [{ kind: "passkey" }] }; phCache.invoices = { org: null }; localStorage.setItem("zold-hide-recovery-banner:u1", "1");`);
  const html = home();
  assert.match(html, /Add a backup key/);
  assert.match(html, /href="#signers"/);
});

await t("backup key: done with a second owner, and no row when the read failed or is pending", () => {
  setUser(done, `phCache.signers = { owners: [{ kind: "passkey" }, { kind: "eoa" }] }; phCache.invoices = { org: null };`);
  assert.doesNotMatch(home(), /Add a backup key/, "done: the card lists only open steps");
  setUser(done, `phCache.signers = { error: "chain read failed" };`);
  assert.doesNotMatch(home(), /Add a backup key/, "unread: neither done nor missing");
  setUser(done, `phCache.signers = undefined;`);
  assert.doesNotMatch(home(), /Add a backup key/, "not read yet: no row");
});

await t("backup key: the recovery banner keeps its place when only the backup step is open", () => {
  run(`localStorage.clear()`);
  setUser(done, `phCache.signers = { owners: [{ kind: "passkey" }] }; caps = { ...caps, zoldenburgRecovery: true };`);
  const html = home();
  assert.match(html, /Recovery isn’t set up/, "core steps done, recovery off: the banner shows");
  assert.doesNotMatch(html, /Add a backup key/, "the backup step waits until the banner is closed");
});

await t("Copy IBAN: offered while there is no activity, only for the verified account's IBAN", () => {
  setUser(done, `phCache.signers = { owners: [{ kind: "passkey" }, { kind: "eoa" }] }; phCache.invoices = { org: null };`);
  assert.match(home(), new RegExp(`data-z-copy="${IBAN}" aria-label="Copy Your IBAN"`));
  assert.match(home(), /DE89 3704 0044 0532 0130 00/);
  setUser({ ...done, kycStatus: "pending" });
  assert.doesNotMatch(home(), /Copy Your IBAN/, "not verified: no IBAN to copy");
  setUser({ ...done, iban: "" });
  assert.doesNotMatch(home(), /Copy Your IBAN/);
});

await t("Home's reads leave the shared signers cache undefined until they land, and sign-out clears the invoices", async () => {
  setUser(done, `phCache.signers = undefined; phCache.invoices = undefined; phCache.orgs = []; phRoute = { name: "home" };
    __release = null; api = (p) => p.includes("/safe/signers") ? new Promise((ok) => { __release = () => ok({ owners: [{ kind: "passkey" }] }); }) : Promise.resolve({});`);
  const loading = run("phLoadHomeData()");
  assert.equal(run("phCache.signers"), undefined, "Security still sees 'not read yet' and may read it itself");
  run("phLoadHomeData()");
  run("__release()");
  await loading;
  assert.equal(run("phCache.signers.owners.length"), 1);
  assert.deepEqual(JSON.parse(run("JSON.stringify(phCache.invoices)")), { org: null }, "no organisation may invoice: no card, not an error");
  run("phReset()");
  assert.equal(run("phCache.invoices"), undefined);
});

console.log(`phone home cards: ${pass} passed`);

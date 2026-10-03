/**
 * Settings (design canvas "Desk-Settings"): a grouped menu on the left, the
 * chosen section on the right. Organisation, Who approves payments, Monerium
 * and Plan open in place; the other entries are their own screens.
 */
import { Z, api, cap, day, esc, me, org, plain, ROLE_CAN, ROLE_WORD } from "./core.js";
import { META, RENDER } from "./views.js";

const ss = { sec: "org" };
const planName = (id) => `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
const onTrial = () => org.effectivePlan !== org.plan;

META.settings = () => ({ title: "Settings", sub: `${org.name}, on the ${planName(org.effectivePlan)} plan${onTrial() ? " (trial)" : ""}.`, actions: "" });

function menu() {
  const here = (id, label) => `<button type="button" class="zb-set-menu__item" data-ss="${id}"${ss.sec === id ? ' aria-current="true"' : ""}>${esc(label)}</button>`;
  const away = (v, label) => `<a class="zb-set-menu__item" href="?view=${v}" data-view-link="${v}">${esc(label)}${Z.icon("arrow_forward", "zb-set-menu__out")}</a>`;
  const groups = [
    ["Company", [here("org", "Organisation"), cap("invoices").allowed ? away("invoicing-settings", "Invoicing profile") : "", here("plan", "Plan")]],
    ["Team", [away("members", "Members and access"), here("approvals", "Who approves payments")]],
    ["Account", [here("monerium", "Monerium"), `<a class="zb-set-menu__item" href="/app#security">Your sign-in and recovery${Z.icon("open_in_new", "zb-set-menu__out")}<span class="z-sr"> (the app)</span></a>`]],
    ["Connected", [away("apps", "Apps"), away("integrations", "Accounting connections")]],
  ];
  return `<nav class="zb-set-menu" aria-label="Settings">${groups.map(([title, items]) =>
    `<h2 class="z-eyebrow">${title}</h2>${items.join("")}`).join("")}</nav>`;
}

const rows = (list) => `<dl class="zb-set-rows">${list.filter(([, v]) => v).map(([k, v, mono]) =>
  `<div><dt>${esc(k)}</dt><dd${mono ? ' class="z-mono"' : ""}>${esc(v)}</dd></div>`).join("")}</dl>`;

function section(title, sub, body, action = "") {
  return `<section class="z-card zb-pad zb-stack" style="gap:14px" aria-labelledby="set-h">
    <div class="zb-side-card__head"><h2 id="set-h">${esc(title)}</h2>${action}</div>
    ${sub ? `<p class="desc">${esc(sub)}</p>` : ""}${body}</section>`;
}

function orgSection() {
  const a = org.address || {};
  const address = [a.line1, a.line2, [a.postalCode, a.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const country = a.country ? (new Intl.DisplayNames(["en"], { type: "region" }).of(a.country) || a.country) : "";
  const edit = `<a class="z-btn z-btn--secondary z-btn--sm" href="?view=organisation" data-view-link="organisation">Edit</a>`;
  return section("Organisation", "Printed on every invoice you issue. The country decides which invoicing rules apply.",
    rows([["Name", org.name], ["Legal name", org.legalName], ["Address", address], ["Country", country], ["Tax ID", org.taxId, true], ["Notification email", org.notificationEmail]])
    + (address ? "" : `<p class="zb-hint">No address yet. Invoices need one.</p>`), edit);
}

/* What each role may do with a payment, said from ROLE_CAN, the table the
   rest of the console reads. */
const VERBS = [["propose", "drafts", "draft"], ["approve", "approves", "approve"], ["send", "sends", "send"]];
const joined = (ws, conj) => (ws.length > 1 ? `${ws.slice(0, -1).join(", ")} ${conj} ${ws.at(-1)}` : ws[0] || "");
function roleSentence(role) {
  const can = ROLE_CAN[role] || {};
  const yes = joined(VERBS.filter(([k]) => can[k]).map(([, does]) => does), "and");
  const no = joined(VERBS.filter(([k]) => !can[k]).map(([, , verb]) => verb), "or");
  const first = yes ? `${yes.charAt(0).toUpperCase()}${yes.slice(1)} payments.` : "Sees payments.";
  return `${first}${no ? ` Can’t ${no}.` : ""}${role === "owner" ? " An organisation always keeps at least one owner." : ""}`;
}

function approvalsSection() {
  const sub = cap("transfers.approvals").allowed
    ? "Every payment needs a second person to approve it. Whoever drafts a payment can’t approve it, whatever their role, and editing someone’s draft makes you its drafter."
    : "On your plan a payment is saved, then sent with Face ID or fingerprint. A second approval comes with a paid plan.";
  const list = Object.keys(ROLE_WORD).map((r) => `<div><dt>${esc(ROLE_WORD[r])}</dt><dd>${esc(roleSentence(r))}</dd></div>`).join("");
  return section("Who approves payments", sub, `<dl class="zb-set-rows">${list}</dl>
    <p><a href="?view=members" data-view-link="members">Change someone’s role in Members</a></p>`);
}

function moneriumSection(accounts) {
  if (!accounts) return section("Monerium", "", `<p class="empty">Accounts couldn’t load. Open Settings again to retry.</p>`);
  const euro = accounts.filter((a) => a.currency === "EUR");
  const live = euro.filter((a) => a.status === "active" && a.identifier?.iban);
  const p = euro.map((a) => a.profile).find((x) => x && x.status !== "not_applicable");
  const status = !live.length ? "Not connected" : p?.status === "needs_check" ? "Needs a check" : "Connected";
  const profile = p?.name ? `${p.name} (${p.kind === "corporate" ? "company" : "personal"} profile)` : "";
  const mine = live.some((a) => a.backingUserId === me?.id);
  const backer = live.find((a) => a.backingUserId)?.backingMemberName;
  return section("Monerium", "Monerium issues the IBANs and the euros. Zold is the software you use them with.",
    rows([["Status", status], ["Profile", profile], ["Through the account of", mine ? "You" : backer], ["Accounts", live.map((a) => a.label || a.currency).join(", ")]])
    + (p?.status === "needs_check" && p.reason ? `<p class="zb-hint">${esc(plain(p.reason))}</p>` : ""),
    `<a class="z-btn z-btn--secondary z-btn--sm" href="?view=accounts" data-view-link="accounts">Accounts</a>`);
}

function planSection(plan) {
  const t = org.trial;
  const current = plan?.available.find((p) => p.id === org.effectivePlan);
  const head = `<div class="zb-set-plan"><b>${esc(planName(org.effectivePlan))}</b>${onTrial() ? Z.tag("Trial") : ""}${onTrial() && t?.endsAt ? `<span class="desc">Until ${esc(day(t.endsAt))}</span>` : ""}</div>`;
  const sub = onTrial()
    ? "Zold takes no payments yet: a paid plan comes with the trial, or Zold grants it. When the trial ends, these features pause. Nothing is deleted."
    : "Zold takes no payments yet: a paid plan comes with the trial, or Zold grants it. Switching down pauses features and deletes nothing.";
  return section("Your plan", sub, `${head}${current ? `<p>${esc(current.blurb)}</p>` : ""}`,
    `<a class="z-btn z-btn--secondary z-btn--sm" href="?view=plan" data-view-link="plan">Compare plans</a>`);
}

RENDER.settings = async () => {
  const [acc, plan] = await Promise.allSettled([api(`/api/orgs/${org.id}/accounts`), api(`/api/orgs/${org.id}/plan`)]);
  const accounts = acc.status === "fulfilled" ? acc.value.accounts : null;
  const planData = plan.status === "fulfilled" ? plan.value : null;
  const SECTIONS = { org: orgSection, approvals: approvalsSection, monerium: () => moneriumSection(accounts), plan: () => planSection(planData) };
  return {
    html: `<div class="zb-set" id="set-root">${menu()}<div id="set-body">${SECTIONS[ss.sec]()}</div></div>`,
    bind(box) {
      const root = box.querySelector("#set-root");
      root.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-ss]");
        if (!b) return;
        ss.sec = b.dataset.ss;
        root.querySelector(".zb-set-menu").outerHTML = menu();
        root.querySelector("#set-body").innerHTML = SECTIONS[ss.sec]();
        root.querySelector(`[data-ss="${ss.sec}"]`)?.focus();
        // Stacked under the menu on a narrow screen: bring the section into view.
        if (matchMedia("(max-width: 1023px)").matches) root.querySelector("#set-body").scrollIntoView({ block: "start" });
      });
    },
  };
};

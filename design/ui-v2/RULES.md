# Rules for building the Zold UI

These rules apply to every page and screen, including ones that are not in `screens/`. They combine three sources:

1. The repo's own invariants (`AGENTS.md` at the root). Those win over everything here.
2. The **design-taste-frontend** skill (`~/.agents/skills/design-taste-frontend/SKILL.md`).
3. The **web-design-guidelines** skill (`~/.agents/skills/web-design-guidelines/SKILL.md`), which fetches Vercel's Web Interface Guidelines.

Load both skills at the start of any UI task and read them fully. This file records how they apply to Zold and which deviations are deliberate. It does not replace them.

## 1. Workflow for every UI change

1. **Load the skills.** Use the Skill tool for `design-taste-frontend` and `web-design-guidelines`. If the Skill tool is not available, read both SKILL.md files. For the guidelines, fetch `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`.
2. **State the design read** (design-taste-frontend 0.B) in your plan, using the one below unless the task changes it.
3. **Find the reference.** Open the matching `screens/<Name>.html` and `.png`, and its row in `SCREENS.md`. Match the reference: same content order, the same tokens (`tokens/tokens.css`) and the same components (`SYSTEM.md`). Do not redesign a screen that has a reference unless the owner asks.
4. **No reference?** Build the new screen from the existing components and layouts in SYSTEM.md. Check it against the layout families already used, so it does not repeat the screen next to it and does not invent a new style.
5. **Check honesty** (section 4) against the real API before showing any state.
6. **Audit before you call it done:**
   - `python3 design/ui-v2/tools/audit.py <files>`. For JS-rendered pages, snapshot them first with `tools/snapshot.mjs`.
   - Then do the manual review: run web-design-guidelines on the changed files, and do the design-taste-frontend copy self-audit.
   - Screenshot at 412px and 1440px, and look at both screenshots.
   - Run `document.compatMode` on any new page; it must be `CSS1Compat`.
7. **Run the tests.** `npm run check` must stay green. Four suites grep source text (custody, passkey-safe-plan, gnosis-pay and the passkey-safe mount check). If you move code, move their greps with it.
8. **Work in small PRs.** Branch `claude/ui-v2-<group>`, one group from SCREENS.md per PR, and put before and after screenshots in the PR body. main is PR-merge only. Commit and push only when the owner asks.

## 2. Design read and dials

> Reading this as: a redesign (preserve) of a consumer and small-business money app for people in Europe who do not know crypto. It uses a trust-first, dark, quiet language with one pink accent, and leans on native CSS, the existing vanilla JS, Inter and Material Symbols Rounded.

| Surface | DESIGN_VARIANCE | MOTION_INTENSITY | VISUAL_DENSITY |
|---|---|---|---|
| App, phone and desktop | 3 | 2 | 5 |
| Landing page | 6 | 4 | 3 |
| Legal pages, 404, errors | 2 | 1 | 4 |

Trust-first and regulated outrank taste (design-taste-frontend 0.A.6). When a rule pulls toward flair, pick clarity.

## 3. Deliberate deviations from design-taste-frontend

These deviations are decided. Do not undo them, and do not add new ones without asking.

| Skill rule | Zold choice | Why |
|---|---|---|
| Avoid Inter as default (4.1, 9.B) | Inter everywhere | This is the existing brand face on zoldhq.com and is self-hosted; redesign-preserve keeps brand assets (section 11). |
| No outer glows (9.A) | A pink glow only under the ONE primary button and a faint hero radial | This is the live site's signature. Keep it on primary actions only; never glow cards, text or icons. |
| No div-based fake product UI (9.E, 9.F) | Phone mockups on the landing page, tagged "Illustration" | The copy brief required them. Replace them with real screenshots of the shipped app once it exists. |
| Section numbering banned (9.F) | "01 02 03" on the three landing send steps | These are real ordered steps, not section eyebrows. Nowhere else. |

## 4. Honesty (repo rule 2: nothing renders as real that has not moved real money)

- **Show only what the API can do.** Render a control only when `/api/health` capabilities and the plan allow it. Hide it or mark it as not available, never fake success.
- **Label features that are not live.** A feature that is not live shows a **Soon** tag and is not pressable (opacity .55, no link). Use the words "Coming soon" or "Soon", never "Not yet". Examples: crypto wallet send, USD account, dollar/pound/yen accounts, sevDesk, DATEV.
- **Label features that work but are not proven.** These carry a **Beta** tag. Example: the GetMyInvoices connector, which has only been tested against a stand-in.
- **Label the test environment.** Every screen shows the amber pill "Test mode, no real money" while `capabilities.sandbox` is true.
- **Label mockups.** Every marketing mockup of the app carries an "Illustration" tag.
- **Show measured amounts.** Amounts that arrived are measured amounts (`creditedEur`), never the quote. A quote says "about".
- **No sent emails.** No string may say Zold emailed or notified someone. The user shares links themselves ("Share the link yourself"). No mail transport exists.
- **Fail closed in the UI too.** With no rate, show no price. With no connection, show no send button; show the reason and the one action that fixes it.
- **Status words follow real state:**
  - IN FLIGHT until the bank confirms, then PAID.
  - RECEIVED means money in.
  - IN REVIEW, NEEDS FIXING and WAITING FOR REVIEW are amber.
  - REFUNDED is only for a 4xx refusal that actually refunded.
- **Never make Zold look like a bank.**
  - Zold is software; Monerium issues the IBAN and the e-money.
  - Never use "bank account", "deposit insurance", "savings" or "interest".
  - Keep the Monerium attribution where it is on the landing page and in onboarding.

## 5. Words (plain language)

Users see everyday words. Technical terms live only in "Technical details" sections, legal pages, developer settings and the one safety warning noted below.

| Never shown in app UI | Say instead |
|---|---|
| passkey, create passkey | Face ID or fingerprint, set up Face ID, sign-in on this phone |
| SEPA, SEPA Instant | bank transfer, instant bank transfer |
| EURe, e-money token | euros |
| USDC (bare) | digital dollars (USDC). After the first mention on a screen, USDC alone is fine. |
| Safe, smart account | your account |
| signers, threshold, multisig | who approves payments, approvals needed |
| on-chain address | crypto wallet address |
| Base, Base Sepolia, chain, gas, UserOperation | leave out. Test mode says "Test mode, no real money". |
| slippage, mid rate, minOut | "at least €X, or nothing converts", "rate" |
| KYC (alone) | ID verification. "Pending ID verification (KYC)" is the owner's wording. |

**Allowed exceptions**, which `tools/audit.py` knows about:

- "Only USDC on the Base network" on the receive screen. A wrong network loses money, so this warning stays precise.
- "API key" in accounting connections and developer settings.
- The landing FAQ may explain the term once: "the passkey on your device, the same kind of sign-in as Face ID or Touch ID".

**Copy style:**

- Short sentences, and use "you".
- A button says what happens ("Convert with Face ID", "Share", "Review again").
- An error is one sentence saying what happened, plus one action.
- No em-dashes or en-dashes anywhere. Use commas, full stops or a hyphen.
- No "Elevate", "Seamless", "Unleash" or other filler verbs (9.D).
- At most one middle dot (·) per line.
- Use curly quotes and apostrophes (’ “ ”).
- Use the ellipsis character (…) in placeholders and loading text. Placeholders end with "…".
- Amounts: `€1,480.00` in the English UI and `1.480,00 €` on German invoices. Use tabular figures, and a real minus sign (−) for money out.
- Names in sample data are realistic and local: Miriam Zoldenburg, Lindner Holzbau GmbH, Druckerei Kessler, Café Ostwind. Never Acme or Jane Doe.

## 6. Layout and visual rules

- **Use tokens only.** Every colour, radius, space and shadow comes from `tokens/tokens.css` (`--z-*`). No new hex values.
- **Dark only for now.** Home-Light is an optional theme. If it is built, it is a full token remap, and a page is never half light, half dark (4.11).
- **Colour limits:**
  - Never pure black; `--z-bg` is #08080b.
  - Text is never dimmer than `--z-dim` (#9a9aa5). #5b5b66 fails contrast and is banned for text.
- **Pink limits:** one pink primary action per screen. Pink also appears as the focus ring, progress, selected pills and inline links. A second action is secondary (ghost with a border) or a quiet text link.
- **Status colours:** mint means money in or success, amber means warning or pending, pink means in progress.
- **Phone layout:**
  - 16px side gutter, content in `<main>`, and the primary action pinned at the bottom (16px padding, 28px bottom).
  - The bottom nav appears only on the tab roots (Home, Send, Get paid, Activity or Approvals, More).
- **Desktop layout (from 1024px):**
  - A 256px sidebar with the organisation switcher, Search (⌘K) and nav. Business accounts also get an ACCOUNTS list.
  - Content padding is 28px 40px.
  - Details open in a right drawer. Confirmations open in a centred dialog.
- **Cards and eyebrows:**
  - Cards use the card gradient with a 1px `--z-line` border and 16px radius.
  - No three equal cards in a row (9.C). Use list groups, 2×2 grids or stacked lists.
  - Eyebrows (11px uppercase) only label list groups, and at most one per group. No section numbers.
- **Icons:** Material Symbols Rounded in the app and Phosphor on the landing page. Never hand-drawn SVG icons. Never emoji in the UI.
- **Images:** give width and height to avoid layout shift, meaningful alt text or `alt=""` for decoration, and use lazy loading below the fold.

## 7. Interaction and accessibility (Web Interface Guidelines)

**Targets and forms**

- Touch targets are at least 44×44 on phones. Desktop pointer targets are at least 32px high; at least 24px is allowed in dense tables.
- Every input has a visible `<label>`, a `name`, the right `type`, `inputmode` and `autocomplete`. Email and code fields also get `spellcheck="false"`.
- Inputs use 16px text so iOS does not zoom.
- Placeholders end with "…" and never replace the label.
- Submit stays enabled until a request starts. Then it shows a spinner and keeps its label.
- Errors appear inline next to the field, and focus moves to the first error.
- Warn before leaving with unsaved changes.
- Destructive or money-moving actions always go through a review screen or confirmation. Never let one tap move money.

**Semantics and focus**

- Buttons are `<button>`, navigation is `<a href>`, and nothing clickable is a `<div>`.
- Icon-only buttons have an `aria-label`.
- Each page has exactly one `<h1>` and no skipped levels. Where the design shows no heading, use a visually hidden h1 (`.z-sr`).
- Each page has a skip link ("Skip to content" → `#main`).
- `:focus-visible` shows a 2px pink ring with a 2px offset. Never remove the outline without replacing it.
- Sheets and dialogs:
  - use `role="dialog"` and `aria-modal`;
  - trap focus and close with Esc;
  - return focus to the trigger when they close;
  - make the page behind them inert.
- Live updates (payment progress, copy confirmations) go through `aria-live="polite"`.

**Motion and URLs**

- Honour `prefers-reduced-motion`: no animation. The currency headline shows "euro" only.
- Transitions name their properties; never `transition: all`.
- Animate only `transform` and `opacity`.
- The URL reflects state (tabs, filters, open drawer), so back and deep links work.

**Content display**

- Long names truncate with an ellipsis on one line and show in full on the detail screen.
- IBANs are grouped by four in mono. Amounts use tabular figures.

## 8. Definition of done for a screen

- It matches its reference PNG at 412px (phone) or 1440px (desktop), within 2px of the tokens.
- `tools/audit.py` prints no findings for it, or the PR lists each finding with a reason.
- Both skills' manual checks are done, and the PR says so.
- Every state is handled: loading (skeleton, not spinner-only), empty, error, offline, and sandbox pill on and off.
- The numbers come from the API. Nothing is hard-coded from the reference; the reference sample data is fiction.
- `npm run check` is green.

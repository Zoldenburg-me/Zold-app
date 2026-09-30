# Zold UI v2: developer handoff

This is the redesign of zoldhq.com and the Zold app, ready to build. It covers 81 screens: the landing and legal pages, onboarding (personal and business), the phone dashboard, the desktop layout, the digital-dollar conversion, recovery and errors.

The design canvas is the source these files were exported from. Nothing here is production code: the screens are static reference pages with sample data.

## What is in this folder

| Path | What it is |
|---|---|
| `README.md` | This file: how to use the handoff and the build order |
| `CLAUDE.md` | Short standing instructions, loaded by Claude Code when it works in this folder |
| `RULES.md` | The rules: workflow, both skills, deliberate deviations, honesty, plain words, accessibility, definition of done |
| `SYSTEM.md` | Layout, breakpoints, type, components with states, status words, motion, edge cases |
| `SCREENS.md` | Every screen: status (LIVE, PARTIAL, NEW), what it is, primary action, where it links, where to implement it, notes |
| `index.html` | A gallery of all screens with status badges |
| `screens/<Name>.html` | A standalone reference page per screen. Links between screens work |
| `screens/<Name>.png` | A full-page screenshot per screen (phone 412px, desktop 1440px, landing mobile 390px) |
| `tokens/tokens.json`, `tokens/tokens.css` | Design tokens (`--z-*` custom properties) |
| `assets/` | Inter and Material Symbols (same files as `services/api/public/vendor/fonts`), the landing Phosphor subset, and the images: globe, Monerium and CBI logos, QR samples, and the sample avatar (AI-generated, fictional person) |
| `tools/audit.py` | The scripted checks from RULES.md. `python3 design/ui-v2/tools/audit.py <html files>` |
| `tools/snapshot.mjs` | Saves the rendered DOM and a screenshot of a running page, so `audit.py` can check JS-rendered screens |
| `tools/serve.sh` | Serves this folder on :8830. Web fonts do not load over file:// |

## Look at it

```sh
sh design/ui-v2/tools/serve.sh
# open http://localhost:8830/  (gallery)  or  http://localhost:8830/screens/Main.html
```

## Build order

Build one group per PR, on a `claude/ui-v2-<group>` branch. The order keeps each PR shippable:

1. **Tokens and components.**
   - Add `tokens.css` to `public/` and load it before `app.css`, `business.css` and the landing page.
   - Build the shared render helpers from SYSTEM.md: button, field, list group and row, tag, note, sheet, dialog, top bar, bottom nav.
   - No visible change yet beyond colours and type.
2. **Website.** The landing page, separate legal pages (imprint, terms, privacy, legal notes), the slim footer and the 404 page.
3. **Launch app and onboarding.** Sign-in first (Auth), install screens, account type, the personal and business paths, recovery choice, Monerium connect and welcome.
4. **Phone dashboard.** Home, activity, payment detail, send, add money, get paid, contacts and more.
5. **Digital dollars to euros.** Currency setting, convert review, done and refused, wired to the existing crypto-deposit routes.
6. **Invoices on the phone and accounting connections.**
7. **Business and settings.** Approvals, members, invite, settings, security, plan and coming soon.
8. **Desktop layout.** Sidebar, drawers, search (⌘K), the business desktop screens and the invoice editor.
9. **Recovery and errors.** Offline, error, maintenance, app 404 and the recovery screens.

## Prompt to start Claude Code

From the repo root:

> Read design/ui-v2/README.md, RULES.md, SYSTEM.md and SCREENS.md. Load the design-taste-frontend and web-design-guidelines skills and follow RULES.md section 1 for every change. Start with build step 1 (tokens and components) on a new claude/ui-v2-foundation branch. Match the reference screens in design/ui-v2/screens, keep every honesty rule in RULES.md section 4, run tools/audit.py and npm run check, then show me before and after screenshots. Don't commit or push until I say so.

For the later steps, change the step number and the branch name.

## What is sample data

These are all fiction: every name, amount, IBAN, address, date, rate and invoice number in the screens. Examples are Miriam Zoldenburg, Lindner Holzbau GmbH, Nordlicht Design and 1,684.12 USDC at 0.8788. Real screens read from the API. The IBAN `GB59 MONE 0000 0042 8817` and the wallet address are placeholders.

## Open decisions (owner)

- **Currencies:**
  - Dollar, pound and yen appear in the landing headline with Soon tags.
  - Yen has no partner on the roadmap. Keep, swap or drop it?
- **Crypto wallet send** is shown as Soon. Is it planned? If so, it needs a design (address, network check, review, approval).
- **Imprint:**
  - Register entry: "i.G." until the UG is registered.
  - The § 18 (2) MStV line.
  - The processor list in the privacy notice.
- **Light theme** (Home-Light): build it now or later?
- **Plans gating:** invoices are Premium, and accounting connections are for Business accounts only. Personal invoicing depends on that.

# UI v2: standing instructions for Claude sessions

Applies to any UI work in this repo: the landing page, legal pages, `public/app`, `public/business`, `pay.html`, `invoice.html` and any new page.

1. **Load both skills before writing UI:** `design-taste-frontend` and `web-design-guidelines`, installed in `~/.agents/skills`. For the guidelines, fetch the latest rules from the URL in their SKILL.md.
2. **Follow `design/ui-v2/RULES.md`.** Section 1 is the workflow and section 8 is the definition of done. `design/ui-v2/SYSTEM.md` has the components and `design/ui-v2/SCREENS.md` has the per-screen specs.
3. **Match the reference.** Every screen has one in `design/ui-v2/screens/` (HTML plus PNG). Use only the `--z-*` tokens from `design/ui-v2/tokens/tokens.css`.
4. **Keep the repo rules** in the root `CLAUDE.md`, which win over design:
   - Nothing renders as real that has not moved real money.
   - Fail closed.
   - main is PR-merge only.
5. **Plain words in the app:**
   - Say Face ID or fingerprint, not passkey.
   - Say bank transfer, not SEPA.
   - Say euros, not EURe.
   - Say digital dollars (USDC).
   - No em-dashes.
   - Soon and Beta tags go on anything not live or not proven.
6. **Before calling a screen done:**
   - Run `python3 design/ui-v2/tools/audit.py` on it. For JS-rendered pages, snapshot them first with `tools/snapshot.mjs`.
   - Run `npm run check`.
   - Screenshot it at 412px and 1440px.
7. **The reference screens are design output.** Do not edit `design/ui-v2/screens/*` by hand. Ask the owner to update the design canvas instead.

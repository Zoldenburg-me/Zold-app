# Design system

Everything the screens are built from. The values are in `tokens/tokens.json` and `tokens/tokens.css`; the names below refer to those `--z-*` variables. Pixel values are shown in brackets so the reference screens can be checked by eye.

## Layout

| Surface | Width | Structure |
|---|---|---|
| Phone app | fluid, designed at 412 | Test-mode pill (when sandbox) → top bar or large title → `<main>` with a 16px gutter and 16 to 20px gaps → pinned action area → bottom nav on tab roots |
| Desktop app | ≥1024, designed at 1440 | 256px sidebar, then `<main>` with 28px 40px padding, max content about 1100px; drawers on the right (about 420px), dialogs centred |
| Landing | fluid, designed at 1440 and 390 | Sticky nav 64px, sections with clamp() padding, content max about 1200px; single column under 760px |
| Legal pages | max text width about 72ch | Same nav and footer as the landing |

Background glow: on phone screens there is one radial pink glow behind the top (`hero-glow` token). Nothing else glows except the primary button.

| Breakpoint | Changes |
|---|---|
| < 760px | Landing single column, role cards stack with a -14px overlap, the business list gets a 28px icon column |
| 760 to 1023px | App keeps the phone layout, centred, max width 560px |
| ≥ 1024px | App switches to the sidebar layout; bottom nav hidden; sheets become drawers or dialogs |

## Typography

| Token | Spec | Used for |
|---|---|---|
| display | 52/1, 600, -0.05em, tabular | Balance, result amounts. The currency sign and cents are 30px in `--z-dim` |
| title | 34/1.05, 600, -0.045em, text-wrap: balance | Onboarding h1 |
| title-sm | 32/1.05, 600, -0.045em | Tab root h1 (Approvals, More), result screens |
| topbar | 17, 600, -0.02em | h1 in the top bar of a pushed screen |
| section | 20, 600, -0.03em | Sheet and dialog titles (h2) |
| body | 15 to 15.5/1.6, `--z-dim` | Ledes and paragraphs |
| row-title / row-sub | 14.5, 500 / 12.5/1.4, dim | List rows |
| label | 14, 500 | Form labels, `(optional)` in 400 dim |
| input | 16 | All inputs |
| eyebrow | 11, 600, 0.13em, uppercase, dim | List group labels only |
| tag | 10, 600, 0.06em, uppercase | Status pills |
| mono | 13 to 14, `--z-mono` | IBAN, BIC, addresses, reference codes |

## Components

The props below describe the contract, not a framework. The app is vanilla JS (`public/app/*.js` classic scripts, `public/business/*.js` ES modules): build each component as a small render function returning markup, in the style the files already use.

| Component | Variants and props | Spec | States |
|---|---|---|---|
| **Button** | `primary`, `secondary`, `quiet`; `icon`, `full` | Pill (radius 999), height 56 (primary) or 52 (secondary), padding 0 22, 16px 600. Primary: `--z-pink` fill plus `primary-glow`. Secondary: `--z-ghost` fill, 1px `--z-line-strong` | Hover: primary `--z-pink-hover`, secondary border `--z-line-hover`. Active: translateY(1px). Focus: ring. Disabled: ghost fill, dim text, no glow, `aria-disabled` plus a reason nearby. Loading: spinner before the label, label kept |
| **Icon button** | `aria-label` required | 44×44, radius 999, ghost fill, 1px line-strong, 20 to 22px icon | Same as secondary |
| **Top bar** | `title`, `back`, `right` | Height 60, 16px gutter, 44px back button with a -10px left offset, h1 17/600 | Title may be empty (then a hidden h1 elsewhere) |
| **Large title** | `title`, `sub` | h1 32/600, sub 15/1.55 dim, 6px gap | |
| **Progress (onboarding)** | `step`, `of`, `label`, `back` | Back plus "Step i of n · Label" 13px dim; bar of n segments 3px high, 4px gap, pink when done, `--z-line` when not | `role=progressbar` with aria values |
| **Field** | `label`, `name`, `type`, `autocomplete`, `hint`, `optional` | Label 14/500, 8px gap, input height 52, radius 12, fill `--z-field`, 1px line-strong, 16px text, placeholder ends with "…" | Focus: pink ring. Error: 1px amber border, message 13px amber below with `aria-describedby`, focus moves to the first error |
| **Select** | same as Field | Same box, chevron at the right 12px, `appearance: none` | |
| **Yes/No** | `name`, `question` | Fieldset card, legend REQUIRED (eyebrow), two pill radios 48 high | Checked: pink radio |
| **Check row** | `id`, `html` | Card with 20px checkbox (accent pink), 14/1.5 text, whole row is the label | |
| **Radio card group** | `legend`, options with title and sub | Fieldset, eyebrow legend, card with rows 14px padding, 20px radio, title 15/500, sub 13 dim (see Currency-Settings) | |
| **Segmented control** | `name`, `items`, `active` | Pill track 4px padding, items 38 high, active pink fill white text | `role=radiogroup`, `aria-checked` |
| **Filter pills** | `items`, `active`, `counts` | Height 36, pill, ghost; active pink tint, pink border, #ffd6ec text; counts at .7 opacity | `aria-pressed` |
| **Search** | `placeholder` | Pill 48 high, 20px search icon, `type=search`, `name=q` | Desktop: ⌘K opens the Search dialog |
| **List group** | `label`, `action`, `rows` | Optional eyebrow row (min height 32) with a 44px action link; card container, rows split by 1px `--z-line` | Empty: one row with the empty message and one action |
| **List row** | `lead`, `title`, `sub`, `right`, `href` | Min height 64, padding 10 14, gap 12; title one line with ellipsis; right column stacks amount and tag | Link rows get a chevron; disabled (Soon) rows opacity .55 and no link |
| **Avatar** | `initials`, `tone n/p/m`, `size` | Rounded square radius 12, 40px, 13/600 initials; photo variant is round with a 1px pink ring (landing only) | `aria-hidden` (the name is next to it) |
| **Icon tile** | `icon`, `tone n/p/a/m`, `size` | 40px radius 12, tinted fill and border per tone | |
| **Tag (status pill)** | tones: dim, pink, mint, amber | 10/600 uppercase, padding 2 8, radius 999, tint fill, 1px tone border | Word list: see "Status words" below |
| **Amount** | value | 14.5/600 tabular; money in mint with "+", money out text colour with "−" | |
| **Balance** | value, label | Label 14 dim plus a hide button (44px, eye icon); figure in display type | Hidden: "••••" with the same width |
| **Note** | tone a/n/p, icon | Radius 14, padding 12 14, 19px icon, 13.5/1.5 text; tint fill and border per tone | |
| **Key-value table** | rows, strong | Card, rows 12 14, key 14 dim, value right-aligned 14 tabular; optional hint under the key | Used on review, result and detail screens |
| **Copy row** | label, value, mono | Label 12.5 dim over the value; 44px copy button with an `aria-label` | After copy: icon turns into a check for 1.5s, `aria-live` "Copied" |
| **Sheet** | content, close | Bottom, radius 24 24 0 0, fill `--z-sheet`, `shadow-sheet`, 40×4 grabber; scrim `--z-scrim` with a 2px blur | Focus trap, Esc, return focus; on desktop it becomes a drawer |
| **Dialog** | content | Centred, 16px side inset, radius 24, `shadow-dialog` | Same as Sheet |
| **Bottom nav** | items, active | Height 76, 5 items, icon over a label, active pink; badge count on Approvals | `aria-current="page"`; hidden at ≥1024 |
| **Sidebar (desktop)** | org, items, accounts | 256px, org switcher card, search with ⌘K hint, nav rows 44 high, active pink tint; test-mode pill pinned at the bottom | |
| **Timeline** | steps: done, now, todo | 28px markers: done mint check, now pink with a 6px halo, todo ghost; 26px step gap | Payment progress and recovery |
| **Checklist row** | title, sub, state, action | Done: mint check, dim text; todo: action button at the right | Home for new accounts |
| **Test-mode pill** | shown when `capabilities.sandbox` | Amber pill 26 high, science icon, "Test mode, no real money" | `role=status` |
| **Soon row** | | List row at .55 opacity plus a Soon tag, not focusable | |

### Status words

| Tag | Tone | Meaning |
|---|---|---|
| IN FLIGHT | pink | Signed and on its way; the bank has not confirmed yet |
| PAID | dim | Out, confirmed |
| RECEIVED | mint | In, confirmed |
| IN REVIEW, WAITING FOR REVIEW, NEEDS FIXING, OVERDUE | amber | Someone must act or wait |
| FAILED, REFUNDED | amber | Only when that is the real state (see RULES.md 4) |
| DRAFT, SENT, VOID, OFF | dim | |
| OPEN, ACTIVE, ON, APPROVED | pink / mint | |
| Soon, Beta, Illustration, Recommended | amber / dim | Honesty labels |

## Motion

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Buttons, links | hover | colour or border colour | 150ms | ease |
| Buttons | press | translateY(1px) | 100ms | ease |
| Sheet | open / close | translateY(100%) → 0, scrim opacity 0 → 1 | 220ms / 180ms | cubic-bezier(.2,.8,.2,1) / ease-in |
| Drawer (desktop) | open / close | translateX(24px) plus opacity | 200ms | same |
| Copy button | after copy | icon swap to check | 1.5s hold | none |
| Landing currency word | loop | fade plus 0.22em slide, 2.5s per word, 10s loop | 10s | CSS keyframes `zcur` (see screens/Main.html) |
| Everything | `prefers-reduced-motion: reduce` | none | | |

## Edge cases to design for (all screens)

- **Loading:**
  - Show skeleton rows in the list group shape (same heights, `--z-ghost` blocks); never a blank screen.
  - Buttons keep their label while loading.
- **Empty:** one sentence and one action, inside the list group. For example "No payments yet. Share your account details to get paid."
- **Error:** a one-sentence inline note with an action. Whole-screen errors use the App-Error, App-Offline and App-Maintenance layouts.
- **Long text:**
  - Names are one line with an ellipsis in rows and wrap on detail screens.
  - German strings are about 30% longer. Buttons may wrap to two lines in the action area but never shrink below 16px.
- **Big numbers:** balances up to 7 digits must fit at 412px. Scale the display size down (52 → 40) above 9 characters.
- **Slow network:**
  - Money actions show progress states from the API.
  - Never time out into "failed" unless the API says failed.
- **Missing data:** show "Not set" in dim, with a link to where it is set. Never show "undefined" or "null".
- **Sandbox off:** the test-mode pill disappears and nothing else moves.

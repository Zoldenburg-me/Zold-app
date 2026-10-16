---
name: Zold ARK
colors:
  bg: '#0B0B0C'
  surface: '#131314'
  surface-raised: '#1A1A1C'
  field: '#101011'
  line: '#2A2926'
  line-strong: '#3A3833'
  text: '#EDE6D6'
  heading: '#F6F1E7'
  dim: '#9C9484'
  pink: '#ED188D'
  pink-hover: '#FF2D9E'
  pink-link: '#F06BB4'
  on-pink: '#0B0B0C'
  pink-tint: 'rgba(237,24,141,.08)'
  pink-border: 'rgba(237,24,141,.35)'
  platinum: '#C9CCD1'
  platinum-line: 'rgba(201,204,209,.38)'
  plate: '#1E1F22'
  green: '#6FA585'
  amber: '#D98E4A'
  red: '#D27468'
  scrim: 'rgba(5,5,6,.7)'
colors-light:
  bg: '#F6F1E7'
  surface: '#FBF8F1'
  surface-raised: '#EFE8DA'
  line: '#DDD4C2'
  text: '#17150F'
  dim: '#6B6455'
  pink: '#B5106B'
  on-pink: '#F6F1E7'
  pink-link: '#B5106B'
  platinum: '#5E6168'
  plate: '#EAE7E0'
  green: '#2F6B4C'
  amber: '#8A5F12'
  red: '#A23A30'
typography:
  display: { fontFamily: Inter, fontSize: 52px, fontWeight: '600', lineHeight: 1, letterSpacing: -0.05em }
  title: { fontFamily: Inter, fontSize: 34px, fontWeight: '600', lineHeight: 1.05, letterSpacing: -0.045em }
  section: { fontFamily: Inter, fontSize: 20px, fontWeight: '600', lineHeight: 1.25, letterSpacing: -0.03em }
  body: { fontFamily: Inter, fontSize: 15px, fontWeight: '400', lineHeight: 1.6 }
  row-title: { fontFamily: Inter, fontSize: 14.5px, fontWeight: '500', lineHeight: 1.4 }
  label: { fontFamily: Inter, fontSize: 14px, fontWeight: '500' }
  eyebrow: { fontFamily: Inter, fontSize: 11px, fontWeight: '600', letterSpacing: 0.18em, textTransform: uppercase }
  mono: { fontFamily: SF Mono, fontSize: 13.5px, fontWeight: '400', letterSpacing: 0.04em }
rounded:
  control: 6px
  card: 14px
  sheet: 20px
  tag: 999px
spacing:
  gutter-phone: 16px
  gutter-desktop: 40px
  scale: [4, 8, 12, 16, 20, 24, 32, 40, 48, 64]
---

# Zold ARK

ARK is a visual direction for Zold: old money, quiet wealth. Picture a black charge card, a private-client statement on heavy paper, an engraved brass nameplate. It is calm and confident, and it never shouts.

ARK replaces the **look** of UI v2 (colours, type, texture, shapes). It does not replace what the screens say or do. `design/ui-v2/RULES.md` sections 4 (honesty), 5 (words), 7 (interaction and accessibility) and 8 (definition of done) still bind every ARK screen, and the repo's `AGENTS.md` wins over both. The screen inventory is still `design/ui-v2/SCREENS.md`, and the component contracts are still `design/ui-v2/SYSTEM.md`; this file only restyles them.

The shipped app carries the ARK dark colours, radii and the no-glow rule through the UI v2 tokens (`--z-*` in `tokens.css`). The ARK components below (account plate, action row, hidable sidebar, stacking activity table, Zold name) and the light theme are not built yet.

## Brand and mood

- **Restraint is the luxury.** Lots of space, few elements, one accent. If a screen looks busy, remove something.
- **Material, not effects.** Depth comes from hairlines, paper, engraving and one metal, never from glows or blur.
- **Platinum is the material, pink is the action.** The account plate is black titanium with platinum engraving, like a black charge card. Pink appears where you act, never as ornament.
- **One typeface.** ARK keeps the shipped face, Inter, for everything. The premium feel comes from colour, space and the account plate, not from a new font.
- **Not a bank.** The mood borrows from private banking, but the copy never claims to be one (RULES.md section 4: no "bank account", "savings", "interest", "deposit insurance"). Monerium issues the IBAN, and the attribution stays where UI v2 has it.

## Colour

| Role | Dark | Light | Use |
|---|---|---|---|
| Background | `#0B0B0C` lacquer | `#F6F1E7` cream paper | Page |
| Surface | `#131314` | `#FBF8F1` | Cards, list groups |
| Raised | `#1A1A1C` | `#EFE8DA` | Sheets, dialogs |
| Line | `#2A2926` | `#DDD4C2` | 1px dividers and borders |
| Text | `#EDE6D6` ivory | `#17150F` ink | Body |
| Dim | `#9C9484` parchment | `#6B6455` | Secondary text, never dimmer |
| Pink | `#ED188D` | `#B5106B` | The one accent: fills, markers, focus ring |
| Pink link | `#F06BB4` | `#B5106B` | Pink as text: links and quiet buttons |
| Platinum | `#C9CCD1` | `#5E6168` | The account plate (frame at 38%, engraving, eyebrow) and chart lines |
| Green | `#6FA585` | `#2F6B4C` | Money in, done |
| Amber | `#D98E4A` | `#8A5F12` | Pending, in review, warnings |
| Red | `#D27468` | `#A23A30` | Failed, destructive |

Rules:

- **Pink is Zold's brand colour, used rarely.** It is used for the one primary button per screen, the focus ring, the active nav marker, the monogram and inline links. It never fills a card, a tile or a large area, and it is never decoration: charts and sparklines use platinum or green, not pink. Because it is rare, the one primary button hits hard: a full pink block with bold near-black text. Pink as text is always `pink-link`, because `#ED188D` on the raised surface is only 4.2:1.
- **No gradients, no glows, no shadows that tint,** with one exception: the account plate's brushed-metal surface (a dark diagonal gradient with a fine 1px grain at 1% white). ARK drops the UI v2 pink glow under the primary button and the hero radial (the deviation in RULES.md section 3). Shadows are plain black at low opacity, only under sheets and dialogs.
- **Status is never colour alone.** Every status carries an icon and a word (RULES.md status words: IN FLIGHT, PAID, RECEIVED, IN REVIEW, NEEDS FIXING, REFUNDED).
- **Contrast is checked.** Every text colour above passes WCAG AA (4.5:1) on its background and on the raised surface. Text on a pink button is `#0B0B0C` (4.8:1); white on pink is 4.1:1 and fails, so ARK never uses it. Do not add a colour without checking it.
- Dark is the default. Light is a full token remap; a page is never half light, half dark.

## Typography

| Token | Spec | Used for |
|---|---|---|
| display | Inter 52/1, 600, -0.05em, tabular figures | Balance and result amounts. The € sign and the cents are 60% size in dim |
| title | Inter 34/1.05, 600, -0.045em | Onboarding and tab-root h1 |
| section | Inter 20, 600, -0.03em | Sheet, dialog and card titles |
| body | Inter 15/1.6 | Paragraphs, ledes in dim |
| row-title / row-sub | Inter 14.5/500, 12.5 dim | List rows |
| label | Inter 14/500 | Form labels |
| input | Inter 16 | All inputs (no iOS zoom) |
| eyebrow | Inter 11/600, 0.18em, uppercase, dim | List group labels only, set like engraved small caps |
| tag | Inter 10/600, 0.08em, uppercase | Status tags |
| mono | `--z-mono` (ui-monospace, SF Mono, Menlo) 13.5, 0.04em | IBAN (grouped by four), BIC, reference codes |

These are the UI v2 faces (`--z-font`, `--z-mono`), already self-hosted; ARK adds no font. Amounts always use tabular lining figures and a real minus sign (−).

## Texture and ornament

- **Guilloché.** A fine engraved line pattern (concentric or wave rosette, 0.5px lines, platinum at 10 to 12% opacity) appears in exactly one place: behind the balance on the account plate. Nowhere else.
- **Double rule.** Major section breaks on desktop use a double hairline (1px, 3px gap, `line`). Rows inside a card use a single hairline.
- **Monogram.** A pink "Z" in a thin circle, like a signet ring. It replaces the logo in the top bar, the sidebar and the welcome screen.
- **No illustrations** of people, no 3D shapes, no coins, no crypto imagery, no emoji. The mascot stays out of ARK screens.

## Shapes and spacing

- Controls (buttons, inputs, segmented controls): 6px radius. ARK buttons are not pills.
- Cards and list groups: 14px. Sheets and dialogs: 20px top corners.
- Tags are the only pills.
- Spacing follows a 4px scale. The phone gutter is 16px; desktop content padding is 28px 40px; sections breathe at 32 to 48px.
- Touch targets stay at least 44×44.

## Icons

One thin-stroke outline family at 1.5px stroke (Phosphor Light). 20 to 22px in rows and buttons. Never filled, never two families on one screen.

## Components (restyled from SYSTEM.md)

| Component | ARK styling |
|---|---|
| **Account plate** (the Home balance card) | Brushed platinum-on-black surface (`plate`, see the gradient exception), 1px `platinum-line` hairline inset 6px from the edge (a frame inside the frame), guilloché behind the figure. Two columns: the left edge holds the platinum eyebrow "EURO ACCOUNT", the balance in display and the IBAN (mono, copy button); the right edge holds the Zold name at the top (`handle.zoldhq.com`, link icon, copy button, parent dim; only when `capabilities().ensParent` is set, never labelled "ENS") and the holder's name in small caps at the bottom. The right column stays right-aligned when the footer wraps. It is an account, not a card: no chip, no card number, no network logo |
| **Button, primary** | Pink fill, `on-pink` (near-black) text, 56 high, 6px radius, Inter 16/700. Hover `pink-hover`. No glow |
| **Button, secondary** | Transparent, 1px `line-strong`, ivory text. Hover border `pink-border` |
| **Button, quiet** | `pink-link` text, no border, underline on hover |
| **Field** | `field` fill, 1px `line-strong`, 6px radius, 52 high. Focus: 1px pink border plus the 2px pink focus ring |
| **List group / row** | Surface card, 14px radius, single hairlines between rows; avatar is a 40px circle with a thin `line-strong` ring and Inter initials |
| **Tag** | Tinted fill at 10%, 1px tone border, icon before the word |
| **Amount** | Inter, tabular figures: display size in balances and results, 14.5/600 in list rows. Money in is green with "+", money out ivory with "−" |
| **Bottom nav** | Lacquer bar, 1px top hairline, thin icons over labels; the active item gets a 16px pink bar above the icon instead of a fill |
| **Sidebar (desktop)** | 256px, monogram at the top, organisation switcher, nav rows 44 high; active row has a 2px pink bar at the left and ivory text, no tinted fill. Hidable: a hide button in its header and a menu button beside the page title. From 1024px it pushes the content and remembers its state; under 1024px it starts closed and opens over the page with a scrim, closes on Esc or a scrim tap, and is inert while closed |
| **Action row** | Four actions: Send, Get paid, Add money, Details. A 56px outline circle (`line-strong`, 1px) with a 24px icon over a 15px label, straight on the background, no card. On phone Home and on desktop Home under 1024px, where it replaces the Quick send card |
| **Timeline** | Thin vertical hairline; done is a green check, now is a pink ring, to-do is an empty ring |
| **Sheet / dialog** | Raised surface, scrim, no blur |
| **Test-mode pill** | Amber, as in UI v2: "Test mode, no real money". Shown while `capabilities.sandbox` is true |
| **Activity table** | Sized by its card, not the window (container query). From 540px of card content: a five-column table (date, counterparty, reference, status, amount). Under that: each row stacks, name with "date · reference" under it on the left, amount with the status tag under it on the right. Only the name truncates with "…"; amounts, tags, filter pills and buttons never wrap or clip |
| **Receipt** (review and result screens) | Key-value table set like a printed statement: dim keys left, values right in tabular figures, a double rule above the total |

## Copy voice

The UI v2 word list applies unchanged: "Face ID or fingerprint" not passkey, "bank transfer" not SEPA, "approve" not sign, "Zoldenburg recovery" not guardian, "backup key" not second owner. ARK adds a tone, not new words: short, unhurried, assured, the way a good private banker writes a letter. No exclamation marks, no em-dashes, no filler verbs. Sample names stay local (Miriam Zoldenburg, Lindner Holzbau GmbH, Café Ostwind).

## Using this with Stitch

Upload this file as the project's design system (Stitch's design-from-markdown option). In each screen prompt, name the screen from `SCREENS.md` and say "use the ARK account plate", "ARK receipt" and so on. Stitch output is a reference only: a screen is done when it meets RULES.md section 8, not when it looks like the mockup.

# Code layout — the modularity pass

*Decision history: the reasoning behind the current invariants, kept as written
apart from naming.*

## Modularity pass (Sep 2026) — where things live now

The repo was five files with everything in them. `npm run check`'s offline
suites are green across the whole pass (33 of them on a machine with no
egress), the browser halves were driven in a real Chromium, and every move was
checked to be a MOVE: the concatenation of the split files is the text that was
there. Nothing below changes behaviour. Landed on main as PR #190
(superseding #186).

| was | is |
|---|---|
| `server.ts` 3,876 | 317 lines of wiring + 11 routers + `http/` + `transfers/build.ts` |
| `public/index.html` 6,497 | 1,281 of markup + `app.css` + 9 files in `public/app/` |
| `routes/business.ts` 1,734 | 44 of composition + 7 files in `routes/business/` |
| `store.ts` 1,730 | 718 of methods + `store/types.ts` + `store/db.ts` |
| `liquidity.ts` 1,344 | 210 of seam + 7 files in `liquidity/` |
| `public/business.html` 1,482 | 80 of markup + `business.css` + 6 ES modules |
| `admin.html` 807 | 168 + `admin.css` + `admin.js` |

THE RULES THAT SURVIVED THE MOVE, each because it was deliberately preserved:
 - **server.ts still owns authentication.** Every router is a FACTORY taking
   `requireUserSession`. A pure projection (`publicUser`) is imported instead —
   plumbing a pure function through a deps bag only hid where it came from.
 - **ONE path builds a transfer.** `transfers/build.ts` is `buildTransferFromQuote`
   extracted whole, and the business router is still handed it rather than
   trusted to rebuild it. `custody:test`'s source grep follows it there.
 - **Route paths lost their `/api` prefix** because the routers are mounted at
   `/api`. The rate limiter reads the mount-relative path either way, so the
   buckets are unchanged — check that before moving a router's mount point.
 - **`liquidity/best.ts` takes its venue resolver as a constructor argument**
   rather than importing `providerById` back from the seam. The registry knows
   every venue; a venue importing the registry is a cycle for no gain.

THE TWO BROWSER DECISIONS, which differ on purpose:
 - **`public/app/*.js` are CLASSIC scripts, not modules.** That code shares one
   scope — `user`, `quote`, `sessionToken` and forty other bindings are read and
   reassigned across what are now nine files. ES modules export live bindings
   only the defining module may assign, so going modular means rewriting every
   assignment site. Ordered classic scripts keep the declarative script scope the
   single inline script already had. THE INVARIANT THAT MAKES IT SAFE: every file
   but the last holds declarations and event wiring only, and NOTHING CALLS
   FORWARD into a file loaded later. It was checked mechanically before the cut
   (all nine bare-identifier wirings and every top-level initialiser resolve
   backwards) and the boundaries were placed to keep it true. Keep it true.
 - **`public/business/*.js` ARE ES modules**, because that script was already
   `type="module"` and only fifteen places reassign shared state. `core.js`
   owns `org`/`view`/`invoiceDraft` and exports setters; an exported binding is
   LIVE, so every READ stayed a plain `org` and no read site changed. The import
   cycles between core, views and shell are cycles of function declarations —
   nothing at module-eval time calls across one.

`sw.js` caches the new app files and moved to `zold-shell-v2`: `/app` is now a
shell of markup that draws nothing without them, so caching the page and not
its code would give an offline start-up a blank screen.

Two follow-ups from review (`zold-shell-v3`):
- **The entry points moved to `app/main.js`, loaded last.** They sat at the
  end of `onboarding.js` on the theory that an awaited fetch outlasts parsing.
  It need not: the event loop runs while the parser waits on a later external
  script, so `/api/session` could resolve before `send.js` ran, `renderUser()`
  threw on `renderAutoConvert`, and `resumeSession`'s catch deleted the stored
  session. Anything that awaits and then renders belongs in `main.js`.
- **Page code is network-first in the service worker.** It used to be inline
  in HTML, which is network-first; as separate `.js`/`.css` files it fell into
  the cache-first branch, so a deploy served fresh markup with stale handlers
  until someone bumped `SHELL_CACHE`. Only `/vendor/*`, icons and the manifest
  stay cache-first.

NOT SPLIT, deliberately: `orchestrator.ts` (1,095) is the money path and is
meant to be read top to bottom — fragmenting it to hit a line count would cost
more than it buys; `config.ts` (946) is the one place an operator sees every
setting and every production refusal; `public/vendor/*` is vendored.

FOUR SUITES ASSERT ON SOURCE TEXT and their greps were moved with the code
(custody, passkey-safe-plan, gnosis-pay, and passkey-safe's route check, which
now also asserts server.ts still MOUNTS the auth router — a router mounted
nowhere would otherwise pass). If you move code again, grep the scripts for the
path you are moving.

VERIFICATION, and what it does not cover: the offline suites and a real browser
(Chromium with a CDP virtual authenticator) — signup through the passkey
ceremony creates an account, every app screen renders, all 151 top-level
declarations the inline script used to make are reachable, and all twelve
business dashboard views render signed in. NOT covered here: `draft:test`,
`quote-binding:test`, `jit:test`, `lifi:test` and one `business:test` check need `.env`
credentials or egress this machine does not have; each fails identically on the
pre-split files, which was checked rather than assumed.

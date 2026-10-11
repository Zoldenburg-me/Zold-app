---
name: prune-history
description: Remove change-log narration from comments, docs, AGENTS.md and notes so they state only what is true now. Use when asked to clean stale notes, prune history, or when a file reads like "X was retired (Sep 2026)", "used to", "is gone", "superseded — see below", "überholt / update 30.09".
---

# Prune history narration

Plain markdown so any agent can follow it.

## The rule

Text in this repo states what is true **now**. How it changed lives in git
(commit messages, PR bodies). A line like "the co-signer was retired (Sep
2026); its key and route are deleted" costs tokens in every session and says
nothing the current fact ("the passkey is the only owner") does not.

## 1. Find candidates

```bash
git grep -nIE 'retired|no longer|used to|previously|formerly|is gone|are gone|was deleted|were deleted|was removed|legacy|superseded|replaced by|renamed from|\((Jul[a-z]*|Aug|Sep|Oct|Nov|Dec) 20[0-9]{2}\)|überholt|noch nicht|update [0-9]{1,2}\.[0-9]{1,2}' -- ':!package-lock.json' ':!**/vendor/**'
```

Also check gitignored notes (`.private/`) and any agent memory folder if the
user asks.

## 2. Classify each hit

**Delete or rewrite** (history only):
- "X was retired / removed / deleted (date)" where X no longer exists anywhere.
- "used to …", "previously …", "this replaces the old …" in comments.
- A section marked "Superseded" / "STALE" / "HISTORICAL" with the old design
  kept below it — delete the old design, keep the current one.
- An "update DD.MM" note next to the line it contradicts — overwrite the line.
- Document headers pinned to a PR or date ("as of PR #193").
- One-off events ("on 2026-09-24 every branch was deleted").

**Fix — stale AND wrong** (highest priority): text that describes a removed
thing as present ("counter-signs on a legacy 2-of-2 Safe", "you can remove
it" for a deleted route). Rewrite to current behaviour.

**Keep** (not history, or history that still does work):
- Runtime behaviour: "this draft no longer exists", "the old passkey can
  cancel during the grace period", "nothing is deleted on downgrade".
- Old data or code still present: migrations, fields "only on legacy rows",
  localStorage slots read once and carried forward.
- Guards against a return: config that refuses removed env vars, tests that
  assert a route stays gone.
- One clause giving the reason for an invariant ("the UPI lesson").
- A date on a *verified observation* ("checked against mainnet.base.org,
  Sep 2026") — that dates evidence, not a change.

## 3. Rewrite

- Say the current fact in the present tense. Drop the date and the "was".
- If the reason still matters, keep it as one clause of *why*, not *when*.
- Do not leave a tombstone ("X removed") unless a reader would otherwise
  rebuild X — then phrase it as a rule: "Do not add a co-owner Zold holds."
- User-facing pages (the zold-docs repo, UI copy) never mention removed features.

## 4. Verify

- Code: comment-only changes; run `npm run typecheck`.
- Some suites grep source text (see AGENTS.md "Where the code lives"); if a
  comment you touched is matched by a test, run that suite.
- Re-run the grep from step 1 and list what you kept and why.

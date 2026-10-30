# Agent tooling: ai-harness and Ponytail

What the owner's Claude Code loads on top of `AGENTS.md`, and which rule wins
when they disagree. Other agents (Codex, Cursor) load none of this; for them
`AGENTS.md` "Change size" is the whole of it.

## Precedence

1. `AGENTS.md` (the repo's invariants).
2. Ponytail (how big a change is).
3. ai-harness skills and agents (review, testing, workflow defaults).

A lower layer never relaxes a higher one; a plugin's defaults apply only where
the repo is silent.

## Ponytail

Installed as the `ponytail@ponytail` plugin, level `full`, on at session start.
Its session hook also injects a codebase map (exported names per folder);
treat that map as a hint and read the file before relying on it.

Here it means `AGENTS.md` "Change size". House helpers to reuse first:
`store.ts` methods, `transfers/build.ts`, the `liquidity.ts` seam,
`capabilities()`. On a money or identity path a known limit is a refusal, not a
`shortcut:`.

Commands: `/ponytail-review` (diff review for over-building), `/ponytail-audit`
(whole-repo), `/ponytail-debt` (collects `shortcut:` comments),
`/ponytail lite|full|ultra`, "stop ponytail".

## ai-harness

The owner's plugin (`ai-harness@ai-harness`): review agents, the router and
loop skills, no hooks and no always-loaded rules. Its agents are named
`ai-harness:<agent>`, e.g. `ai-harness:typescript-reviewer`.

| Task | Skill / agent |
|---|---|
| After code changes | `ai-harness:typescript-reviewer`; `ai-harness:security-reviewer` on routes, auth, money |
| Before a PR | `/leak-check --range origin/main...HEAD` (public repo) |
| Cleaning this file or `docs/` | `tidy-context`, `docs/agents/prune-history.md` |
| Security audit findings | `/security-fix` |
| Personal data | `gdpr-compliance` |
| Passkey Safe, Safe smart accounts | `candide-safe-passkeys`, `candide-safe-unified-account` |

Server code logs with `console.error`/`console.warn` (there is no logger
module); `store.ts` mutates the db object by design.

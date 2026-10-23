# Agent tooling: ECC and Ponytail

What the owner's Claude Code loads on top of `AGENTS.md`, and which rule wins
when they disagree. Other agents (Codex, Cursor) load none of this; for them
`AGENTS.md` "Change size" is the whole of it.

## Precedence

1. `AGENTS.md` and `docs/security-hardening.md` (the repo's invariants).
2. Ponytail (how big a change is).
3. ECC rules (general style, review, testing defaults).

A lower layer never relaxes a higher one. Ponytail's "never cut" list and the
repo's "fail closed" rule say the same thing; ECC's defaults apply only where
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

## ECC (Everything Claude Code)

Installed by hand, not as a plugin: rules under `~/.claude/rules/ecc/`, skills
under `~/.claude/skills/`, hooks in `~/.claude/settings.json`. `common/` loads
every session; the language folders load by file path, so only `typescript/`
and `web/` ever fire here.

### Where ECC defaults do not apply

| ECC says | Here |
|---|---|
| No `console.log` | Server code logs with `console.error`/`console.warn`; there is no logger module. No debug `console.log` left in `public/`. |
| Immutability always | `store.ts` mutates the db object by design; follow the surrounding code. |

### Hooks that will stop you

- **GateGuard**: the first Bash call of a session, and every first Edit/Write
  of a file, asks for facts (the request, importers, what the command does).
  State them and retry; do not disable the gate.
- **config-protection**: refuses edits to lint/format configs. Fix the code.
- **doc-file-warning**: warns on ad-hoc `NOTES.md`/`TODO.md`-style files.
  Notes go in `docs/` under an existing heading or nowhere.

### Skills worth reaching for here

| Task | Skill / agent |
|---|---|
| After code changes | `typescript-reviewer`; `security-reviewer` on routes, auth, money |
| Before a PR | `/leak-check --range origin/main...HEAD` (public repo) |
| Cleaning this file or `docs/` | `tidy-context`, `docs/agents/prune-history.md` |
| Security audit findings | `/security-fix` |
| Personal data | `gdpr-compliance` |
| Passkey Safe, Safe smart accounts | `candide-safe-passkeys`, `candide-safe-unified-account` |
| Token amounts across chains | `evm-token-decimals` |
| Codemaps | `/update-codemaps` (writes `docs/CODEMAPS/`) |

# Legal documents — status and what still blocks publication

Drafts live here, **not** in `services/api/public/`, because that directory is
served by `express.static`. Publishing an incomplete Impressum or a privacy
policy that misdescribes our security is worse than having neither — in Germany
a defective Impressum is actionable by competitors without any regulator being
involved.

Move a file to `public/` only when nothing in it is a placeholder.

## Status

| Document | File | State |
|---|---|---|
| Impressum | `services/api/public/impressum.html` | Drafted, **uncommitted**, 3 placeholders |
| Terms of Service | `terms.md` | Drafted; liability + jurisdiction need counsel |
| Privacy Policy | `privacy.md` | Drafted; two items untrue of the system today |
| Disclaimer / risk notice | — | Not started |
| Widerrufsbelehrung | — | **Not started — see below** |

## What needs a German lawyer, and why

Not a general disclaimer. These are specific:

**Liability (Terms §9).** The cap comparable companies use — liability limited
to fees paid — is very likely void against consumers under § 309 Nr. 7 BGB,
which forbids limiting liability for injury to life, body or health and for
grossly negligent breach. A void clause does not narrow liability; it vanishes,
leaving it unlimited. This is the single most expensive thing to get wrong.

**Jurisdiction (Terms §12).** A choice-of-forum clause is generally not
enforceable against consumers in the ordinary way. The clause needs drafting to
match that rather than asserting a venue.

**Right of withdrawal (Widerrufsrecht).** Distance contracts with consumers in
the EU carry a 14-day withdrawal right, with specific rules and exemptions for
financial services. A **Widerrufsbelehrung** is probably mandatory and we do not
have one. Getting the instruction wrong extends the withdrawal period — in some
cases to twelve months. This is the requirement most often missed.

**Art. 9 GDPR.** Sumsub's liveness check may produce biometric data. If so, the
AML legal basis may not be sufficient on its own and explicit consent may be
required, collected separately.

**Third-country transfers.** MoneyGram (US) and Sumsub each need an identified
transfer mechanism — adequacy, SCCs, or an Art. 49 derogation.

**Whether we are a Monerium distributor.** Their business terms prohibit acting
"as a front, a reseller, or in any way on behalf of a third party" without
explicit approval, and per-user IBAN provisioning through their API is
distribution on any reading. This determines what the Terms may say about our
role, so it should be settled before the Terms are finalised.

## What blocks publication in code, not law

**🔧 Plaintext datastore.** `data/db.json` holds identity fields and, for
unmigrated accounts, key material. Art. 32 GDPR requires appropriate technical
measures. The privacy policy cannot describe our security honestly until this
is replaced — so this is a publication blocker, not a nice-to-have.

**🔧 Cookie/storage disclosure.** Confirm exactly what is stored client-side and
whether anything requires consent under § 25 TDDDG before describing it.

## Sequencing

1. Fix the plaintext store (blocks the privacy policy)
2. Settle the Monerium distributor question (blocks the Terms' §3)
3. Fill the Impressum's three fields once a Geschäftsführer is appointed
4. Take all four documents to a *Fachanwalt für IT-Recht* in one bundle,
   together with `docs/regulatory-architecture.md` — a lawyer reviewing a
   specific draft against a described architecture is far cheaper than one
   starting from a blank page
5. Add the Widerrufsbelehrung they produce
6. Only then move files into `public/`

## Language

Drafted in English, matching the product. ⚖️ Consumers in Germany may be
entitled to German-language terms; confirm whether a German version is required
or merely advisable.

## Source material these were drafted against

- Monerium Business, API and Personal Terms of Service, and Privacy Notice
- MoneyGram crypto terms and Ramps documentation
- Rebind SAS — same model, same e-money issuer, French entity
- `docs/regulatory-architecture.md` — what the system actually does

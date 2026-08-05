# KYC Provider Integration

Sumsub is the primary identity provider for the normal KYC path. The app
creates a Sumsub WebSDK link, records the applicant reference, and waits for a
signed `applicantReviewed` webhook before changing local KYC state.

## Privacy Boundary

Document images, liveness media, and proof-of-address files stay in Sumsub. The
app does not upload, download, persist, or serve those files. It stores only:

- Sumsub applicant/external user identifiers.
- Review status and review answer.
- Text fields extracted from the verified applicant profile when available,
  because MoneyGram/SEP-9 needs sender text fields before a cash withdrawal can
  open.

The honest product claim is: **we do not store your KYC documents**. Do not say
we can never access them unless Sumsub dashboard/API permissions are configured
so this app and its operators cannot read document media.

## Monerium

Monerium whitelabel supports KYC Sharing for personal profiles. After a Sumsub
approval, the app can generate a Sumsub share token and call Monerium
`POST /profiles/{profile}/share` with `provider=sumsub`. Monerium then fetches
the verified data asynchronously and reports profile progress through Monerium
profile webhooks.

Before go-live, Monerium requires its compliance team to approve the onboarding
process, risk classification, country policy, document requirements, sanctions
handling, PEP/source-of-funds handling, and any restricted-country controls.

## MoneyGram

MoneyGram's Stellar ramp flow accepts a documented subset of SEP-9 sender
fields in the SEP-24 interactive request. This app maps text fields from the
stored sender profile into that subset and refuses to open a cash payout if the
configured anchor says required sender fields are missing.

MoneyGram does not receive document images from this app. If MoneyGram requires
additional review in the interactive session, their hosted flow collects it.

## Bridge

Bridge is not the same handoff shape as Monerium. Their docs show two paths:
hosted KYC links, or direct Customers API submission with required identity,
address, agreement, source-of-funds, and sometimes document fields. Do not
assume a Sumsub approval can be passed to Bridge as a reusable share token
without Bridge explicitly supporting that in the partner agreement.

For Bridge, use either:

- A Bridge-hosted KYC link, so Bridge collects and stores its required
  compliance data; or
- A direct Bridge Customers API integration only after deciding which fields
  must be stored locally and whether that breaks the no-document-storage claim.


# Screens

Every screen of the redesign, grouped the way to build them. Each has a reference page in `screens/<Name>.html` (open through `tools/serve.sh`, links between screens work) and a full-page `screens/<Name>.png`.

Status column: **LIVE** backend exists and runs, **PARTIAL** exists but gated or unproven (read the note), **NEW** the UI or route does not exist yet. Never render a PARTIAL or NEW feature as working; see RULES.md, Honesty.

Widths: phone 412, desktop 1440, landing mobile 390. Heights are content heights, not viewports.

## Website

Implement in: `services/api/public/landing.html, 404.html, new legal pages` (confirm against docs/architecture/product-architecture.md before moving code).

| Screen | Status | What it is | Primary action | Goes to |
|---|---|---|---|---|
| [Main](screens/Main.html) | LIVE | Landing page, desktop. Hero with the rotating currency headline, get paid, who moves your money, send steps, business roles, trust, FAQ, final call to action, slim footer. | none | [AccountType](screens/AccountType.html), [Auth](screens/Auth.html), [Business-Entity](screens/Business-Entity.html), [Imprint](screens/Imprint.html), [Privacy](screens/Privacy.html), [Regulatory](screens/Regulatory.html), [Terms](screens/Terms.html) |
| [Main-Mobile](screens/Main-Mobile.html) | LIVE | The same landing page under 760px. Same content, single column, role cards stack. | none | [AccountType](screens/AccountType.html), [Auth](screens/Auth.html), [Business-Entity](screens/Business-Entity.html), [Imprint](screens/Imprint.html), [Privacy](screens/Privacy.html), [Regulatory](screens/Regulatory.html), [Terms](screens/Terms.html) |
| [Imprint](screens/Imprint.html) | LIVE | Impressum as its own page (moved out of the footer). | none | [AccountType](screens/AccountType.html), [Auth](screens/Auth.html), [Privacy](screens/Privacy.html), [Regulatory](screens/Regulatory.html), [Terms](screens/Terms.html) |
| [Terms](screens/Terms.html) | LIVE | Terms of use as its own page. | none | [AccountType](screens/AccountType.html), [Auth](screens/Auth.html), [Imprint](screens/Imprint.html), [Privacy](screens/Privacy.html), [Regulatory](screens/Regulatory.html) |
| [Privacy](screens/Privacy.html) | LIVE | Privacy notice as its own page. | none | [AccountType](screens/AccountType.html), [Auth](screens/Auth.html), [Imprint](screens/Imprint.html), [Regulatory](screens/Regulatory.html), [Terms](screens/Terms.html) |
| [Regulatory](screens/Regulatory.html) | LIVE | Legal notes: the numbered notes the landing footnotes point to (#s0 to #s4). | none | [AccountType](screens/AccountType.html), [Auth](screens/Auth.html), [Imprint](screens/Imprint.html), [Privacy](screens/Privacy.html), [Terms](screens/Terms.html) |

- **Main** (1440px). Dollar, pound and yen carry a Soon tag while on screen; reduced motion freezes on euro. Phone mockups are HTML and carry an Illustration tag: once the new app ships, replace them with real screenshots of it (design-taste-frontend 9.E). Footnote markers link to Legal notes. 
- **Main-Mobile** (390px). One responsive page, not two. Board height in the canvas is capped at 8000px; the PNG here is the full page. 
- **Imprint** (1440px). Register line and § 18 (2) MStV line are still placeholders. The company must match the register exactly (i.G. if not yet entered). 
- **Terms** (1440px). Legal text: do not rewrite wording without the owner. 
- **Privacy** (1440px). Processor list is a placeholder. 
- **Regulatory** (1440px). Anchor ids must stay stable; the landing links to them. 

## Launch app, sign in, install

Implement in: `services/api/public/index.html + app/onboarding.js, app/pwa.js` (confirm against docs/architecture/product-architecture.md before moving code).

| Screen | Status | What it is | Primary action | Goes to |
|---|---|---|---|---|
| [Auth](screens/Auth.html) | LIVE | What 'Launch app' / 'Log in' opens when signed out: sign in with Face ID, create an account, recover. | Sign in with Face ID | [Home-Active](screens/Home-Active.html), [Install-iOS](screens/Install-iOS.html), [Privacy](screens/Privacy.html), [Recover](screens/Recover.html), [Terms](screens/Terms.html) |
| [AccountType](screens/AccountType.html) | LIVE | Personal or business. Business leads to the company name. | none | [Auth](screens/Auth.html), [Business-Entity](screens/Business-Entity.html), [Personal-Name](screens/Personal-Name.html) |
| [Install-iOS](screens/Install-iOS.html) | PARTIAL | Add to Home Screen steps for iPhone (PWA). | none | [AccountType](screens/AccountType.html), [Auth](screens/Auth.html) |
| [Install-Android](screens/Install-Android.html) | LIVE | Install prompt for Android (beforeinstallprompt). | Install app | [AccountType](screens/AccountType.html), [Auth](screens/Auth.html) |
| [Recovery-Choice](screens/Recovery-Choice.html) | PARTIAL | If you lose this phone: Zoldenburg recovery, email and phone codes, or skip (with the warning). | Continue | [Monerium-Connect](screens/Monerium-Connect.html), [Personal-Passkey](screens/Personal-Passkey.html) |
| [Monerium-Connect](screens/Monerium-Connect.html) | LIVE | Get your IBAN: connect Monerium (OAuth), with a developer option for own API keys. | Continue with Monerium | [Home-Personal](screens/Home-Personal.html), [Recovery-Choice](screens/Recovery-Choice.html), [Welcome](screens/Welcome.html) |
| [Welcome](screens/Welcome.html) | LIVE | Welcome tour card while the IBAN is in review. | Next | [Home-Personal](screens/Home-Personal.html) |

- **Auth** (412px). Returning users must see sign-in first. Recovery link always visible. 
- **Install-iOS** (412px). PWA install on iOS is untested and may split storage from Safari (docs/status.md). Show before account creation, not after. 
- **Install-Android** (412px). Fall back to the menu instructions when the event never fires. 
- **Recovery-Choice** (412px). Skipping requires ticking the warning; recoveryChoice records the answer. No recovery has run on chain yet. fields: recovery; status tags: Recommended.
- **Monerium-Connect** (412px). The API-keys option shows only when /api/health says moneriumApiKeys (the apiKeys tweak). 
- **Welcome** (412px). 4 cards; skippable. status tags: IN REVIEW.

## Onboarding, personal

Implement in: `app/onboarding.js` (confirm against docs/architecture/product-architecture.md before moving code).

| Screen | Status | What it is | Primary action | Goes to |
|---|---|---|---|---|
| [Personal-Name](screens/Personal-Name.html) | LIVE | Step 2: legal name. | Continue | [AccountType](screens/AccountType.html), [Personal-Email](screens/Personal-Email.html) |
| [Personal-Email](screens/Personal-Email.html) | LIVE | Step 3: email (required, used for recovery codes). | Continue | [Personal-Name](screens/Personal-Name.html), [Personal-Residence](screens/Personal-Residence.html) |
| [Personal-Residence](screens/Personal-Residence.html) | LIVE | Step 4: country of residence and the US-person question. | Continue | [Personal-Email](screens/Personal-Email.html), [Personal-Review](screens/Personal-Review.html) |
| [Personal-Review](screens/Personal-Review.html) | LIVE | Step 5: summary, Terms and Privacy checkbox. | Continue | [Personal-Name](screens/Personal-Name.html), [Personal-Passkey](screens/Personal-Passkey.html), [Personal-Residence](screens/Personal-Residence.html), [Privacy](screens/Privacy.html), [Terms](screens/Terms.html) |
| [Personal-Passkey](screens/Personal-Passkey.html) | LIVE | Step 6: set up Face ID or fingerprint sign-in (creates the passkey and the account). | Set up Face ID | [Personal-Review](screens/Personal-Review.html), [Recovery-Choice](screens/Recovery-Choice.html) |

- **Personal-Name** (412px). autocomplete given-name / family-name. fields: given, family.
- **Personal-Email** (412px). type=email, spellcheck=false. fields: email.
- **Personal-Residence** (412px). Both required by Monerium. fields: country, usPerson.
- **Personal-Review** (412px). No separate Monerium data-sharing checkbox: the Terms and Privacy cover it (owner decision). 
- **Personal-Passkey** (412px). Word 'passkey' never shown. No skip. 

## Onboarding, business

Implement in: `app/onboarding.js (business branch) + business/*` (confirm against docs/architecture/product-architecture.md before moving code).

| Screen | Status | What it is | Primary action | Goes to |
|---|---|---|---|---|
| [Business-Entity](screens/Business-Entity.html) | LIVE | Step 2: company legal name, legal form, trading name. | Continue | [AccountType](screens/AccountType.html), [Business-Registration](screens/Business-Registration.html) |
| [Business-Registration](screens/Business-Registration.html) | LIVE | Step 3: country, register number, court. | Continue | [Business-Entity](screens/Business-Entity.html), [Business-You](screens/Business-You.html) |
| [Business-You](screens/Business-You.html) | LIVE | Step 4: the person opening it and their role. | Continue | [Business-Ownership](screens/Business-Ownership.html), [Business-Registration](screens/Business-Registration.html) |
| [Business-Ownership](screens/Business-Ownership.html) | LIVE | Step 5: the two required US-nexus questions. | Continue | [Business-Review](screens/Business-Review.html), [Business-You](screens/Business-You.html) |
| [Business-Review](screens/Business-Review.html) | LIVE | Step 6: summary, authorised checkbox, Terms and Privacy checkbox. | Continue | [Business-Entity](screens/Business-Entity.html), [Business-Ownership](screens/Business-Ownership.html), [Business-Passkey](screens/Business-Passkey.html), [Privacy](screens/Privacy.html), [Terms](screens/Terms.html) |
| [Business-Passkey](screens/Business-Passkey.html) | LIVE | Step 7: first approver for the company. | Set up Face ID | [Business-Review](screens/Business-Review.html), [Home-Business](screens/Home-Business.html) |

- **Business-Entity** (412px). Entity name is asked only on the business path. fields: legal-name, legal-form, trading-name.
- **Business-Registration** (412px). fields: incorp, reg-no, reg-court.
- **Business-You** (412px). fields: b-name, role, b-email.
- **Business-Ownership** (412px). fields: companyUsNexus, usPerson.
- **Business-Review** (412px). No Monerium data-sharing checkbox (owner decision). 

## Home and activity (phone)

Implement in: `app/dashboard.js, app/transactions.js` (confirm against docs/architecture/product-architecture.md before moving code).

| Screen | Status | What it is | Primary action | Goes to |
|---|---|---|---|---|
| [Home-Personal](screens/Home-Personal.html) | LIVE | Home for a new personal account: checklist (sign-in, account, recovery, IBAN, first payment). | none | [Account-Details](screens/Account-Details.html), [Activity](screens/Activity.html), [GetPaid](screens/GetPaid.html), [Monerium-Connect](screens/Monerium-Connect.html), [More](screens/More.html), [Pending](screens/Pending.html), [Recovery-Choice](screens/Recovery-Choice.html), [Send-Hub](screens/Send-Hub.html) |
| [Home-Business](screens/Home-Business.html) | LIVE | Home for a new company account: checklist incl. company verification and inviting teammates. | none | [Account-Details](screens/Account-Details.html), [Approvals](screens/Approvals.html), [GetPaid](screens/GetPaid.html), [Invite-Dialog](screens/Invite-Dialog.html), [Monerium-Connect](screens/Monerium-Connect.html), [More](screens/More.html), [Send-Hub](screens/Send-Hub.html), [Send-Review](screens/Send-Review.html) |
| [Home-Active](screens/Home-Active.html) | LIVE | Home for an active personal account: balance, account details, Send / Add money / Request, the in-flight payment, recent activity. | none | [Account-Details](screens/Account-Details.html), [Activity](screens/Activity.html), [Add-Money](screens/Add-Money.html), [Desk-Search](screens/Desk-Search.html), [GetPaid](screens/GetPaid.html), [More](screens/More.html), [Send-Hub](screens/Send-Hub.html), [Send-Progress](screens/Send-Progress.html), [Tx-Detail](screens/Tx-Detail.html) |
| [Account-Details](screens/Account-Details.html) | LIVE | Sheet over Home: account holder, IBAN, BIC, crypto wallet address (collapsed), copy all, share. | Share | [Activity](screens/Activity.html), [Add-Money](screens/Add-Money.html), [Desk-Search](screens/Desk-Search.html), [GetPaid](screens/GetPaid.html), [Home-Active](screens/Home-Active.html), [More](screens/More.html), [Send-Hub](screens/Send-Hub.html), [Send-Progress](screens/Send-Progress.html), [Tx-Detail](screens/Tx-Detail.html) |
| [Activity](screens/Activity.html) | LIVE | Activity list with filters, search and inline memos. | none | [GetPaid](screens/GetPaid.html), [Home-Active](screens/Home-Active.html), [More](screens/More.html), [Send-Hub](screens/Send-Hub.html), [Tx-Detail](screens/Tx-Detail.html) |
| [Tx-Detail](screens/Tx-Detail.html) | LIVE | One payment: amount, status, date, IBAN, fee, sent as, reference, memo, technical details collapsed. | none | [Activity](screens/Activity.html) |
| [Home-Light](screens/Home-Light.html) | NEW | Light theme of Home. | none | [Account-Details](screens/Account-Details.html), [Activity](screens/Activity.html), [Add-Money](screens/Add-Money.html), [Desk-Search](screens/Desk-Search.html), [GetPaid](screens/GetPaid.html), [Home-Active](screens/Home-Active.html), [More](screens/More.html), [Send-Hub](screens/Send-Hub.html), [Send-Progress](screens/Send-Progress.html), [Tx-Detail](screens/Tx-Detail.html) |

- **Home-Personal** (412px). Checklist rows reflect real state; nothing is ticked that the API has not confirmed. status tags: Done, Personal, Waiting.
- **Home-Business** (412px). status tags: Done, Waiting.
- **Home-Active** (412px). Balance can be hidden. The in-flight row is real transfer state. status tags: IN FLIGHT, PAID, RECEIVED.
- **Account-Details** (412px). Copy buttons 44px with aria-labels. IBAN in mono, grouped by 4. status tags: ACTIVE, IN FLIGHT, PAID, RECEIVED.
- **Activity** (412px). Memo is a real field on the transfer; 'Add memo' opens Tx-Detail with the memo focused. fields: q; status tags: IN FLIGHT, PAID, RECEIVED.
- **Tx-Detail** (412px). Technical details (tx hash etc.) only inside the collapsed section. fields: memo; status tags: PAID.
- **Home-Light** (412px). Optional. If built, it is a full theme (tokens remapped), never mixed with dark on one page. status tags: IN FLIGHT, PAID, RECEIVED.

## Send and add money (phone)

Implement in: `app/send.js, app/dashboard.js` (confirm against docs/architecture/product-architecture.md before moving code).

| Screen | Status | What it is | Primary action | Goes to |
|---|---|---|---|---|
| [Send-Review](screens/Send-Review.html) | LIVE | Review: from, fee, exchange, arrival, what the recipient gets; approve with Face ID. | none | [Send-Amount](screens/Send-Amount.html), [Send-Progress](screens/Send-Progress.html) |
| [Send-Hub](screens/Send-Hub.html) | PARTIAL | Pick a recipient: recent, new bank transfer, crypto wallet (Soon), contacts. | none | [Activity](screens/Activity.html), [GetPaid](screens/GetPaid.html), [Home-Active](screens/Home-Active.html), [More](screens/More.html), [Send-Amount](screens/Send-Amount.html) |
| [Send-Amount](screens/Send-Amount.html) | LIVE | Amount entry, no pre-fill, fee and arrival shown, optional reference. | none | [Send-Hub](screens/Send-Hub.html) |
| [Send-Progress](screens/Send-Progress.html) | LIVE | Progress: approved, sent, arriving, paid. | Done | [Home-Active](screens/Home-Active.html) |
| [Send-Error](screens/Send-Error.html) | LIVE | Nothing was sent: one sentence, one action. | Review again | [Home-Active](screens/Home-Active.html), [Send-Review](screens/Send-Review.html) |
| [Add-Money](screens/Add-Money.html) | PARTIAL | Ways in: bank transfer, crypto wallet, USD account (Soon). | none | [Account-Details](screens/Account-Details.html), [Activity](screens/Activity.html), [Add-Wallet](screens/Add-Wallet.html), [GetPaid](screens/GetPaid.html), [Home-Active](screens/Home-Active.html), [More](screens/More.html), [Send-Hub](screens/Send-Hub.html) |
| [Add-Wallet](screens/Add-Wallet.html) | LIVE | Receive USDC: QR, address, Base-only warning, main-currency note, payments waiting to convert. | Convert | [Add-Money](screens/Add-Money.html), [Convert-Review](screens/Convert-Review.html), [Currency-Settings](screens/Currency-Settings.html) |

- **Send-Review** (412px). The approval signs this amount to this IBAN only; say so. 
- **Send-Hub** (412px). Crypto wallet send is not built: disabled with Soon. fields: q; status tags: Soon.
- **Send-Amount** (412px). Button disabled until an amount is entered; inputmode=decimal. fields: amount, reference.
- **Send-Progress** (412px). 'Paid' only when the bank confirms (never optimistic). status tags: IN FLIGHT.
- **Send-Error** (412px). Only a 4xx refusal refunds; other failures are manual review. Match the wording to the real state. status tags: REFUNDED.
- **Add-Money** (412px). USD account is Soon (roadmap: Iron). status tags: Soon.
- **Add-Wallet** (412px). The Base-network warning stays technical on purpose: wrong network means lost money. 

## Digital dollars to euros (phone)

Implement in: `app/send.js (Crypto in card) + routes/crypto-deposits.ts` (confirm against docs/architecture/product-architecture.md before moving code).

| Screen | Status | What it is | Primary action | Goes to |
|---|---|---|---|---|
| [Currency-Settings](screens/Currency-Settings.html) | LIVE | Main currency: keep money in euros or USDC; when dollars arrive, ask to convert or keep. | none | [Settings](screens/Settings.html) |
| [Convert-Review](screens/Convert-Review.html) | LIVE | Price for converting one USDC payment: amount in, about-amount out, rate, €0 fee, guaranteed minimum, 15-minute window; convert with Face ID. | Convert with Face ID | [Add-Wallet](screens/Add-Wallet.html), [Convert-Done](screens/Convert-Done.html), [Invoice-Preview](screens/Invoice-Preview.html) |
| [Convert-Done](screens/Convert-Done.html) | LIVE | Converted: what actually arrived (measured), price shown, invoice marked paid. | Done | [Home-Active](screens/Home-Active.html), [Invoice-Preview](screens/Invoice-Preview.html) |
| [Convert-Refused](screens/Convert-Refused.html) | LIVE | Nothing was converted: the price fell under the approved minimum; dollars untouched. | Get a new price | [Add-Wallet](screens/Add-Wallet.html), [Convert-Review](screens/Convert-Review.html) |

- **Currency-Settings** (412px). Maps to paymentPage.settlementAsset (EURE / USDC) and paymentPage.autoConvert. Applies only to payments to the payment link and invoices. fields: main, ask.
- **Convert-Review** (412px). Values come from POST /api/users/:id/crypto-deposits/:depositId (prepare): expectedEur, minEur, amountUsdc; window = AUTH_WINDOW_SEC. Refused below 1 USDC or before KYC. 
- **Convert-Done** (412px). Show creditedEur (measured balance delta), never expectedEur. status tags: RECEIVED.
- **Convert-Refused** (412px). Shown when the swap delivers less than minOut or the rate check refuses. 

## Get paid, invoices, contacts (phone)

Implement in: `app/send.js (payment page), business/views.js (invoicing)` (confirm against docs/architecture/product-architecture.md before moving code).

| Screen | Status | What it is | Primary action | Goes to |
|---|---|---|---|---|
| [GetPaid](screens/GetPaid.html) | LIVE | Get paid: payment link, invoice, your links, your public page. | Payment link | [Activity](screens/Activity.html), [GetPaid-Link](screens/GetPaid-Link.html), [Home-Active](screens/Home-Active.html), [Invoice-Editor](screens/Invoice-Editor.html), [More](screens/More.html), [Send-Hub](screens/Send-Hub.html) |
| [GetPaid-Link](screens/GetPaid-Link.html) | LIVE | Link created: QR, link, share. | Share | [GetPaid](screens/GetPaid.html) |
| [Contacts](screens/Contacts.html) | LIVE | Contacts list with search. | none | [Activity](screens/Activity.html), [Contact-Sheet](screens/Contact-Sheet.html), [GetPaid](screens/GetPaid.html), [Home-Active](screens/Home-Active.html), [More](screens/More.html), [Send-Hub](screens/Send-Hub.html) |
| [Contact-Sheet](screens/Contact-Sheet.html) | LIVE | Sheet over Contacts: one contact, pay, edit. | Pay | [Activity](screens/Activity.html), [GetPaid](screens/GetPaid.html), [Home-Active](screens/Home-Active.html), [More](screens/More.html), [Send-Amount](screens/Send-Amount.html), [Send-Hub](screens/Send-Hub.html) |
| [Invoices](screens/Invoices.html) | PARTIAL | Invoices list with status filters, issued vs from suppliers, Premium trial chip. | Issue invoice | [Activity](screens/Activity.html), [GetPaid](screens/GetPaid.html), [Home-Active](screens/Home-Active.html), [Invoice-Editor](screens/Invoice-Editor.html), [Invoice-Preview](screens/Invoice-Preview.html), [More](screens/More.html), [Plan](screens/Plan.html), [Send-Hub](screens/Send-Hub.html) |
| [Invoice-Editor](screens/Invoice-Editor.html) | PARTIAL | Issue an invoice on the phone: customer, number, language, dates, lines, VAT, preview. | Create | [Contacts](screens/Contacts.html), [Invoice-Preview](screens/Invoice-Preview.html), [Invoice-Profile](screens/Invoice-Profile.html), [Invoices](screens/Invoices.html) |
| [Invoice-Preview](screens/Invoice-Preview.html) | PARTIAL | Invoice preview in the invoice language, then share. | Share | [Invoice-Editor](screens/Invoice-Editor.html) |
| [Invoice-Profile](screens/Invoice-Profile.html) | PARTIAL | Invoice details set once: name, trade name, address, tax number. | Save | [Invoice-Editor](screens/Invoice-Editor.html) |

- **GetPaid** (412px). status tags: OPEN, PAID.
- **GetPaid-Link** (412px). Zold sends no email: 'Share' uses the share sheet. 
- **Contacts** (412px). fields: q.
- **Contact-Sheet** (412px). fields: q.
- **Invoices** (412px). Invoicing exists for business orgs; personal (freelancer) invoicing is new UI on the same API. Gated by plans.ts (Premium). status tags: OPEN, OVERDUE.
- **Invoice-Editor** (412px). German invoice rules: § 14 UStG fields; § 19 UStG note for Kleinunternehmer. fields: number, language, date, due, service_period, description, qty, price.
- **Invoice-Preview** (412px). status tags: OPEN.
- **Invoice-Profile** (412px). Asked the first time someone issues an invoice. fields: name_on_invoices, business_name_or_trade, address, tax_number_steuernummer.

## Business and settings (phone)

Implement in: `app/profile.js, app/signers.js, business/*` (confirm against docs/architecture/product-architecture.md before moving code).

| Screen | Status | What it is | Primary action | Goes to |
|---|---|---|---|---|
| [More](screens/More.html) | LIVE | More tab: organisation switcher, invoices, contacts, books, approvals, settings, coming soon, help. | none | [Activity](screens/Activity.html), [Approvals](screens/Approvals.html), [Contacts](screens/Contacts.html), [Desk-Books](screens/Desk-Books.html), [GetPaid](screens/GetPaid.html), [Home-Active](screens/Home-Active.html), [Invoices](screens/Invoices.html), [Pending](screens/Pending.html), [Send-Hub](screens/Send-Hub.html), [Settings](screens/Settings.html) |
| [Approvals](screens/Approvals.html) | LIVE | Company approvals inbox: waiting for you, ready to send, sent. | Approve | [GetPaid](screens/GetPaid.html), [Home-Business](screens/Home-Business.html), [More](screens/More.html), [Send-Hub](screens/Send-Hub.html) |
| [Members](screens/Members.html) | LIVE | Company members and what each can do. | none | [Approvals](screens/Approvals.html), [GetPaid](screens/GetPaid.html), [Home-Business](screens/Home-Business.html), [Invite-Dialog](screens/Invite-Dialog.html), [More](screens/More.html), [Send-Hub](screens/Send-Hub.html) |
| [Invite-Dialog](screens/Invite-Dialog.html) | LIVE | Invite dialog: role, then share the link yourself. | Share | [Approvals](screens/Approvals.html), [GetPaid](screens/GetPaid.html), [Home-Business](screens/Home-Business.html), [Members](screens/Members.html), [More](screens/More.html), [Send-Hub](screens/Send-Hub.html) |
| [Settings](screens/Settings.html) | LIVE | Settings: account, security, who approves payments, Monerium, documents, main currency, accounting connections, plan, coming soon, developer, appearance, sign out. | none | [Activity](screens/Activity.html), [Auth](screens/Auth.html), [Currency-Settings](screens/Currency-Settings.html), [GetPaid](screens/GetPaid.html), [Home-Active](screens/Home-Active.html), [Integrations](screens/Integrations.html), [More](screens/More.html), [Pending](screens/Pending.html), [Plan](screens/Plan.html), [Security](screens/Security.html), [Send-Hub](screens/Send-Hub.html) |
| [Security](screens/Security.html) | LIVE | Security: device-key warning, recovery, devices that can sign in, who approves payments, limits. | none | [Settings](screens/Settings.html) |
| [Plan](screens/Plan.html) | LIVE | Plan: current plan and the trial. | Start 30-day trial | [Settings](screens/Settings.html) |
| [Pending](screens/Pending.html) | LIVE | Coming soon: what this account cannot do yet and why (incl. Pending ID verification (KYC)). | none | [Monerium-Connect](screens/Monerium-Connect.html), [Plan](screens/Plan.html), [Settings](screens/Settings.html) |
| [Integrations](screens/Integrations.html) | PARTIAL | Accounting connections (phone): GetMyInvoices (Beta), Lexware CSV, sevDesk and DATEV (Soon). | none | [Activity](screens/Activity.html), [GetPaid](screens/GetPaid.html), [Home-Active](screens/Home-Active.html), [More](screens/More.html), [Send-Hub](screens/Send-Hub.html), [Settings](screens/Settings.html) |

- **More** (412px). status tags: Business.
- **Approvals** (412px). Four eyes: the drafter cannot approve (button disabled with the reason). status tags: NEEDS FIXING, WAITING FOR REVIEW.
- **Members** (412px). An org can never lose its last owner. 
- **Invite-Dialog** (412px). No email transport exists: never say 'we emailed them'. 
- **Settings** (412px). status tags: 1 to check.
- **Security** (412px). The storage warning is real (PRF missing); show only when detected. status tags: ACTIVE, OFF, This device.
- **Plan** (412px). No upgrade button until billing exists. status tags: ACTIVE.
- **Pending** (412px). status tags: SOON.
- **Integrations** (412px). GetMyInvoices is tested only against a stand-in: keep Beta. sevDesk and DATEV are not built. status tags: Beta, Soon.

## Desktop (sidebar layout)

Implement in: `index.html at >=1024px (personal), business.html + business/*.js (company)` (confirm against docs/architecture/product-architecture.md before moving code).

| Screen | Status | What it is | Primary action | Goes to |
|---|---|---|---|---|
| [Desk-Home](screens/Desk-Home.html) | NEW | Desktop home, personal: sidebar, balance, actions, activity table. | Send | [Activity](screens/Activity.html), [Add-Money](screens/Add-Money.html), [Desk-Books](screens/Desk-Books.html), [Desk-Contacts](screens/Desk-Contacts.html), [Desk-Invoices](screens/Desk-Invoices.html), [Desk-Search](screens/Desk-Search.html), [GetPaid](screens/GetPaid.html), [Pending](screens/Pending.html), [Send-Hub](screens/Send-Hub.html), [Settings](screens/Settings.html) |
| [Desk-Home-Business](screens/Desk-Home-Business.html) | LIVE | Desktop home, company: accounts, approvals waiting, recent. | New payment | [Desk-Approvals](screens/Desk-Approvals.html), [Desk-Books](screens/Desk-Books.html), [Desk-Contacts](screens/Desk-Contacts.html), [Desk-Invoice-Editor](screens/Desk-Invoice-Editor.html), [Desk-Invoices](screens/Desk-Invoices.html), [Desk-Members](screens/Desk-Members.html), [Desk-Search](screens/Desk-Search.html), [GetPaid](screens/GetPaid.html), [Pending](screens/Pending.html), [Send-Hub](screen |
| [Desk-Search](screens/Desk-Search.html) | NEW | Search (Cmd/Ctrl K) over payments, contacts, invoices. | Send | [Activity](screens/Activity.html), [Add-Money](screens/Add-Money.html), [Desk-Books](screens/Desk-Books.html), [Desk-Contacts](screens/Desk-Contacts.html), [Desk-Home](screens/Desk-Home.html), [Desk-Invoices](screens/Desk-Invoices.html), [GetPaid](screens/GetPaid.html), [Pending](screens/Pending.html), [Send-Hub](screens/Send-Hub.html), [Settings](screens/Settings.html) |
| [Desk-Approvals](screens/Desk-Approvals.html) | LIVE | Desktop approvals with batch send. | Send 2 approved | [Desk-Books](screens/Desk-Books.html), [Desk-Contacts](screens/Desk-Contacts.html), [Desk-Home-Business](screens/Desk-Home-Business.html), [Desk-Invoices](screens/Desk-Invoices.html), [Desk-Members](screens/Desk-Members.html), [Desk-Search](screens/Desk-Search.html), [GetPaid](screens/GetPaid.html), [Pending](screens/Pending.html), [Send-Hub](screens/Send-Hub.html), [Settings](screens/Settings.htm |
| [Desk-Invoices](screens/Desk-Invoices.html) | LIVE | Desktop invoices table. | Issue invoice | [Desk-Approvals](screens/Desk-Approvals.html), [Desk-Books](screens/Desk-Books.html), [Desk-Contacts](screens/Desk-Contacts.html), [Desk-Home-Business](screens/Desk-Home-Business.html), [Desk-Invoice-Editor](screens/Desk-Invoice-Editor.html), [Desk-Members](screens/Desk-Members.html), [Desk-Search](screens/Desk-Search.html), [GetPaid](screens/GetPaid.html), [Pending](screens/Pending.html), [Send-H |
| [Desk-Invoice-Editor](screens/Desk-Invoice-Editor.html) | LIVE | Invoice editor with live paper preview. | Create and share | [Desk-Approvals](screens/Desk-Approvals.html), [Desk-Books](screens/Desk-Books.html), [Desk-Contacts](screens/Desk-Contacts.html), [Desk-Home-Business](screens/Desk-Home-Business.html), [Desk-Invoices](screens/Desk-Invoices.html), [Desk-Members](screens/Desk-Members.html), [Desk-Search](screens/Desk-Search.html), [GetPaid](screens/GetPaid.html), [Pending](screens/Pending.html), [Send-Hub](screens/ |
| [Desk-Books](screens/Desk-Books.html) | LIVE | Books: memos, categories, receipts, exports, connections. | none | [Desk-Approvals](screens/Desk-Approvals.html), [Desk-Contacts](screens/Desk-Contacts.html), [Desk-Home-Business](screens/Desk-Home-Business.html), [Desk-Integrations](screens/Desk-Integrations.html), [Desk-Invoices](screens/Desk-Invoices.html), [Desk-Members](screens/Desk-Members.html), [Desk-Search](screens/Desk-Search.html), [GetPaid](screens/GetPaid.html), [Pending](screens/Pending.html), [Send |
| [Desk-Contacts](screens/Desk-Contacts.html) | LIVE | Contacts table with a detail drawer. | Add contact, Pay Druckerei Kessler | [Desk-Approvals](screens/Desk-Approvals.html), [Desk-Books](screens/Desk-Books.html), [Desk-Home-Business](screens/Desk-Home-Business.html), [Desk-Invoices](screens/Desk-Invoices.html), [Desk-Members](screens/Desk-Members.html), [Desk-Search](screens/Desk-Search.html), [GetPaid](screens/GetPaid.html), [Pending](screens/Pending.html), [Send-Amount](screens/Send-Amount.html), [Send-Hub](screens/Send |
| [Desk-Members](screens/Desk-Members.html) | LIVE | Members with the invite dialog. | Invite member, Copy link | [Desk-Approvals](screens/Desk-Approvals.html), [Desk-Books](screens/Desk-Books.html), [Desk-Contacts](screens/Desk-Contacts.html), [Desk-Home-Business](screens/Desk-Home-Business.html), [Desk-Invoices](screens/Desk-Invoices.html), [Desk-Search](screens/Desk-Search.html), [GetPaid](screens/GetPaid.html), [Pending](screens/Pending.html), [Send-Hub](screens/Send-Hub.html), [Settings](screens/Settings |
| [Desk-Integrations](screens/Desk-Integrations.html) | PARTIAL | Connections: GetMyInvoices connect drawer (API key), Lexware CSV, sevDesk and DATEV Soon. | Connect, Check and connect | [Desk-Approvals](screens/Desk-Approvals.html), [Desk-Books](screens/Desk-Books.html), [Desk-Contacts](screens/Desk-Contacts.html), [Desk-Home-Business](screens/Desk-Home-Business.html), [Desk-Invoices](screens/Desk-Invoices.html), [Desk-Members](screens/Desk-Members.html), [Desk-Search](screens/Desk-Search.html), [GetPaid](screens/GetPaid.html), [Pending](screens/Pending.html), [Send-Hub](screens/ |

- **Desk-Home** (1440px). Same data as Home-Active; layout from 1024px. status tags: IN FLIGHT, PAID, RECEIVED.
- **Desk-Home-Business** (1440px). business.html restyle. status tags: PAID, RECEIVED.
- **Desk-Search** (1440px). Dialog with a real input; Esc closes; results keyboard-navigable. fields: q; status tags: IN FLIGHT, PAID, RECEIVED.
- **Desk-Approvals** (1440px). status tags: APPROVED, NEEDS FIXING, WAITING FOR REVIEW.
- **Desk-Invoices** (1440px). status tags: OPEN, OVERDUE, PAID.
- **Desk-Invoice-Editor** (1440px). Preview follows the invoice language, not the app language. fields: customer, language, invoice_date, service_date, due, description, quantity, unit_price.
- **Desk-Members** (1440px). status tags: ACTIVE.
- **Desk-Integrations** (1440px). Say where to find the key in GetMyInvoices. Beta label stays until a real account has been used. fields: api_key; status tags: Beta, Ready, Soon.

## Account recovery

Implement in: `app/recovery.js + routes/recovery-candide.ts, routes/recovery-zoldenburg.ts` (confirm against docs/architecture/product-architecture.md before moving code).

| Screen | Status | What it is | Primary action | Goes to |
|---|---|---|---|---|
| [Recover](screens/Recover.html) | PARTIAL | Recover your account: email first. | Continue | [Auth](screens/Auth.html), [Recovery-Codes](screens/Recovery-Codes.html) |
| [Recovery-Codes](screens/Recovery-Codes.html) | PARTIAL | Enter the email and phone codes. | Continue | [Recover](screens/Recover.html), [Recovery-Pending](screens/Recovery-Pending.html) |
| [Recovery-Pending](screens/Recovery-Pending.html) | PARTIAL | Waiting period on the new phone. | none | [Auth](screens/Auth.html), [Recovery-Codes](screens/Recovery-Codes.html) |
| [Recovery-Zoldenburg](screens/Recovery-Zoldenburg.html) | PARTIAL | Recovery through Zoldenburg: reference code and what happens next. | Email support | [Recover](screens/Recover.html) |
| [Recovery-Alert](screens/Recovery-Alert.html) | PARTIAL | Old phone: someone is moving your account; cancel or confirm. | Cancel recovery | [Home-Active](screens/Home-Active.html) |
| [Recovery-Done](screens/Recovery-Done.html) | PARTIAL | Recovery complete. | Sign in | [Home-Active](screens/Home-Active.html), [Recovery-Choice](screens/Recovery-Choice.html) |

- **Recover** (412px). No recovery has run on chain (docs/status.md). fields: rc-email.
- **Recovery-Codes** (412px). No mail transport exists yet: say what the user must do to get a code. fields: code; status tags: Entering, Next.
- **Recovery-Pending** (412px). The new phone cannot sign in or spend during the grace period. 
- **Recovery-Zoldenburg** (412px). Zoldenburg can only start a move; the waiting period always applies. 

## Errors and 404

Implement in: `app/core.js error handling, sw.js offline fallback, 404.html` (confirm against docs/architecture/product-architecture.md before moving code).

| Screen | Status | What it is | Primary action | Goes to |
|---|---|---|---|---|
| [App-Offline](screens/App-Offline.html) | NEW | Offline. | Try again | [Home-Active](screens/Home-Active.html) |
| [App-Error](screens/App-Error.html) | NEW | Something went wrong on our side. | Try again | [Home-Active](screens/Home-Active.html) |
| [App-Maintenance](screens/App-Maintenance.html) | NEW | Maintenance / updating. | Try again | [Home-Active](screens/Home-Active.html) |
| [App-404](screens/App-404.html) | NEW | A pay, invoice or invite link that does not work. | Go to Home | [Home-Active](screens/Home-Active.html) |
| [Web-404](screens/Web-404.html) | NEW | Website 404, desktop. | none | [AccountType](screens/AccountType.html), [Auth](screens/Auth.html), [Imprint](screens/Imprint.html), [Privacy](screens/Privacy.html), [Regulatory](screens/Regulatory.html), [Terms](screens/Terms.html) |
| [Web-404-Mobile](screens/Web-404-Mobile.html) | NEW | Website 404 under 760px. | none | [AccountType](screens/AccountType.html), [Auth](screens/Auth.html), [Imprint](screens/Imprint.html), [Privacy](screens/Privacy.html), [Regulatory](screens/Regulatory.html), [Terms](screens/Terms.html) |

- **App-Offline** (412px). sw.js fallback; retry. 
- **App-Error** (412px). Show a reference id; never a stack trace. 
- **App-Maintenance** (412px). Driven by /api/health, not a hard-coded flag. 
- **App-404** (412px). A wrong code under a handle is a 404 (credentials rule). 
- **Web-404** (1440px). Replace public/404.html. Two actions only: homepage, log in. 
- **Web-404-Mobile** (390px). Same page, responsive. 

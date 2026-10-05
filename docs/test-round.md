# Internal test round — zoldhq.com

The checklist human testers work through on zoldhq.com (Base Sepolia +
Monerium sandbox, dollar = zUSD). Testers tick checks and file bugs on the
shared page, not here: https://claude.ai/artifact/6Y7J8Lz8TcPWQDFk22Djr2
(private; give each tester Contributor access from its Share menu). This file
holds the same checks so agents can read and update them; change both
together.

Written for testers: plain steps, no internals. What has never run is in
`docs/status.md`.

## For testers

- Everything is test money: test EURe, test zUSD, sandbox IBANs. Never enter
  a real card number, real ID or real bank login.
- Closing the test server deletes every test account.
- Test on at least one phone (iOS Safari or Android Chrome) and one desktop
  browser, and name the device in each bug.
- A bug says what you did, what you expected, what happened, and the time.
- "Blocked" means you could not reach the check.
- Try to break things: double-tap, go back mid-flow, reload, two tabs, weak
  mobile data, odd text.

Tags: **[new]** shipped since the last round · **[retest]** a fix to confirm ·
**[first run]** has never worked end to end · **[must stay off]** should be
hidden or refused.

## Public pages

Start signed out, on a phone and a desktop, in light and dark mode.

- [ ] The landing page loads fast and every link and button goes somewhere real
  Check the header menu on a phone, the FAQ and the footer links.
- [ ] /legal, /privacy, /partner-terms and /imprint all open and read correctly **[new]**
  The imprint should name Zoldenburg UG (haftungsbeschränkt) and its Munich address.
- [ ] The cookie notice never covers a button you need
  Especially the Continue button during signup.
- [ ] A made-up address shows the 404 page, not a blank screen or raw code
  Try zoldhq.com/nothing-here and zoldhq.com/pay/doesnotexist.
- [ ] Link previews look right when shared
  Paste the landing page link into a chat app and check the preview card.

## Personal signup

Use a fresh email. Choose Personal when Monerium asks which kind of account.

- [ ] Account step: name, email, country, citizenship, US-person question, consents
  Try names with accents, hyphens and apostrophes (Zoë O'Brien-Müller). Emoji and digits should be refused with a clear message.
- [ ] A US person, or someone from a blocked country, is refused before anything is created
- [ ] Passkey step: there is no skip, and cancelling the prompt gives a readable retry
  On a desktop the error must not mention Face ID.
- [ ] The account is created without a fee; reloading during that step picks up where it left off
- [ ] Recovery step: opt in to Zoldenburg recovery, or skip after accepting the warning
- [ ] Connect Monerium by signing in there and come back to the app
  Also try the browser back button at Monerium, and reopening an old sign-in link.
- [ ] Connect with your own Monerium sandbox API keys instead; production keys are refused
- [ ] Choosing a company profile at Monerium for a personal signup gives a clear refusal that tells you to sign out at Monerium first
- [ ] Activate the IBAN with your passkey; the IBAN appears and the account turns active
  "IBAN on its way" and "active" must never show together.
- [ ] Profile tab: you can edit your name until Monerium verifies it, then it locks **[new]**
- [ ] Log out, then log in with the passkey on the same device and on a second device

## Company signup and Zold Business

Needs a separate login with a company profile at Monerium.

- [ ] A company signup needs a company profile at Monerium; a personal one is refused
- [ ] /app shows your own account only; companies open in Zold Business **[new]**
- [ ] The company account is named after the company and never labelled Personal **[retest]**
- [ ] Documents for a company account name the company, and the person operating it where different **[retest]**
- [ ] Import an existing Safe: prepare, change the owner in Safe{Wallet}, confirm
  Recovery must not be offered on an imported Safe.
- [ ] An IBAN on an imported Safe reads active in both /app and Zold Business **[retest]**
- [ ] Zold Business at phone width: the Menu closes with Back, and locked tabs say why **[new]**
- [ ] Settings → Access for the company login **[new]**
- [ ] A Safe already used by one company is refused for a second company, with a confirm step first **[new]**

## Adding money

Fill your account before testing sends and the swapper.

- [ ] Add money → test euros: 100 test EURe arrive and show in Activity
- [ ] /faucet sends EURe, zUSD and EURC to a wallet address **[new]**
  The faucet should call the dollar token zUSD, not USDC.
- [ ] A sandbox SEPA transfer in mints EURe and shows in Activity as a bank transfer
- [ ] "From a crypto wallet" shows your account address and a QR of that same address
  Scan the QR with another phone and compare the address character by character.
- [ ] EURe sent on chain from another wallet is recorded as money in **[retest]**
- [ ] The BIC is Monerium's everywhere: home, payment page and documents **[retest]**

## zUSD, the test dollar

On this test site the dollar is zUSD, a token we mint ourselves. On mainnet it will be Circle's USDC. Every place a user sees the dollar should say zUSD here.

- [ ] Home, Activity, Get paid, Add money and Zold Business all say zUSD, not USDC **[new]**
  Known gap, no need to report: transfer receipts, Belege and statement notes still say USDC.
- [ ] The payment page warns "Only zUSD on the Base network" **[new]**
- [ ] Send zUSD from /faucet to your account: it shows as a dollar payment within a few minutes **[new]**
  Note the time you sent it and the time it appeared.
- [ ] The euro value shown on arrival is close to today's EUR/USD rate **[first run]**
  With no rate there should be no euro value at all, never €0.00.
- [ ] Error messages from the server say zUSD too **[new]**
  Try an amount over your balance on a dollar screen and read the message.
- [ ] Send a different token (EURC, or zUSD on another chain) to the account and report what the app shows **[first run]**
  It must not be counted as zUSD.
- [ ] Sending crypto out is marked SOON and cannot be started **[must stay off]**

## The swapper: zUSD to euros

Dollar payments convert to EURe inside your own account through a small Uniswap pool (zUSD/EURe, about 1,000 EURe deep). Large amounts should be refused, never half done. The setting lives under Get paid → currency.

- [ ] Currency setting: euro with "ask me to convert", or keep dollars as zUSD **[new]**
  Switch between them and reload; the choice must stick.
- [ ] With "ask me" on, a zUSD payment shows under "Waiting to convert" **[first run]**
- [ ] The Convert screen shows what you convert, what you get, and the minimum you will accept **[first run]**
  Let the price refresh a few times. Does the countdown end cleanly?
- [ ] Convert with Face ID or fingerprint: EURe arrives, the zUSD is gone, and the balances add up **[first run]**
  Write down both balances before and after. The euros credited must be what actually arrived, not the quote.
- [ ] Cancel the passkey prompt: nothing converts, and the screen says so **[first run]**
- [ ] Double-tap Convert, or convert the same payment in two tabs: it converts only once **[first run]**
- [ ] Convert more than 500 zUSD: refused with a clear reason, nothing half converted **[first run]**
  Get extra zUSD from /faucet several times first.
- [ ] Open the Convert link of a payment already converted: it says so **[first run]**
- [ ] If less than the shown minimum would arrive, nothing converts and the zUSD stays **[first run]**
  Hard to force. Report it if you ever see a conversion below the minimum.
- [ ] The "Converted" screen explains any difference between the shown price and what arrived **[first run]**
- [ ] The conversion shows in Activity and on the statement as one clear entry **[first run]**
- [ ] With "keep dollars" chosen, a zUSD payment stays as zUSD and nothing asks to convert **[first run]**

## Sending euros (SEPA)

Send only to sandbox IBANs: your own, or another tester's.

- [ ] A new payee with a wrong IBAN checksum or an empty name is refused
- [ ] Amounts of 0, negative, three decimals, more than your balance, and more than €2,500 in a day
  Each one needs its own clear message.
- [ ] The quote shows a €0 fee and expires; you can get a fresh one
- [ ] The passkey prompts appear in order, and cancelling any of them sends nothing **[first run]**
- [ ] The transfer moves from created to paid and the reference matches **[first run]**
- [ ] Sending to your own IBAN works, or warns you clearly **[first run]**
- [ ] Back, reload or closing the tab during a send never sends twice **[first run]**
- [ ] Cash pick-up is not offered anywhere **[must stay off]**

## Getting paid

- [ ] Claim a payment page handle; look-alike, partner and impersonating names are refused **[new]**
  Try zoldsupport, monerium, paypa1, and an existing handle in capitals.
- [ ] /pay/your-handle shows one address, a QR of it, and says the page is public
- [ ] Payment links: fixed and open amount; crypto, bank or both; 7-day expiry
- [ ] Share a payment link through WhatsApp, Mail and Notes; it opens the right request
- [ ] Pay a link with the exact zUSD amount: it turns paid **[first run]**
- [ ] Pay a link with slightly less, much less (partial) and slightly more: each shows the right state **[first run]**
- [ ] A link's code under someone else's handle shows "not found"
- [ ] Cancel a link; an expired or cancelled link refuses payment
- [ ] Receipt sharing: each switch removes that detail from the shared page, and revoke works
- [ ] Names like yourname.zoldhq.com are not offered on this site **[must stay off]**

## Security and recovery

- [ ] After skipping recovery, a "Recovery isn't set up" banner shows; it can be dismissed and set up later from Security
- [ ] Enrol in Zoldenburg recovery, then remove it **[first run]**
- [ ] Add a spending limit for someone; the text says Zold cannot move that allowance **[new]**
- [ ] The Security screen shows how your device key is protected
- [ ] Email or SMS recovery is not offered **[must stay off]**

## Account documents

- [ ] Create a receipt, a statement, a balance confirmation and a proof of ownership
- [ ] Each document's /v/ link verifies; a revoked one says it is revoked
- [ ] The statement includes the €100 test deposit and any zUSD conversions **[retest]**
- [ ] The proof of ownership is clear to someone at a bank **[retest]**
- [ ] The same documents open from Zold Business → Accounts → Statements and documents

## Zold Business features

Needs two or more testers in one company. Switch roles between viewer, accountant, payer, admin and owner.

- [ ] Create the company; edit legal name, tax ID and address
- [ ] Invite link: only the matching email can accept it, once, within 3 days
- [ ] Each role sees and does only what it should; a non-member gets "not found"
  Copy a link from one company and open it signed in as someone outside it.
- [ ] The last owner cannot be demoted or deactivated
- [ ] Payment drafts: the reviewer cannot be the drafter, and editing someone's draft makes you the drafter
- [ ] Changing a payee after approval blocks the payment
- [ ] Bulk payment CSV import, including a broken row
- [ ] Outgoing invoice: checks, issue, payment link on the invoice, paid in zUSD or by SEPA **[retest]**
- [ ] The invoice IBAN defaults to the account IBAN and warns if you change it
- [ ] Books: bank lines, Belege, Lexware CSV and the month report
- [ ] Imported wallets: add, remove, and "not syncing" shown plainly
- [ ] Invoices made from wallet receipts **[first run]**
- [ ] Cmd/Ctrl-K search finds people, invoices and payments
- [ ] Shopify shows as not available **[must stay off]**

## Everywhere

These find the most bugs. Do them as you go, not only at the end.

- [ ] Phone, tablet and wide desktop: nothing overlaps or is cut off
- [ ] Dark and light mode on every screen you visit
- [ ] Install to the home screen on Android and desktop Chrome; on iOS, tell us exactly what happened **[first run]**
  On iOS the installed app may not find the account you made in Safari.
- [ ] In airplane mode the app opens, and no money action can start
- [ ] Two tabs or two devices at once: no stale balance, no double send
- [ ] Browser back and forward in every flow; links still work after a reload
- [ ] Slow network: loading states show, nothing freezes
- [ ] Wording: no typos, no jargon, nothing that claims something happened when it did not
  Report every sentence that confused you.

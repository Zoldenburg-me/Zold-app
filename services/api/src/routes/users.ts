/**
 * Accounts: signup, the account read and the KYC state.
 *
 * The country, citizenship and US answers resolve to a segment, whose
 * capabilities every later route checks: at signup when the body carries
 * them, otherwise from Home (POST /users/:id/residence). A blocked applicant is told what Zold
 * cannot offer, not which rule fired: naming the rule tells someone which
 * answer to change. The internal reason code goes to the audit log.
 *
 * Email is a contact channel, not an identity: Monerium owns KYC and the
 * passkey is the login. It lets a device without the passkey name its account,
 * and gives the OS passkey picker a label that does not collide. Nothing here
 * verifies it.
 */
import express from "express";
import { wrap } from "./util.js";
import { randomUUID } from "node:crypto";
import { EMAIL_VERIFICATION, KYC } from "../config.js";
import { accountBalances } from "../chain.js";
import { auditEntry, redact } from "../audit.js";
import { normaliseCountryCode } from "../country-policy.js";
import { resolveSegment, type Segment } from "../domain/segments.js";
import { store, type User } from "../store.js";
import { publicUser, withSession } from "../users/public-user.js";
import { cleanName, cleanPersonName, nameChange } from "../users/display-name.js";
import { findIbanBic, refreshPendingIbanThrottled, verifyIbanBinding } from "../adapters/monerium-sandbox.js";
import { normalizeIban } from "../sepa.js";
import { emailHeldBy, emailLooksValid } from "../domain/email.js";
import { describeCause, redactedMessage } from "../http/log-cause.js";

/** Consents a signup body may carry; the client sends one or two. */
const MAX_SIGNUP_CONSENTS = 4;
/** Distinct citizenships a signup may declare; more is refused, never cut. */
const MAX_DECLARED_CITIZENSHIPS = 10;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;


/** requireUserSession is injected — server.ts owns authentication. */
export interface UserDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => Promise<unknown>;
}

/** Wording versions: the three separate questions, and the single combined
 *  one the app asks now. Recorded with every answer so a later reading knows
 *  what was actually put to the person. */
const US_QUESTIONS_VERSION = "2026-08-31";
const US_QUESTION_COMBINED_VERSION = "2026-09-05-combined";
const CONSENT_VERSION = "2026-08-31";

/**
 * What a blocked person is told.
 *
 * Each line says what Zold cannot offer. It cites no rule, country policy or
 * partner: the user cannot act on them, and naming the rule tells someone which
 * answer to change. The internal reasonCode goes to the audit log.
 *
 * No legal advice and no suggestion of wrongdoing, so the unsupported case
 * talks about the residence, not the person.
 */
const BLOCKED_COPY: Record<Extract<Segment, `BLOCKED_${string}`>, string> = {
  BLOCKED_US: "Zold is not available to US persons.",
  BLOCKED_SANCTIONED: "Zold is not available in your country.",
  BLOCKED_UNSUPPORTED: "Zold cannot open an account for residents of your country yet.",
};

/** What a blocked person is sent: what Zold cannot offer, not which rule
 *  fired. reasonCode stays in the log: publishing it tells someone which
 *  answer to change. */
const blockedBody = (segment: Segment) => ({ error: BLOCKED_COPY[segment as keyof typeof BLOCKED_COPY], code: segment });

/**
 * A body's residence, citizenships and US answers, resolved to a segment.
 *
 * Don't call `countryBlock()` first: it only answers "will Monerium serve this
 * residence", so on its own it would refuse, say, Nigerians with a message
 * about Monerium's country policy, naming a partner the user was never going
 * to use. resolveSegment consults it internally, asks the questions
 * separately and returns which one decided.
 */
function decideSegment(body: any, type: "individual" | "company") {
  const { country, citizenships, usAnswers, companyIncorporationCountry, softSignals } = body ?? {};
  // The app asks one combined question (citizen, Green Card or tax
  // resident); older clients and the harnesses still send the three. Keep
  // whichever shape was answered; don't translate one into the other.
  const combined = typeof usAnswers?.usPerson === "boolean";
  const answers = {
    ...(combined
      ? { usPerson: usAnswers.usPerson === true }
      : {
          usCitizen: usAnswers?.usCitizen === true,
          usGreenCard: usAnswers?.usGreenCard === true,
          usTaxResident: usAnswers?.usTaxResident === true,
        }),
    ...(type === "company"
      ? { companyUsNexus: usAnswers?.companyUsNexus === true }
      : { companyUsNexus: null }),
  };
  // Store only citizenships the caller declared. Without any, screening
  // uses residence, but residence is never saved as a citizenship.
  // The list is anonymous and kept whole (on the row, or in the audit row
  // on a refusal), so it is de-duplicated and refused when too long. It is
  // never cut: a cut could drop the entry screening has to see.
  const declaredCitizenships: string[] | null = Array.isArray(citizenships) && citizenships.length
    ? [...new Set<string>(citizenships.map((c: any) => normaliseCountryCode(String(c))))]
    : null;
  if (declaredCitizenships && declaredCitizenships.length > MAX_DECLARED_CITIZENSHIPS) {
    return { refuse: { error: `declare at most ${MAX_DECLARED_CITIZENSHIPS} citizenships` } };
  }
  const incorporation = companyIncorporationCountry ? String(companyIncorporationCountry) : undefined;
  try {
    const decision = resolveSegment({
      residence: String(country),
      citizenships: declaredCitizenships ?? [String(country)],
      accountType: type,
      usAnswers: answers,
      ...(incorporation ? { companyIncorporationCountry: incorporation } : {}),
      ...(softSignals ? { softSignals } : {}),
    });
    return { decision, answers, combined, declaredCitizenships, incorporation, residence: normaliseCountryCode(String(country)) };
  } catch (err: any) {
    return { refuse: { error: redactedMessage(err) } };
  }
}
type Decided = Exclude<ReturnType<typeof decideSegment>, { refuse: unknown }>;

const decisionAudit = (d: Decided, type: "individual" | "company") => ({
  residence: d.residence,
  ...(d.declaredCitizenships ? { citizenships: d.declaredCitizenships } : {}),
  accountType: type,
  usAnswers: d.answers,
  segment: d.decision.segment,
  reasonCode: d.decision.reasonCode,
});

/** Write a decision that opened (or keeps) an account onto its row. */
async function applyDecision(userId: string, d: Decided, softSignals: any): Promise<void> {
  const { decision } = d;
  // One transaction: a segment saved without its country and answers could
  // not be retried, as the route decides once.
  await store.tx(async () => {
  await store.setSegment(userId, {
    value: decision.segment,
    reasonCode: decision.reasonCode,
    decidedAt: new Date().toISOString(),
    decidedBy: "system",
    ...(decision.gate ? { gate: decision.gate } : {}),
  });
  await store.updateUser(userId, {
    country: d.residence,
    ...(d.declaredCitizenships ? { citizenships: d.declaredCitizenships } : {}),
    ...(d.incorporation ? { companyIncorporationCountry: normaliseCountryCode(d.incorporation) } : {}),
    ...(decision.review
      ? {
          softSignals: {
            // Only the three signals the resolver knows; the body is not
            // spread into the row.
            ...(softSignals?.usPhoneCode === true ? { usPhoneCode: true } : {}),
            ...(softSignals?.usMailingAddress === true ? { usMailingAddress: true } : {}),
            ...(softSignals?.usIpAtSignup === true ? { usIpAtSignup: true } : {}),
            flaggedAt: new Date().toISOString(),
            reconfirmationPending: true,
          },
        }
      : {}),
  });
  await store.addUsAnswers(userId, {
    ...d.answers,
    answeredAt: new Date().toISOString(),
    version: d.combined ? US_QUESTION_COMBINED_VERSION : US_QUESTIONS_VERSION,
  });
  });
}

export function createUserRouter(deps: UserDeps) {
  const { requireUserSession } = deps;
  const router = express.Router();

  router.post(
    "/users",
    wrap(async (req, res) => {
      const { name, country, email, accountType, consents, companyName } = req.body ?? {};
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "name and email required" });
      }
      // The same rule as a later rename (users/display-name.ts); a company
      // signup's representative may have a longer name than a person's own.
      const checkedName = cleanPersonName(name, { min: 1, max: 120 });
      if ("code" in checkedName) return res.status(400).json(checkedName);
      const signupName = checkedName.name;
      /**
       * Email is required as a channel, not an identity (identity is
       * Monerium's; the passkey is the login). It lets the account be found
       * and recovered from a device without the passkey (Candide's guardian
       * looks it up by email), and gives the OS passkey picker a label that
       * does not collide the way a full name does. It is verified only by
       * Candide's OTP at recovery enrolment. Nothing here sends mail.
       */
      const emailNorm = typeof email === "string" ? email.trim() : "";
      if (!emailNorm) return res.status(400).json({ error: "name and email required" });
      if (!emailLooksValid(emailNorm)) {
        return res.status(400).json({ error: "invalid email" });
      }
      // One claimable account per email. Recovery resolves an email to an
      // account, so two accounts with passkeys on one address would make the
      // lookup ambiguous. A row with no passkey is onboarding that stopped
      // before any credential existed (nothing can sign in to it), so the same
      // person may start again after a failed ceremony.
      if (emailHeldBy(await store.usersByEmail(emailNorm), EMAIL_VERIFICATION.enabled)) {
        return res.status(409).json({
          error: "an account already uses this email — sign in with your passkey, or recover the account if you lost the device",
          code: "EMAIL_IN_USE",
        });
      }


      /**
       * Segmentation. The app's signup sends no country: the account opens
       * UNDECIDED, with its own Safe and no partner or balance route, and
       * POST /users/:id/residence decides it from Home. A body that does carry
       * a country (the harnesses, older clients) is decided here, as before.
       *
       * Callers that send no account type are read as an individual.
       */
      const type: "individual" | "company" = accountType === "company" ? "company" : "individual";
      const d = typeof country === "string" && country ? decideSegment(req.body, type) : null;
      if (d && "refuse" in d) return res.status(400).json(d.refuse);

      // A blocked segment is recorded before it is refused: the decision has to
      // be auditable whether or not an account exists, and "we refused someone
      // and kept no record of why" is the failure this log exists to prevent.
      if (d?.decision.segment.startsWith("BLOCKED_")) {
        await store.audit(auditEntry("segment.decided", {
          ...decisionAudit(d, type),
          email: redact(emailNorm),
          outcome: "refused_at_signup",
        }));
        return res.status(403).json(blockedBody(d.decision.segment));
      }
      const orgName = type === "company" && typeof companyName === "string" && companyName.trim()
        ? cleanName(companyName, { min: 2, max: 120 }) : undefined;
      if (orgName === null) {
        return res.status(400).json({ code: "NAME_INVALID", error: `The company name needs 2 to 120 characters, without hidden or control characters.` });
      }
      const id = randomUUID();
      // The real address is set by passkey Safe deployment. Identity
      // is Monerium's: the account stays pending until a Monerium connection
      // (OAuth or the user's own API keys) is activated and attributes an IBAN
      // to the Safe. No locally issued IBAN, and no auto-approval anywhere money
      // is real — KYC.autoApprove is true only on the hardhat harness chain.
      const approved = KYC.autoApprove;
      const user: User = {
        id,
        name: signupName,
        email: emailNorm,
        country: d?.residence ?? "",
        kycStatus: approved ? "approved" : "pending",
        kyc: approved
          ? { provider: "mock", checkedAt: new Date().toISOString(), reason: "hardhat harness auto-approval" }
          : { provider: "monerium" },
        iban: "",
        address: ZERO_ADDRESS,
        wallet: { type: "candide-safe", deployed: false },
        // Harness accounts are "funded" with no IBAN: hardhat has no Monerium,
        // and the suites mint EURe to the Safe directly.
        funding: approved
          ? { mode: "sandbox", status: "active", detail: "hardhat harness account — no Monerium IBAN exists on this chain" }
          : { mode: "sandbox", status: "kyc_pending" },
        createdAt: new Date().toISOString(),
        accountType: type,
        ...(orgName ? { companyName: orgName } : {}),
      };
      // One consent per kind and partner, at most MAX_SIGNUP_CONSENTS: the
      // list comes from an unauthenticated body.
      const given = new Map<string, any>();
      for (const c of Array.isArray(consents) ? consents.slice(0, MAX_SIGNUP_CONSENTS) : []) {
        if (c?.kind !== "zold_terms" && c?.kind !== "partner_share") continue;
        const partner = typeof c.partner === "string" && c.partner ? c.partner.slice(0, 80) : undefined;
        given.set(`${c.kind}:${partner ?? ""}`, { ...c, partner });
      }
      // One transaction: a row left without its segment or account type by a
      // failed later write would be an account no route can decide.
      await store.tx(async () => {
        await store.addUser(user);
        if (d) await applyDecision(user.id, d, req.body?.softSignals);
        else {
          await store.setSegment(user.id, { value: "UNDECIDED", reasonCode: "residence_not_given", decidedAt: new Date().toISOString(), decidedBy: "system" });
        }
        for (const c of given.values()) {
          await store.addConsent(user.id, {
            kind: c.kind,
            ...(c.partner ? { partner: c.partner } : {}),
            version: typeof c.version === "string" && c.version ? c.version.slice(0, 40) : CONSENT_VERSION,
            at: new Date().toISOString(),
            // No IP: the consent is tied to the account that gave it, and an
            // address stored here was echoed to the operator's user list.
          });
        }
        await store.audit(auditEntry("segment.decided", {
          ...(d ? decisionAudit(d, type) : { accountType: type, segment: "UNDECIDED", reasonCode: "residence_not_given" }),
          softUsSignals: d?.decision.review?.softUsSignals ?? [],
          outcome: "account_created",
        }, user.id));
      });
      // The row as stored: the segment, consents and patch above went onto it.
      res.status(201).json(await withSession((await store.findUser(user.id))!));
    }),
  );

  router.get(
    "/users/:id",
    wrap(async (req, res) => {
      let user = await store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!(await requireUserSession(req, res, user.id))) return;
      // Both throttled per user (the app polls this every few seconds); a
      // failed read changes nothing.
      user = user.funding?.status === "iban_pending" ? await refreshPendingIbanThrottled(user) : await verifyIbanBinding(user);
      const balances = await accountBalances(user.address);
      res.json({ ...(await publicUser(user)), ...balances });
    }),
  );

  /**
   * Where the person lives and the US question, asked on Home after a signup
   * that gave neither. Decides the segment once: an account that has one is
   * refused. A blocked answer opens nothing and leaves the account as it is.
   */
  router.post(
    "/users/:id/residence",
    wrap(async (req, res) => {
      const found = await store.findUser(req.params.id);
      if (!found) return res.status(404).json({ error: "user not found" });
      if (!(await requireUserSession(req, res, found.id))) return;
      // The row held: two answers sent at once decide the segment once.
      return store.tx(async () => {
      const user = (await store.lockUser(found.id))!;
      if (user.segment?.value !== "UNDECIDED") {
        return res.status(409).json({ code: "RESIDENCE_SET", error: "This account has already said where it is based." });
      }
      const type = user.accountType === "company" ? "company" : "individual";
      if (typeof req.body?.country !== "string" || !req.body.country) return res.status(400).json({ error: "country required" });
      // Asked and answered, not assumed: a missing answer is not a "no".
      const ua = req.body.usAnswers;
      if (typeof ua?.usPerson !== "boolean" || (type === "company" && typeof ua.companyUsNexus !== "boolean")) {
        return res.status(400).json({ error: "The US questions must be answered yes or no." });
      }
      // Never from the body here: the signals are the server's to raise.
      const d = decideSegment({ ...req.body, softSignals: undefined }, type);
      if ("refuse" in d) return res.status(400).json(d.refuse);
      const blocked = d.decision.segment.startsWith("BLOCKED_");
      await store.audit(auditEntry("segment.decided", {
        ...decisionAudit(d, type),
        outcome: blocked ? "refused_at_residence" : "residence_given",
      }, user.id));
      if (blocked) return res.status(403).json(blockedBody(d.decision.segment));
      await applyDecision(user.id, d, undefined);
      res.json(await publicUser((await store.findUser(user.id))!));
      });
    }),
  );

  /**
   * The person's name: editable until Monerium verifies them, never on a
   * company login (users/display-name.ts). Their personal space is named
   * after them, so it follows.
   */
  router.patch(
    "/users/:id/name",
    wrap(async (req, res) => {
      const user = await store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!(await requireUserSession(req, res, user.id))) return;
      const r = nameChange(user, req.body?.name);
      if ("code" in r) return res.status(r.status).json({ code: r.code, error: r.error });
      const updated = await store.updateUser(user.id, { name: r.name });
      // That it changed, not to what: the name itself is on the user row.
      await store.audit(auditEntry("user.name_changed", {}, user.id));
      for (const { org } of (await store.organisationsForUser(user.id))) {
        if (org.type === "personal") await store.updateOrganisation(org.id, { name: r.name });
      }
      res.json(await publicUser(updated));
    }),
  );

  /**
   * The BIC for the account's IBAN, as Monerium lists it. Read once per IBAN
   * and kept on the row; the app asks when it shows the account details, not
   * on every poll. No IBAN, or Monerium lists no BIC for it: `bic` is null and
   * the app shows none. Nothing is guessed from the IBAN's country.
   */
  router.get(
    "/users/:id/bic",
    wrap(async (req, res) => {
      const user = await store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!(await requireUserSession(req, res, user.id))) return;
      if (!user.iban) return res.json({ bic: null });
      const current = normalizeIban(user.iban);
      if (user.ibanBic && normalizeIban(user.ibanBic.iban) === current) return res.json({ bic: user.ibanBic.bic });
      let bic: string | undefined;
      try {
        bic = await findIbanBic(user);
      } catch (err: any) {
        console.error(`bic lookup failed for ${user.id}: ${describeCause(err)}`);
        return res.status(502).json({ error: "Monerium did not answer. Try again in a moment." });
      }
      if (!bic) return res.json({ bic: null });
      await store.updateUser(user.id, { ibanBic: { iban: current, bic, checkedAt: new Date().toISOString() } });
      res.json({ bic });
    }),
  );

  router.get(
    "/users/:id/kyc",
    wrap(async (req, res) => {
      const user = await store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!(await requireUserSession(req, res, user.id))) return;
      res.json({
        userId: user.id,
        country: user.country,
        kycStatus: user.kycStatus,
        kyc: user.kyc,
        funding: user.funding,
      });
    }),
  );

  return router;
}

/**
 * Accounts: signup, the account read, the KYC state, and the privacy bundle.
 *
 * Signup resolves the country, citizenship and US answers to a segment, whose
 * capabilities every later route checks. A blocked applicant is told what Zold
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
import { KYC, PRIVACY_BUNDLE } from "../config.js";
import { accountBalances } from "../chain.js";
import { auditEntry, redact } from "../audit.js";
import { normaliseCountryCode } from "../country-policy.js";
import { resolveSegment, type Segment } from "../domain/segments.js";
import { store, type User } from "../store.js";
import { requireKycApproved } from "../http/guards.js";
import { publicUser, withSession } from "../users/public-user.js";
import { refreshPendingIban } from "../adapters/monerium-sandbox.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;


/** requireUserSession is injected — server.ts owns authentication. */
export interface UserDeps {
  requireUserSession: (req: express.Request, res: express.Response, userId: string) => unknown;
}


function publicPrivacyPlan(plan: (typeof PRIVACY_BUNDLE.plans)[number]) {
  const grossMarginBps = Math.round(((plan.priceEur - plan.estimatedCostEur) / plan.priceEur) * 10_000);
  return {
    ...plan,
    grossMarginBps,
    marginProtected: grossMarginBps >= PRIVACY_BUNDLE.minMarginBps,
  };
}

function nextMonthlyRenewal() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
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

export function createUserRouter(deps: UserDeps) {
  const { requireUserSession } = deps;
  const router = express.Router();

  router.post(
    "/users",
    wrap(async (req, res) => {
      const { name, country, email, citizenships, accountType, usAnswers, consents,
        companyIncorporationCountry, softSignals } = req.body ?? {};
      if (typeof name !== "string" || !name.trim() || typeof country !== "string" || !country) {
        return res.status(400).json({ error: "name, email and country required" });
      }
      if (name.trim().length > 120) return res.status(400).json({ error: "name is too long" });
      /**
       * Email is required as a channel, not an identity (identity is
       * Monerium's; the passkey is the login). It lets the account be found
       * and recovered from a device without the passkey (Candide's guardian
       * looks it up by email), and gives the OS passkey picker a label that
       * does not collide the way a full name does. It is verified only by
       * Candide's OTP at recovery enrolment. Nothing here sends mail.
       */
      const emailNorm = typeof email === "string" ? email.trim() : "";
      if (!emailNorm) return res.status(400).json({ error: "name, email and country required" });
      if (emailNorm.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) {
        return res.status(400).json({ error: "invalid email" });
      }
      // One claimable account per email. Recovery resolves an email to an
      // account, so two accounts with passkeys on one address would make the
      // lookup ambiguous. A row with no passkey is onboarding that stopped
      // before any credential existed (nothing can sign in to it), so the same
      // person may start again after a failed ceremony.
      if (store.usersByEmail(emailNorm).some((u) => !!u.passkey)) {
        return res.status(409).json({
          error: "an account already uses this email — sign in with your passkey, or recover the account if you lost the device",
          code: "EMAIL_IN_USE",
        });
      }

      /**
       * Segmentation. Don't call `countryBlock()` here first: it only answers
       * "will Monerium serve this residence", so on its own it would refuse,
       * say, Nigerians with a message about Monerium's country policy, naming a
       * partner the user was never going to use. resolveSegment consults it
       * internally, asks the three questions separately and returns which one
       * decided.
       *
       * Callers that send no segmentation fields are read as an individual with
       * a single citizenship equal to residence and all-no US answers.
       */
      const type: "individual" | "company" = accountType === "company" ? "company" : "individual";
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
      let decision;
      try {
        decision = resolveSegment({
          residence: String(country),
          citizenships: Array.isArray(citizenships) && citizenships.length
            ? citizenships.map(String)
            : [String(country)],
          accountType: type,
          usAnswers: answers,
          ...(companyIncorporationCountry ? { companyIncorporationCountry: String(companyIncorporationCountry) } : {}),
          ...(softSignals ? { softSignals } : {}),
        });
      } catch (err: any) {
        return res.status(400).json({ error: String(err?.message ?? err) });
      }

      // A blocked segment is recorded before it is refused: the decision has to
      // be auditable whether or not an account exists, and "we refused someone
      // and kept no record of why" is the failure this log exists to prevent.
      if (decision.segment.startsWith("BLOCKED_")) {
        store.audit(auditEntry("segment.decided", {
          residence: normaliseCountryCode(String(country)),
          citizenships: (Array.isArray(citizenships) ? citizenships : [country]).map((c: any) => normaliseCountryCode(String(c))),
          accountType: type,
          usAnswers: answers,
          segment: decision.segment,
          reasonCode: decision.reasonCode,
          email: redact(emailNorm),
          outcome: "refused_at_signup",
        }));
        // Says what Zold cannot offer, not which rule fired. reasonCode stays in
        // the log: publishing it tells someone which answer to change.
        return res.status(403).json({
          error: BLOCKED_COPY[decision.segment as keyof typeof BLOCKED_COPY],
          code: decision.segment,
        });
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
        name: name.trim(),
        email: emailNorm,
        country: normaliseCountryCode(String(country)),
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
      };
      store.addUser(user);
      store.setSegment(user.id, {
        value: decision.segment,
        reasonCode: decision.reasonCode,
        decidedAt: new Date().toISOString(),
        decidedBy: "system",
        ...(decision.gate ? { gate: decision.gate } : {}),
      });
      store.updateUser(user.id, {
        citizenships: (Array.isArray(citizenships) && citizenships.length
          ? citizenships.map(String) : [String(country)]).map(normaliseCountryCode),
        accountType: type,
        ...(companyIncorporationCountry
          ? { companyIncorporationCountry: normaliseCountryCode(String(companyIncorporationCountry)) }
          : {}),
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
      store.addUsAnswers(user.id, {
        ...answers,
        answeredAt: new Date().toISOString(),
        version: combined ? US_QUESTION_COMBINED_VERSION : US_QUESTIONS_VERSION,
      });
      for (const c of Array.isArray(consents) ? consents : []) {
        if (c?.kind !== "zold_terms" && c?.kind !== "partner_share") continue;
        store.addConsent(user.id, {
          kind: c.kind,
          ...(typeof c.partner === "string" && c.partner ? { partner: c.partner.slice(0, 80) } : {}),
          version: typeof c.version === "string" && c.version ? c.version.slice(0, 40) : CONSENT_VERSION,
          at: new Date().toISOString(),
          // No IP: the consent is tied to the account that gave it, and an
          // address stored here was echoed to the operator's user list.
        });
      }
      store.audit(auditEntry("segment.decided", {
        residence: user.country,
        accountType: type,
        usAnswers: answers,
        segment: decision.segment,
        reasonCode: decision.reasonCode,
        softUsSignals: decision.review?.softUsSignals ?? [],
        outcome: "account_created",
      }, user.id));
      res.status(201).json(withSession(user));
    }),
  );

  router.get(
    "/users/:id",
    wrap(async (req, res) => {
      let user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (user.funding?.status === "iban_pending") {
        user = await refreshPendingIban(user);
      }
      const balances = await accountBalances(user.address);
      res.json({ ...publicUser(user), ...balances });
    }),
  );

  router.get(
    "/users/:id/kyc",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      res.json({
        userId: user.id,
        country: user.country,
        kycStatus: user.kycStatus,
        kyc: user.kyc,
        funding: user.funding,
      });
    }),
  );



  router.get(
    "/privacy-bundles",
    wrap(async (_req, res) => {
      res.json({
        enabled: PRIVACY_BUNDLE.enabled,
        fulfillment: {
          kokio: PRIVACY_BUNDLE.kokioLive ? "live" : "pending_partner_credentials",
          mysterium: PRIVACY_BUNDLE.mysteriumLive ? "live" : "pending_partner_credentials",
        },
        guardrails: {
          minMarginBps: PRIVACY_BUNDLE.minMarginBps,
          noUnlimitedUsage: true,
          downgradeWhenMarginUnsafe: true,
        },
        plans: PRIVACY_BUNDLE.plans.map(publicPrivacyPlan),
      });
    }),
  );

  router.post(
    "/users/:id/privacy-bundle",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!requireKycApproved(user, res)) return;
      if (!PRIVACY_BUNDLE.enabled) return res.status(503).json({ error: "privacy bundle is not enabled" });

      const plan = PRIVACY_BUNDLE.plans.find((p) => p.id === req.body?.planId);
      if (!plan) return res.status(400).json({ error: "unknown privacy bundle plan" });
      const publicPlan = publicPrivacyPlan(plan);
      if (!publicPlan.marginProtected) {
        return res.status(409).json({
          error: "plan is below the configured margin floor",
          plan: publicPlan,
        });
      }

      const now = new Date().toISOString();
      const status =
        PRIVACY_BUNDLE.kokioLive && PRIVACY_BUNDLE.mysteriumLive ? "active" : "pending_fulfillment";
      const updated = store.updateUser(user.id, {
        privacyBundle: {
          planId: plan.id,
          status,
          startedAt: now,
          renewsAt: nextMonthlyRenewal(),
          esim: {
            provider: "kokio",
            status: PRIVACY_BUNDLE.kokioLive ? "active" : "pending",
            dataGb: plan.esimGb,
            region: plan.esimRegion,
          },
          vpn: {
            provider: "mysterium",
            status: PRIVACY_BUNDLE.mysteriumLive ? "active" : "pending",
            bandwidthGb: plan.vpnGb,
            devices: plan.vpnDevices,
          },
          usage: {
            esimGb: 0,
            vpnGb: 0,
            periodStartedAt: now,
          },
        },
      });
      res.status(201).json({ user: publicUser(updated), plan: publicPlan });
    }),
  );

  router.post(
    "/users/:id/privacy-bundle/cancel",
    wrap(async (req, res) => {
      const user = store.findUser(req.params.id);
      if (!user) return res.status(404).json({ error: "user not found" });
      if (!requireUserSession(req, res, user.id)) return;
      if (!user.privacyBundle || user.privacyBundle.status === "canceled") {
        return res.status(409).json({ error: "no active privacy bundle" });
      }
      const updated = store.updateUser(user.id, {
        privacyBundle: {
          ...user.privacyBundle,
          status: "canceled",
          canceledAt: new Date().toISOString(),
        },
      });
      res.json(publicUser(updated));
    }),
  );

  return router;
}

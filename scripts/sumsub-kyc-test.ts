import assert from "node:assert/strict";
import {
  decisionFromSumsubWebhook,
  senderProfileFromSumsubApplicant,
  sumsubExternalUserId,
  sumsubWebhookDigest,
  userIdFromSumsubExternalId,
  verifySumsubWebhookDigest,
} from "../services/api/src/adapters/sumsub.js";

const raw = Buffer.from(JSON.stringify({
  type: "applicantReviewed",
  applicantId: "sumsub-applicant-1",
  externalUserId: sumsubExternalUserId("user-1"),
  reviewStatus: "completed",
  reviewResult: { reviewAnswer: "GREEN" },
}));

const digest = sumsubWebhookDigest("webhook-secret", raw);
assert.equal(verifySumsubWebhookDigest("webhook-secret", raw, digest, "HMAC_SHA256_HEX"), true);
assert.equal(verifySumsubWebhookDigest("wrong-secret", raw, digest, "HMAC_SHA256_HEX"), false);
assert.equal(userIdFromSumsubExternalId("zold:user-1"), "user-1");

assert.equal(decisionFromSumsubWebhook(JSON.parse(raw.toString())), "approved");
assert.equal(decisionFromSumsubWebhook({ type: "applicantReviewed", reviewResult: { reviewAnswer: "RED" } }), "rejected");
assert.equal(decisionFromSumsubWebhook({ type: "applicantCreated" }), null);

const senderProfile = senderProfileFromSumsubApplicant({
  info: {
    firstName: "Miriam",
    lastName: "Zoldenburg",
    dob: "1992-03-04",
    phone: "+491234567",
    email: "miriam@example.com",
    addresses: [{ street: "Pennylane 12", town: "Berlin", postCode: "10115", country: "DEU" }],
    idDocs: [{ idDocType: "PASSPORT", number: "X1234567", country: "DEU", imageId: "must-not-be-stored" }],
  },
}, {
  id: "user-1",
  name: "Miriam Zoldenburg",
  email: "miriam@example.com",
  country: "DE",
  kycStatus: "pending",
  iban: "",
  address: "0x0000000000000000000000000000000000000000",
  createdAt: new Date().toISOString(),
});

assert.equal(senderProfile?.firstName, "Miriam");
assert.equal(senderProfile?.addressCountryCode, "DEU");
assert.equal(senderProfile?.idType, "passport");
assert.equal((senderProfile as any).imageId, undefined, "document images must stay in Sumsub, not our store");

console.log("SUMSUB KYC TEST PASSED");


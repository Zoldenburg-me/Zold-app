import { createHmac, timingSafeEqual } from "node:crypto";
import { SUMSUB } from "../config.js";
import { toAlpha3 } from "../stellar/sep9.js";
import type { User } from "../store.js";

export interface SumsubConfig {
  baseUrl: string;
  appToken: string;
  secretKey: string;
  webhookSecretKey: string;
  levelName: string;
  tokenTtlSecs: number;
  moneriumClientId: string;
}

export interface SumsubWebhook {
  applicantId?: string;
  externalUserId?: string;
  type?: string;
  reviewStatus?: string;
  reviewResult?: {
    reviewAnswer?: string;
    moderationComment?: string;
    clientComment?: string;
  };
  [key: string]: any;
}

export type SumsubDecision = "approved" | "rejected" | "manual_review";

type SenderProfilePatch = NonNullable<User["senderProfile"]>;

function signedHeaders(cfg: Pick<SumsubConfig, "appToken" | "secretKey">, method: string, path: string, body = "") {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", cfg.secretKey)
    .update(`${ts}${method.toUpperCase()}${path}${body}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-app-token": cfg.appToken,
    "x-app-access-ts": ts,
    "x-app-access-sig": sig,
  };
}

async function sumsubRequest<T>(
  cfg: Pick<SumsubConfig, "baseUrl" | "appToken" | "secretKey">,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: signedHeaders(cfg, method, path, raw),
    body: raw || undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sumsub ${method} ${path} failed (${res.status}): ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export function sumsubExternalUserId(userId: string): string {
  return `zold:${userId}`;
}

export function userIdFromSumsubExternalId(externalUserId?: string): string | undefined {
  return externalUserId?.startsWith("zold:") ? externalUserId.slice("zold:".length) : undefined;
}

export function sumsubWebhookDigest(secretKey: string, rawBody: Buffer, alg = "HMAC_SHA256_HEX"): string {
  const nodeAlg = {
    HMAC_SHA1_HEX: "sha1",
    HMAC_SHA256_HEX: "sha256",
    HMAC_SHA512_HEX: "sha512",
  }[alg];
  if (!nodeAlg) throw new Error(`unsupported Sumsub webhook digest algorithm: ${alg}`);
  return createHmac(nodeAlg, secretKey).update(rawBody).digest("hex");
}

export function verifySumsubWebhookDigest(
  secretKey: string,
  rawBody: Buffer,
  digest?: string,
  alg?: string,
): boolean {
  if (!secretKey || !digest) return false;
  const expected = Buffer.from(sumsubWebhookDigest(secretKey, rawBody, alg), "hex");
  const actual = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createSumsubWebSdkLink(
  cfg: SumsubConfig = SUMSUB,
  params: { user: User; successUrl?: string; rejectUrl?: string },
): Promise<{ url: string }> {
  const path = "/resources/sdkIntegrations/levels/-/websdkLink";
  return sumsubRequest(cfg, "POST", path, {
    userId: sumsubExternalUserId(params.user.id),
    levelName: cfg.levelName,
    ttlInSecs: cfg.tokenTtlSecs,
    applicantIdentifiers: {
      ...(params.user.email ? { email: params.user.email } : {}),
    },
    ...(params.successUrl || params.rejectUrl
      ? { redirect: { successUrl: params.successUrl, rejectUrl: params.rejectUrl } }
      : {}),
  });
}

export async function createSumsubShareToken(
  cfg: SumsubConfig = SUMSUB,
  applicantId: string,
  forClientId = cfg.moneriumClientId,
): Promise<{ token: string; forClientId?: string }> {
  return sumsubRequest(cfg, "POST", "/resources/accessTokens/shareToken", {
    applicantId,
    forClientId,
    ttlInSecs: 600,
  });
}

export async function getSumsubApplicant(cfg: SumsubConfig = SUMSUB, applicantId: string): Promise<any> {
  return sumsubRequest(cfg, "GET", `/resources/applicants/${encodeURIComponent(applicantId)}/one`);
}

export function decisionFromSumsubWebhook(payload: SumsubWebhook): SumsubDecision | null {
  if (payload.type !== "applicantReviewed") return null;
  const answer = payload.reviewResult?.reviewAnswer;
  if (answer === "GREEN") return "approved";
  if (answer === "RED") return "rejected";
  return "manual_review";
}

const docTypeMap: Record<string, SenderProfilePatch["idType"]> = {
  PASSPORT: "passport",
  ID_CARD: "id_card",
  DRIVERS: "drivers_license",
  DRIVERS_LICENSE: "drivers_license",
};

const first = (...values: any[]) =>
  values.find((v) => typeof v === "string" && v.trim() !== "")?.trim();

export function senderProfileFromSumsubApplicant(applicant: any, user: User): SenderProfilePatch | null {
  const info = applicant?.info ?? {};
  const fixed = applicant?.fixedInfo ?? {};
  const address = info.addresses?.[0] ?? fixed.addresses?.[0] ?? {};
  const doc = info.idDocs?.[0] ?? fixed.idDocs?.[0] ?? {};
  const firstName = first(info.firstName, fixed.firstName);
  const lastName = first(info.lastName, fixed.lastName);
  if (!firstName || !lastName) return null;
  const idDocType = first(doc.idDocType, doc.type);
  return {
    firstName,
    lastName,
    birthDate: first(info.dob, fixed.dob),
    address: first(address.street, address.formattedAddress, fixed.address, info.address),
    city: first(address.town, address.city, fixed.city, info.city),
    postalCode: first(address.postCode, address.postalCode, fixed.postalCode, info.postalCode),
    stateOrProvince: first(address.state, address.subdivision),
    addressCountryCode: toAlpha3(first(address.country, fixed.country, info.country) ?? user.country),
    idType: idDocType ? docTypeMap[idDocType] : undefined,
    idNumber: first(doc.number),
    idCountryCode: toAlpha3(first(doc.country)),
    mobileNumber: first(info.phone, fixed.phone),
    emailAddress: first(info.email, fixed.email, user.email),
    occupation: first(info.occupation, fixed.occupation),
    updatedAt: new Date().toISOString(),
  };
}

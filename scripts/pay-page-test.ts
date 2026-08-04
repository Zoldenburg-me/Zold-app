/**
 * Payment pages — handles, the public projection, and the QR encoder.
 *
 * Pure functions plus one matrix round-trip; no chain and no API. The point of
 * the projection tests is that the public endpoint is unauthenticated, so a
 * field leaking into it leaks to anyone with a link.
 *
 * Run: npm run pay:test
 */
import assert from "node:assert/strict";
import * as jsqrModule from "jsqr";

/** jsqr ships CommonJS, so the callable is the default under Node ESM. */
const jsQR = ((jsqrModule as any).default ?? jsqrModule) as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;
import {
  HandleError,
  normaliseDisplayName,
  normaliseHandle,
  paymentUri,
  publicPayee,
} from "../services/api/src/pay.js";
import { dataModuleOrder, qrMatrix, qrSvg } from "../services/api/src/qr.js";

let n = 0;
const check = (label: string, fn: () => void) => {
  fn();
  console.log(`  ${++n}. ${label}`);
};
const throws = (fn: () => unknown, re: RegExp) =>
  assert.throws(fn, (e: any) => e instanceof HandleError && re.test(e.message));

const CHAIN = {
  chainId: 31337,
  token: { symbol: "USDC", address: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" as const, decimals: 6 },
};

/** An account with every sensitive field populated, so the projection test is
 *  meaningful rather than vacuous. */
const user: any = {
  id: "u1",
  name: "Miriam Zoldenburg",
  email: "miriam@example.com",
  country: "DE",
  kycStatus: "approved",
  kyc: { provider: "mock", applicantId: "app_123" },
  senderProfile: { firstName: "Miriam", lastName: "Zoldenburg", idNumber: "X1234567" },
  iban: "DE89370400440532013000",
  address: "0xa8af216C328AAa6a384DD422c4eA005cEd7F73f1",
  ownerAddress: "0xbbbb216C328AAa6a384DD422c4eA005cEd7F73f1",
  privateKey: "0xdeadbeef",
  authorizerAddress: "0xcccc216C328AAa6a384DD422c4eA005cEd7F73f1",
  paymentPage: {
    handle: "miriam",
    displayName: "Miriam Z",
    depositAddress: "0xd8af216C328AAa6a384DD422c4eA005cEd7F73f1",
    recipientAddress: "0xa8af216C328AAa6a384DD422c4eA005cEd7F73f1",
    forwarder: {
      provider: "candide",
      recipient: "0xa8af216C328AAa6a384DD422c4eA005cEd7F73f1",
      destinationChainId: 31337,
      sourceChainIds: [31337],
      custodialWithdrawer: "0xdddd216C328AAa6a384DD422c4eA005cEd7F73f1",
      salt: `0x${"12".repeat(32)}`,
      active: true,
      activatedAt: new Date().toISOString(),
    },
    supportedTokens: [
      { chainId: 31337, symbol: "USDC", address: CHAIN.token.address, decimals: 6 },
    ],
    settlementAsset: "EURE",
    autoConvert: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  monerium: { accessTokenEnc: "secret" },
  createdAt: new Date().toISOString(),
};

console.log("Payment pages");

check("a plain handle is accepted and lowercased", () => {
  assert.equal(normaliseHandle("Miriam"), "miriam");
  assert.equal(normaliseHandle("  bo-b99 "), "bo-b99");
});

check("too short, too long, and bad characters are refused", () => {
  throws(() => normaliseHandle("ab"), /3 and 30/);
  throws(() => normaliseHandle("a".repeat(31)), /3 and 30/);
  throws(() => normaliseHandle("has space"), /lowercase letters/);
  throws(() => normaliseHandle("emoji🙂"), /lowercase letters/);
  throws(() => normaliseHandle("under_score"), /lowercase letters/);
});

check("a handle cannot lead or trail with a hyphen", () => {
  throws(() => normaliseHandle("-alice"), /lowercase letters/);
  throws(() => normaliseHandle("alice-"), /lowercase letters/);
});

check("a handle cannot look like an address", () => {
  throws(() => normaliseHandle("0xabc"), /0x/);
});

check("route names are reserved, so a handle cannot phish one", () => {
  for (const h of ["api", "pay", "settings", "login", "admin", "zold"]) {
    throws(() => normaliseHandle(h), /reserved/);
  }
});

check("a non-string handle is refused rather than coerced", () => {
  throws(() => normaliseHandle(undefined), /must be a string/);
  throws(() => normaliseHandle(12345), /must be a string/);
});

check("display name is optional, trimmed, and length-capped", () => {
  assert.equal(normaliseDisplayName(undefined), undefined);
  assert.equal(normaliseDisplayName(""), undefined);
  assert.equal(normaliseDisplayName("  Miriam   Z  "), "Miriam Z");
  throws(() => normaliseDisplayName("x".repeat(41)), /40 characters/);
});

check("the public projection returns exactly the expected payment-page keys", () => {
  const p = publicPayee(user, CHAIN);
  assert.deepEqual(Object.keys(p).sort(), [
    "address",
    "autoConvert",
    "chainId",
    "displayName",
    "handle",
    "settlementAsset",
    "supportedTokens",
    "token",
  ]);
});

check("and leaks no account data — this is the security-relevant one", () => {
  const serialised = JSON.stringify(publicPayee(user, CHAIN));
  for (const secret of [
    "miriam@example.com",
    "DE89370400440532013000",
    "0xdeadbeef",
    "app_123",
    "X1234567",
    "secret",
    "Miriam Zoldenburg", // the legal name, as distinct from the chosen display name
    "approved",
    user.ownerAddress,
    user.authorizerAddress,
    user.paymentPage.forwarder.custodialWithdrawer,
    user.paymentPage.recipientAddress,
  ]) {
    assert.ok(!serialised.includes(secret), `leaked ${secret} in ${serialised}`);
  }
});

check("display name is omitted entirely when unset, never defaulted to the legal name", () => {
  const p = publicPayee({ ...user, paymentPage: { ...user.paymentPage, displayName: undefined } }, CHAIN);
  assert.ok(!("displayName" in p));
  assert.ok(!JSON.stringify(p).includes("Miriam"));
});

check("an account with no handle cannot be projected at all", () => {
  throws(() => publicPayee({ ...user, paymentPage: undefined, handle: undefined }, CHAIN), /no payment handle/);
});

check("the payment URI is EIP-681 with the token contract and chain", () => {
  const p = publicPayee(user, CHAIN);
  assert.equal(
    paymentUri(p),
    `ethereum:${CHAIN.token.address}@31337/transfer?address=${user.paymentPage.depositAddress}`,
  );
});

check("an amount is converted to token base units", () => {
  const p = publicPayee(user, CHAIN);
  assert.match(paymentUri(p, 12.5), /&uint256=12500000$/); // 6dp USDC
  assert.ok(!paymentUri(p, 0).includes("uint256"));
  assert.ok(!paymentUri(p, -5).includes("uint256"));
});

/* ---------- QR ----------
   Reads the finished matrix back through the same module ordering and rebuilds
   the payload. This proves the bitstream, padding, mask application and module
   placement agree with each other. It cannot prove the ordering matches the
   spec — only an independent decoder or a phone can. */
const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Recover the mask from the format area, undo it, and parse the payload. */
function readBack(matrix: boolean[][]): string {
  const size = matrix.length;
  const version = (size - 17) / 4;
  // The vertical strip in column 8 holds one copy of the 15 format bits:
  // rows 0-5, then 7-8, then the bottom seven.
  const formatXor = 0b101010000010010;
  let raw = 0;
  for (let i = 0; i < 15; i++) {
    const row = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    raw |= (matrix[row][8] ? 1 : 0) << i;
  }
  const unmasked = raw ^ formatXor;
  const mask = (unmasked >> 10) & 0b111;

  const order = dataModuleOrder(version);
  const bits: number[] = [];
  for (const [r, c] of order) {
    let v = matrix[r][c] ? 1 : 0;
    if (MASKS[mask](r, c)) v ^= 1;
    bits.push(v);
  }
  const take = (at: number, width: number) =>
    bits.slice(at, at + width).reduce((acc, b) => (acc << 1) | b, 0);
  assert.equal(take(0, 4), 0b0100, "byte mode");
  const len = take(4, 8);
  const bytes: number[] = [];
  for (let i = 0; i < len; i++) bytes.push(take(12 + i * 8, 8));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** Rasterise the matrix the way the SVG renders it, so an off-the-shelf
 *  decoder sees what a camera would. */
function rasterise(matrix: boolean[][], scale = 8, quiet = 4) {
  const span = (matrix.length + quiet * 2) * scale;
  const px = new Uint8ClampedArray(span * span * 4).fill(255);
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (!matrix[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const y = (r + quiet) * scale + dy;
          const x = (c + quiet) * scale + dx;
          const i = (y * span + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  return { px, span };
}

/**
 * THE test for this encoder — an independent decoder, not our own reader.
 *
 * The first version of placeFormat transposed the two format strips and
 * reversed the bit order along row 8. Every check we had still passed, because
 * they all read the matrix back through our own conventions; a real scanner
 * could not tell which mask had been applied and refused the code outright.
 * Reading it back with jsqr is the only check that would have caught it, so it
 * runs on the payloads the product actually emits.
 */
check("an independent decoder reads the code — jsqr, not our own reader", () => {
  for (const payload of [
    "0xa8af216C328AAa6a384DD422c4eA005cEd7F73f1", // an address, what the page emits
    "0x1806ECe0a808ACba40E4068d87a0010228A66722",
    "z".repeat(100), // a longer payload, into a higher version
  ]) {
    const { px, span } = rasterise(qrMatrix(payload));
    const decoded = jsQR(px, span, span);
    assert.ok(decoded, `jsqr could not decode ${payload.slice(0, 20)}…`);
    assert.equal(decoded.data, payload);
  }
});

check("the QR served by the payment page decodes, at its rendered size", () => {
  // qrSvg is what /api/pay/:handle/qr.svg returns; check the same matrix.
  const addr = "0xa8af216C328AAa6a384DD422c4eA005cEd7F73f1";
  assert.ok(qrSvg(addr).includes("<path"), "svg has a path");
  const { px, span } = rasterise(qrMatrix(addr), 4);
  assert.equal(jsQR(px, span, span)?.data, addr, "decodes at 4px per module");
});

check("a QR of an address round-trips back to the same string", () => {
  const addr = "0xa8af216C328AAa6a384DD422c4eA005cEd7F73f1";
  assert.equal(readBack(qrMatrix(addr)), addr);
});

check("a longer payload round-trips too, across a version boundary", () => {
  // 100 bytes lands in version 5, past v1-v4 and their smaller block layout.
  const payload = "z".repeat(100);
  assert.equal(readBack(qrMatrix(payload)), payload);
});

check("a full EIP-681 URI does NOT fit, and says so instead of half-encoding", () => {
  const uri = paymentUri(publicPayee(user, CHAIN), 250);
  assert.ok(uri.length > 134, `expected a URI over the cap, got ${uri.length}`);
  assert.throws(() => qrMatrix(uri), /too long .*belongs in a link/s);
});

check("versions grow with the payload", () => {
  assert.equal(qrMatrix("short").length, 21); // v1
  assert.ok(qrMatrix("x".repeat(120)).length > 21);
});

check("the finder patterns are where a scanner looks for them", () => {
  const m = qrMatrix("0xa8af216C328AAa6a384DD422c4eA005cEd7F73f1");
  const size = m.length;
  for (const [r0, c0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    assert.ok(m[r0][c0] && m[r0 + 6][c0] && m[r0][c0 + 6], "finder corners dark");
    assert.ok(!m[r0 + 1][c0 + 1], "finder ring light");
    assert.ok(m[r0 + 3][c0 + 3], "finder centre dark");
  }
  assert.ok(m[size - 8][8], "dark module");
});

check("a payload too long to encode throws instead of returning junk", () => {
  assert.throws(() => qrMatrix("x".repeat(200)), /too long/);
});

check("the SVG is self-contained and includes a quiet zone", () => {
  const svg = qrSvg("0xa8af216C328AAa6a384DD422c4eA005cEd7F73f1");
  const modules = qrMatrix("0xa8af216C328AAa6a384DD422c4eA005cEd7F73f1").length;
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, new RegExp(`viewBox="0 0 ${modules + 8} ${modules + 8}"`));
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg), "no external references");
});

console.log(`\nPAY PAGE TEST PASSED — ${n} checks`);

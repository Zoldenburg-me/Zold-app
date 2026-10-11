/**
 * One Turnkey request from the browser: sign a 32-byte digest with the
 * guardian's wallet, stamped by the session key in IndexedDB (the vendored
 * stamper). This replaces @turnkey/http, which is 636 KB for this one call.
 *
 * As Turnkey's own viem adapter does: the digest goes as hex with its 0x,
 * PAYLOAD_ENCODING_HEXADECIMAL, HASH_FUNCTION_NO_OP (signed as given, no
 * extra hash). An activity that is not complete at once is polled through
 * get_activity. Turnkey answers r, s, v; the API turns them into the
 * module's signature and checks the signer.
 *
 * Pure apart from the `fetchImpl` and `stamper` it is handed;
 * scripts/turnkey-guardian-page-test.ts imports it.
 */
export const TURNKEY_POLL = { tries: 10, delayMs: 1000 };
const FAILED = ["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED", "ACTIVITY_STATUS_CONSENSUS_NEEDED"];

export async function signRawPayload({
  stamper, baseUrl, organizationId, signWith, payload,
  fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), poll = TURNKEY_POLL,
}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(payload)) throw new Error("the digest to sign must be 32 bytes of hex");
  const post = async (path, body) => {
    const json = JSON.stringify(body);
    const { stampHeaderName, stampHeaderValue } = await stamper.stamp(json);
    const r = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", [stampHeaderName]: stampHeaderValue },
      body: json,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Turnkey refused the request (${r.status}${data.message ? `: ${data.message}` : ""})`);
    return data;
  };
  let { activity } = await post("/public/v1/submit/sign_raw_payload", {
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    timestampMs: String(now()),
    organizationId,
    parameters: { signWith, payload, encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" },
  });
  for (let i = 0; activity?.status !== "ACTIVITY_STATUS_COMPLETED"; i++) {
    if (!activity || FAILED.includes(activity.status)) throw new Error(`Turnkey did not sign (${activity?.status ?? "no activity"})`);
    if (i >= poll.tries) throw new Error("Turnkey is taking too long to sign; try again");
    await sleep(poll.delayMs);
    ({ activity } = await post("/public/v1/query/get_activity", { organizationId, activityId: activity.id }));
  }
  const out = activity.result?.signRawPayloadResult;
  if (!out?.r || !out?.s || out.v == null) throw new Error("Turnkey answered without a signature");
  return { r: out.r, s: out.s, v: out.v };
}

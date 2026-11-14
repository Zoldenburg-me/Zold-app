import { errorText } from "./http/log-cause.js";

/**
 * RPCs cap eth_getLogs, each in its own words: by block span (sepolia.base.org
 * answers "eth_getLogs is limited to a 1,000 range") or by result count. A
 * scanner that asks for more than its RPC answers fails every tick and its
 * cursor never moves, so every log scan halves its window on these refusals.
 */
const LIMIT_RE = /more than \d+ results|query returned more|limit exceeded|limited to (a )?[\d,]+ (block )?range|block range|range (is )?too (large|wide)|too many (results|logs)|exceed/i;

/** A rate limit or quota, in the words viem and the RPCs use. Alchemy's
 *  ("exceeded its compute units per second capacity", "Monthly capacity limit
 *  exceeded") also match LIMIT_RE; halving on one made every window one block
 *  wide, which multiplied the calls that hit the limit. It is only a reason to
 *  wait for the next tick. */
const RATE_LIMIT_RE = /rate limit|request count|compute units|capacity|too many requests|status: 429/i;

export function isLogRangeRefusal(e: unknown): boolean {
  const text = errorText(e);
  return LIMIT_RE.test(text) && !RATE_LIMIT_RE.test(text);
}

/** A refusal that names a result COUNT, as opposed to a range, or a rate
 *  limit or quota ("rate limit exceeded", "request count exceeded"), which
 *  LIMIT_RE also matches and which is only a reason to wait. */
const RESULT_CAP_RE = /more than \d+ results|query returned more|too many (results|logs)/i;

export function isLogResultCapRefusal(e: unknown): boolean {
  return RESULT_CAP_RE.test(errorText(e));
}

/** Read the largest window from `fromBlock` (up to `maxSpan` blocks, never
 *  past `head`) the RPC will answer, halving on a range refusal. Any other
 *  error goes up. `span` is the width that answered: pass it back as the next
 *  `maxSpan` so the next window does not pay for the same refusals again. */
export async function readLogWindow<T>(
  fromBlock: bigint,
  head: bigint,
  maxSpan: bigint,
  read: (fromBlock: bigint, toBlock: bigint) => Promise<T>,
): Promise<{ toBlock: bigint; span: bigint; result: T }> {
  let span = maxSpan;
  for (;;) {
    const toBlock = head - fromBlock + 1n > span ? fromBlock + span - 1n : head;
    try {
      return { toBlock, span, result: await read(fromBlock, toBlock) };
    } catch (e) {
      if (span > 1n && isLogRangeRefusal(e)) {
        span = span / 2n;
        continue;
      }
      throw e;
    }
  }
}

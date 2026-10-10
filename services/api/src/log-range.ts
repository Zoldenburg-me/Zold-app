/**
 * RPCs cap eth_getLogs, each in its own words: by block span (sepolia.base.org
 * answers "eth_getLogs is limited to a 1,000 range") or by result count. A
 * scanner that asks for more than its RPC answers fails every tick and its
 * cursor never moves, so every log scan halves its window on these refusals.
 */
const LIMIT_RE = /more than \d+ results|query returned more|limit exceeded|limited to (a )?[\d,]+ (block )?range|block range|range (is )?too (large|wide)|too many (results|logs)|exceed/i;

export function isLogRangeRefusal(e: unknown): boolean {
  return LIMIT_RE.test(String((e as any)?.details ?? (e as any)?.message ?? e));
}

/** A refusal that names a result COUNT, as opposed to a range, or a rate
 *  limit or quota ("rate limit exceeded", "request count exceeded"), which
 *  LIMIT_RE also matches and which is only a reason to wait. */
const RESULT_CAP_RE = /more than \d+ results|query returned more|too many (results|logs)/i;

export function isLogResultCapRefusal(e: unknown): boolean {
  return RESULT_CAP_RE.test(String((e as any)?.details ?? (e as any)?.message ?? e));
}

/** Read the largest window from `fromBlock` (up to `maxSpan` blocks, never
 *  past `head`) the RPC will answer, halving on a range refusal. Any other
 *  error goes up. */
export async function readLogWindow<T>(
  fromBlock: bigint,
  head: bigint,
  maxSpan: bigint,
  read: (fromBlock: bigint, toBlock: bigint) => Promise<T>,
): Promise<{ toBlock: bigint; result: T }> {
  let span = maxSpan;
  for (;;) {
    const toBlock = head - fromBlock + 1n > span ? fromBlock + span - 1n : head;
    try {
      return { toBlock, result: await read(fromBlock, toBlock) };
    } catch (e) {
      if (span > 1n && isLogRangeRefusal(e)) {
        span = span / 2n;
        continue;
      }
      throw e;
    }
  }
}

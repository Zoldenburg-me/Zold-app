/**
 * Interleave parallel callers at one await: the first calls of `obj[method]`
 * wait until `n` of them are waiting, or `ms` passed, then all go on, and
 * later calls pass straight through. Before a fix every racer passes its
 * check before any of them writes; after it, a racer holding the store (a
 * `store.tx`) is the only one to arrive, and the timeout lets it go.
 * Returns the restore function.
 */
export function holdUntil<T extends object>(obj: T, method: keyof T, n: number, ms = 300): () => void {
  const original = obj[method] as unknown as (...a: unknown[]) => unknown;
  let waiting: (() => void)[] | undefined = [];
  let timer: NodeJS.Timeout | undefined;
  const releaseAll = () => {
    clearTimeout(timer);
    const go = waiting ?? [];
    waiting = undefined;
    for (const r of go) r();
  };
  (obj as Record<keyof T, unknown>)[method] = async (...args: unknown[]) => {
    if (waiting) {
      await new Promise<void>((r) => {
        waiting!.push(r);
        if (waiting!.length >= n) releaseAll();
        else timer ??= setTimeout(releaseAll, ms);
      });
    }
    return original.apply(obj, args);
  };
  return () => {
    releaseAll();
    (obj as Record<keyof T, unknown>)[method] = original as unknown;
  };
}

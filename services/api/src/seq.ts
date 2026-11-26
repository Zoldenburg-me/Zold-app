/**
 * Array methods for an async callback, one element at a time and in order,
 * so side effects happen in the order `Array.prototype` would run them and a
 * store read in the callback sees the writes of the elements before it.
 */
export async function mapSeq<T, R>(xs: readonly T[], fn: (x: T, i: number) => Promise<R> | R): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i++) out.push(await fn(xs[i], i));
  return out;
}

export async function flatMapSeq<T, R>(xs: readonly T[], fn: (x: T, i: number) => Promise<R | readonly R[]> | R | readonly R[]): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i++) {
    const r = await fn(xs[i], i);
    if (Array.isArray(r)) out.push(...r);
    else out.push(r as R);
  }
  return out;
}

export async function forEachSeq<T>(xs: readonly T[], fn: (x: T, i: number) => Promise<unknown> | unknown): Promise<void> {
  for (let i = 0; i < xs.length; i++) await fn(xs[i], i);
}

export async function filterSeq<T, S extends T = T>(xs: readonly T[], fn: (x: T, i: number) => Promise<unknown> | unknown): Promise<S[]> {
  const out: S[] = [];
  for (let i = 0; i < xs.length; i++) if (await fn(xs[i], i)) out.push(xs[i] as S);
  return out;
}

export async function findSeq<T, S extends T = T>(xs: readonly T[], fn: (x: T, i: number) => Promise<unknown> | unknown): Promise<S | undefined> {
  for (let i = 0; i < xs.length; i++) if (await fn(xs[i], i)) return xs[i] as S;
  return undefined;
}

export async function findIndexSeq<T>(xs: readonly T[], fn: (x: T, i: number) => Promise<unknown> | unknown): Promise<number> {
  for (let i = 0; i < xs.length; i++) if (await fn(xs[i], i)) return i;
  return -1;
}

export async function someSeq<T>(xs: readonly T[], fn: (x: T, i: number) => Promise<unknown> | unknown): Promise<boolean> {
  for (let i = 0; i < xs.length; i++) if (await fn(xs[i], i)) return true;
  return false;
}

export async function everySeq<T>(xs: readonly T[], fn: (x: T, i: number) => Promise<unknown> | unknown): Promise<boolean> {
  for (let i = 0; i < xs.length; i++) if (!(await fn(xs[i], i))) return false;
  return true;
}

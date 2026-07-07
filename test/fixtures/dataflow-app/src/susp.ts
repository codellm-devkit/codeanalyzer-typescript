/** Suspension points (await/yield) and intra-statement expression control flow. */

export async function compute(x: number): Promise<number> {
  return x * 2;
}

export async function fetchTotal(x: number): Promise<number> {
  const a = await compute(x); // await_resume edge out of this statement
  return a + 1;
}

export function* numbers(n: number): Generator<number, number, unknown> {
  let i = 0;
  while (i < n) {
    yield i; // yield (suspend/resume) edge
    i = i + 1;
  }
  return n;
}

export function shortCircuit(a: { f?: number } | null, b: number): number {
  const v = (a && a.f) || b; // short-circuit stays intra-statement (documented rule)
  const w = a?.f ?? b; // optional chaining likewise
  return v + w;
}

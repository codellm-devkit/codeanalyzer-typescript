/** Closure capture and copy aliasing. */

export function makeCounter(start: number): () => number {
  let count = start;
  const inc = (): number => {
    count = count + 1; // writes the captured local
    return count;
  };
  return inc;
}

export function useAlias(): number {
  const p = { f: 1 };
  const q = p; // q and p alias the same object
  q.f = 42; // write through q ...
  return p.f; // ... must reach this read through p
}

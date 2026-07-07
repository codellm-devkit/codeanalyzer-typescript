/** Intraprocedural constructs: branches, loops, early return, exceptions, switch, shadowing. */

export function classify(n: number): string {
  let label = "none";
  if (n > 0) {
    label = "pos";
  } else {
    label = "neg";
  }
  return label;
}

export function sumTo(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc = acc + i; // loop-carried dependency: acc feeds itself around the back edge
  }
  return acc;
}

export function early(n: number): number {
  if (n < 0) {
    return -1; // early return (multi-exit normalization)
  }
  const r = n * 2;
  return r;
}

export function parse(s: string): number {
  const v = Number(s);
  if (Number.isNaN(v)) {
    throw new Error(`bad input: ${s}`);
  }
  return v;
}

export function guarded(s: string): number {
  let out = 0;
  try {
    out = parse(s); // may throw → exception edge into the catch node
  } catch (e) {
    out = -1;
  } finally {
    touch(out);
  }
  return out;
}

export function touch(x: number): void {
  void x;
}

export function pickDay(d: number): string {
  let name = "";
  switch (d) {
    case 0:
      name = "sun";
      break;
    case 6:
      name = "sat";
      break;
    default:
      name = "weekday";
  }
  return name;
}

export function spin(): number {
  let ticks = 0;
  while (true) {
    ticks = ticks + 1; // infinite loop: the dead loop-exit edge keeps EXIT reachable
    if (ticks > 3) {
      break;
    }
  }
  return ticks;
}

export function shadow(): number {
  const x = 1;
  {
    const x = 2; // shadows the outer x — must NOT leak DDG edges across scopes
    touch(x);
  }
  return x;
}

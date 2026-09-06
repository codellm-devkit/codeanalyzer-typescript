/**
 * Rule matching (#72; python `matching.py` parity).
 *
 * Patterns are dotted names: `{a,b}` alternates (a `*` inside an alternative keeps its meaning),
 * `*` matches ONE dotless segment, everything else is literal, and the match is anchored.
 */
export class PatternError extends Error {}

const cache = new Map<string, RegExp>();

export function compilePattern(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const re = new RegExp(`^${compile(pattern)}$`);
  cache.set(pattern, re);
  return re;
}

function compile(pattern: string): string {
  if (!pattern) throw new PatternError("empty pattern");
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "{") {
      const j = pattern.indexOf("}", i);
      if (j < 0) throw new PatternError(`unclosed '{' in ${JSON.stringify(pattern)}`);
      const alts = pattern.slice(i + 1, j).split(",").map((a) => a.trim());
      out += `(?:${alts.map(compile).join("|")})`;
      i = j + 1;
    } else if (ch === "*") {
      out += "[^.\\s]*";
      i++;
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
      i++;
    }
  }
  return out;
}

export function validatePattern(pattern: string): void {
  compilePattern(pattern); // throws PatternError
}

export function matchPattern(pattern: string, value: string | undefined): boolean {
  return value !== undefined && compilePattern(pattern).test(value);
}

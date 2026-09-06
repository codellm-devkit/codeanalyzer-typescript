/**
 * Rule matching (#72; python `matching.py` parity).
 *
 * Patterns are dotted names: `{a,b}` alternates (a `*` inside an alternative keeps its meaning),
 * `*` matches ONE dotless segment, everything else is literal, and the match is anchored.
 */
import type { TSDecorator, TSEntrypoint } from "../schema";
import type { ArgSpec, DecoratorRule } from "./rules";

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

const HTTP_VERBS: ReadonlySet<string> = new Set(["get", "post", "put", "patch", "delete", "head", "options", "websocket", "all", "use"]);

/**
 * Decode a RAW source fragment (decorator/call arguments are stored as written): one layer of
 * matching quotes/backticks → the string; `[…]` of string literals → the list; anything else
 * (an identifier, a template with `${`, an object) → undefined. Python's `_literal` reads the AST;
 * TypeScript has only the text, so this is deliberately narrow.
 */
export function literalOf(raw: string): string | string[] | undefined {
  const s = raw.trim();
  const q = s[0];
  if ((q === "'" || q === '"' || q === "`") && s.endsWith(q) && s.length >= 2) {
    const inner = s.slice(1, -1);
    return q === "`" && inner.includes("${") ? undefined : inner;
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const items = s.slice(1, -1).split(",").map((x) => literalOf(x)).filter((x): x is string => typeof x === "string");
    return items;
  }
  return undefined;
}

const firstString = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v.find((x) => typeof x === "string") : v);

export function routeOf(args: string[], spec: ArgSpec | undefined): string | undefined {
  if (!spec || spec.from !== "positional") return undefined;
  const idx = spec.index ?? 0;
  const raw = args[idx < 0 ? args.length + idx : idx];
  return raw === undefined ? undefined : firstString(literalOf(raw));
}

export function methodsOf(args: string[], kwargs: Record<string, string>, spec: ArgSpec | undefined, matched: string): string[] {
  if (!spec) return [];
  if (spec.from === "match_suffix") {
    const verb = matched.split(".").pop() ?? "";
    return HTTP_VERBS.has(verb.toLowerCase()) ? [verb.toUpperCase()] : [];
  }
  if (spec.from === "keyword") {
    const raw = kwargs[spec.name ?? ""];
    const v = raw === undefined ? undefined : literalOf(raw);
    if (Array.isArray(v)) return v.map((x) => x.toUpperCase());
    if (typeof v === "string") return [v.toUpperCase()];
    return [...(spec.default ?? [])];
  }
  if (spec.from === "export_name") return [matched.toUpperCase()];
  return [];
}

/**
 * Framework tier: `match:` against `qualified_name` (import-table resolution). Heuristic tier
 * (`onWritten`): `match:` against `name` as written, no resolution at all.
 */
export function entrypointsFromDecorators(
  node: { decorators?: TSDecorator[] },
  framework: string,
  rules: readonly DecoratorRule[],
  onWritten: boolean,
): TSEntrypoint[] {
  const out: TSEntrypoint[] = [];
  for (const dec of node.decorators ?? []) {
    const candidate = onWritten ? dec.name : dec.qualified_name;
    for (const rule of rules) {
      if (!matchPattern(rule.match, candidate)) continue;
      const ep: TSEntrypoint = {
        framework, confidence: rule.confidence, rule: rule.id, ruleset: rule.origin,
        evidence: candidate as string, http_methods: methodsOf(dec.positional_arguments, dec.keyword_arguments, rule.methods, candidate as string),
      };
      const route = routeOf(dec.positional_arguments, rule.route);
      if (route !== undefined) ep.route = route;
      out.push(ep);
    }
  }
  return out;
}

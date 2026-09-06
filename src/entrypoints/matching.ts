/**
 * Rule matching (#72; python `matching.py` parity).
 *
 * Patterns are dotted names: `{a,b}` alternates (a `*` inside an alternative keeps its meaning),
 * `*` matches ONE dotless segment, everything else is literal, and the match is anchored.
 */
import { forEachCallable, type TSCallable, type TSCallsite, type TSDecorator, type TSEntrypoint, type TSModule } from "../schema";
import { callBodyKeys } from "../schema/l1Body";
import type { ArgSpec, CallRule, DecoratorRule } from "./rules";

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

const HTTP_VERBS: ReadonlySet<string> = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

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

const INLINE = /^(async\s*)?(\(|function\b|[A-Za-z_$][\w$]*\s*=>)/;

/**
 * Calls tier (python parity): a module-scope call (`app.get('/p', handler)`) whose written
 * receiver.method matches a `heuristics.calls` rule attaches the record to the HANDLER argument's
 * callable, not to the call site itself — the call site has no `entrypoints` of its own.
 */
export function entrypointsFromCalls(
  mod: TSModule,
  rules: readonly CallRule[],
  unresolved: (key: string) => void,
): Array<{ target: TSCallable; ep: TSEntrypoint }> {
  const out: Array<{ target: TSCallable; ep: TSEntrypoint }> = [];
  const callables: TSCallable[] = [];
  // Every call in the file: module-scope (mod.call_sites, this task) plus each callable's own
  // (already captured by buildCallable, independent of this task) — a nested `app.delete(...)`
  // inside a function is a call site on THAT callable, not on the module. `via` names whichever
  // one OWNS the site, not always the module. For a callable-owned site, `via` MUST use the same
  // body key `callBodyKeys` assigns (`@L:C`, `/2`, `/3`, … for chained calls sharing a start
  // position) — MODULE-owned sites have no `body{}` to key against, so they keep `@L:C` verbatim.
  const sites: Array<{ owner: string; key: string; site: TSCallsite }> =
    (mod.call_sites ?? []).map((site) => ({ owner: mod.id, key: `@${site.start_line}:${site.start_column}`, site }));
  forEachCallable(mod, (c) => {
    callables.push(c);
    for (const [key, site] of callBodyKeys(c.call_sites ?? [])) sites.push({ owner: c.id, key: `@${key}`, site });
  });
  for (const { owner, key, site } of sites) {
    const written = site.receiver_expr ? `${site.receiver_expr}.${site.method_name}` : site.method_name;
    for (const rule of rules) {
      if (!matchPattern(rule.match, written)) continue;
      const target = resolveHandler(site, rule, callables);
      if (!target) { unresolved(written); continue; }
      const ep: TSEntrypoint = {
        framework: "heuristic", confidence: rule.confidence, rule: rule.id, ruleset: rule.origin, evidence: written,
        http_methods: methodsOf(site.arguments, {}, rule.methods, written),
        via: `${owner}${key}`,
      };
      const route = routeOf(site.arguments, rule.route);
      if (route !== undefined) ep.route = route;
      out.push({ target, ep });
    }
  }
  return out;
}

function resolveHandler(site: TSCallsite, rule: CallRule, callables: readonly TSCallable[]): TSCallable | undefined {
  const idx = rule.handler.index ?? -1;
  const raw = site.arguments[idx < 0 ? site.arguments.length + idx : idx]?.trim();
  if (!raw) return undefined;
  if (/^[A-Za-z_$][\w$]*$/.test(raw)) return callables.find((c) => c.name === raw);
  if (INLINE.test(raw)) {
    const inside = callables.filter((c) => c.name === "(anonymous)" &&
      (c.span.start[0] > site.start_line || (c.span.start[0] === site.start_line && c.span.start[1] >= site.start_column)) &&
      (c.span.start[0] < site.end_line || (c.span.start[0] === site.end_line && c.span.start[1] <= site.end_column)));
    inside.sort((a, b) => a.span.start[0] - b.span.start[0] || a.span.start[1] - b.span.start[1]);
    return inside[0];
  }
  return undefined;
}

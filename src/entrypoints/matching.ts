/**
 * Rule matching (#72; python `matching.py` parity).
 *
 * Patterns are dotted names: `{a,b}` alternates (a `*` inside an alternative keeps its meaning),
 * `*` matches ONE dotless segment, everything else is literal, and the match is anchored.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { forEachCallable, type AnalysisInternal, type TSCallable, type TSCallsite, type TSDecorator, type TSEntrypoint, type TSModule, type TSType } from "../schema";
import { callBodyKeys } from "../schema/l1Body";
import type { ArgSpec, BaseRule, CallRule, DecoratorRule, FileRule, ManifestRule } from "./rules";

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

/**
 * Base-class tier: a rule matches when ANY base of the class — resolved through the import
 * table, else as written — matches `rule.match`. `transitive: true` also walks the bases of
 * every in-project ancestor reachable through `extends_ids` (an external ancestor has no node,
 * so the walk stops there); a `seen` set guards cycles. `dispatch:` only ever fires for a name
 * the class itself DEFINES as a method — `cls.callables` is keyed by plain method name
 * (`memberKey`, confirmed against a fixture: `get` → key `"get"`), so `Object.keys` is the
 * intersection, no `Object.values(...).map(c => c.name)` fallback needed.
 *
 * `resolve` takes the OWNER of the base spelling, not just `cls`: a transitive ancestor's
 * `base_classes` is WRITTEN in *that ancestor's own file*, so it can only be resolved through
 * that file's own import table — `cls`'s table has no binding for a name it never imports.
 */
export function entrypointsFromBases(
  cls: TSType,
  framework: string,
  rules: readonly BaseRule[],
  resolve: (written: string, owner: TSType) => string,
  typeById: Map<string, TSType>,
): { classEps: TSEntrypoint[]; methodEps: Map<string, TSEntrypoint[]> } {
  const classEps: TSEntrypoint[] = [];
  const methodEps = new Map<string, TSEntrypoint[]>();
  const directBases = (t: TSType): string[] => (t.base_classes ?? []).map((b) => resolve(b, t));
  const allBases = (transitive: boolean): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const stack: TSType[] = [cls];
    while (stack.length) {
      const t = stack.pop()!;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(...directBases(t));
      if (transitive) for (const id of t.extends_ids ?? []) { const p = typeById.get(id); if (p) stack.push(p); }
    }
    return out;
  };
  const defined = new Set(Object.keys(cls.callables ?? {}));
  for (const rule of rules) {
    if (!allBases(rule.transitive).some((b) => matchPattern(rule.match, b))) continue;
    classEps.push({ framework, confidence: rule.confidence, rule: rule.id, ruleset: rule.origin, evidence: cls.signature, http_methods: [] });
    for (const name of rule.dispatch) {
      if (!defined.has(name)) continue;
      const ep: TSEntrypoint = {
        framework, confidence: rule.confidence, rule: `${rule.id}.dispatch`, ruleset: rule.origin,
        evidence: cls.signature, http_methods: HTTP_VERBS.has(name.toLowerCase()) ? [name.toUpperCase()] : [], via: cls.id,
      };
      (methodEps.get(name) ?? methodEps.set(name, []).get(name)!).push(ep);
    }
  }
  return { classEps, methodEps };
}

/**
 * File-convention tier (#161; python has no analog — TS/JS-only). `match:` is a GLOB (`**` = any
 * path prefix incl. none, `*` = within one segment, `{a,b}` alternation) tested against the
 * module's project-relative POSIX file key, not a dotted name — so this gets its own tiny glob
 * engine rather than reusing `compilePattern`.
 */
const globCache = new Map<string, RegExp>();
export function globToRegExp(glob: string): RegExp {
  const hit = globCache.get(glob);
  if (hit) return hit;
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (glob.startsWith("**/", i)) { out += "(?:.*/)?"; i += 3; }
    else if (glob.startsWith("**", i)) { out += ".*"; i += 2; }
    else if (ch === "*") { out += "[^/]*"; i++; }
    else if (ch === "{") {
      const j = glob.indexOf("}", i);
      if (j < 0) throw new PatternError(`unclosed '{' in ${JSON.stringify(glob)}`);
      out += `(?:${glob.slice(i + 1, j).split(",").map((a) => a.trim().replace(/[.+?^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = j + 1;
    } else { out += ch.replace(/[.+?^$()|[\]\\/]/g, "\\$&"); i++; }
  }
  const re = new RegExp(`^${out}$`);
  globCache.set(glob, re);
  return re;
}

/**
 * A convention, not a contract (#161): strips the glob's literal prefix directory only when it is
 * `app/` (Next.js app router routes have no other segment worth keeping); `pages/api/...` keeps
 * its `/api/...` tail since that's the actual served path. Drops the extension and a trailing
 * `/route` or `/+server` segment; always anchors with a leading `/`; the app root `app/route.ts`
 * → `/`. `app/users/route.ts` → `/users`; `pages/api/hello.ts` → `/api/hello`;
 * `src/routes/x/+server.ts` → `/src/routes/x`.
 */
export function routeFromFileKey(fileKey: string, glob: string): string {
  const literalPrefix = glob.split(/[*{]/, 1)[0]!; // "app/", "pages/api/", or "" (no literal prefix)
  const rest = fileKey.startsWith(literalPrefix) ? fileKey.slice(literalPrefix.length) : fileKey;
  const noExt = rest.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/, "");
  const noTail = noExt.replace(/\/?(route|\+server)$/, "");
  const prefixDir = literalPrefix.replace(/^app\//, "/").replace(/^pages\//, "/").replace(/\/$/, "");
  return prefixDir + (noTail ? `/${noTail}` : "") || "/";
}

const DEFAULT_NAMED_EXPORT = /^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m;
const DEFAULT_EXPORT_TOKEN = /export\s+default\s+/g;

/**
 * Two spellings the direct-declaration check above misses (findings, unit 5 review): `export
 * default handler;` naming a callable declared elsewhere (the identifier need not itself be
 * `is_exported`), and `export default (…) => {}`/`export default async (…) => {}` whose anonymous
 * callable's span starts right after the `export default ` token, not at `export`.
 */
function resolveDefaultExport(mod: TSModule): TSCallable | undefined {
  const named = mod.source.match(DEFAULT_NAMED_EXPORT);
  if (named) {
    const target = Object.values(mod.functions).find((c) => c.name === named[1]);
    if (target) return target;
  }
  DEFAULT_EXPORT_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEFAULT_EXPORT_TOKEN.exec(mod.source))) {
    const end = m.index + m[0].length;
    const target = Object.values(mod.functions).find((c) => c.name === "(anonymous)" && c.span.bytes[0] === end);
    if (target) return target;
  }
  return undefined;
}

/**
 * File-convention matcher: a rule matches when the module's file key matches its glob. Per name in
 * `exports`, `"default"` resolves to the exported callable whose declaration text starts with
 * `export default` (`TSModule.exports` never records these — see `l1Body`/builder notes); failing
 * that, `resolveDefaultExport` tries the `export default <name>;` and anonymous-inline spellings.
 * Any other name resolves to the exported callable of that exact name. A name with no matching
 * callable yields nothing for that name — a route file legitimately exports only some verbs — EXCEPT
 * `"default"`, whose continued absence is counted via `unresolved` so a missed default export isn't
 * silent.
 */
export function entrypointsFromFiles(
  mod: TSModule,
  fileKey: string,
  framework: string,
  rules: readonly FileRule[],
  unresolved: (key: string) => void,
): Array<{ target: TSCallable; ep: TSEntrypoint }> {
  const out: Array<{ target: TSCallable; ep: TSEntrypoint }> = [];
  for (const rule of rules) {
    if (!globToRegExp(rule.match).test(fileKey)) continue;
    for (const exp of rule.exports) {
      let target = Object.values(mod.functions).find((c) => c.is_exported && (exp === "default"
        ? mod.source.slice(c.span.bytes[0], c.span.bytes[1]).trimStart().startsWith("export default")
        : c.name === exp));
      if (!target && exp === "default") target = resolveDefaultExport(mod);
      if (!target) {
        if (exp === "default") unresolved(`${fileKey}#default`);
        continue;
      }
      out.push({
        target,
        ep: {
          framework, confidence: rule.confidence, rule: rule.id, ruleset: rule.origin, evidence: fileKey,
          route: routeFromFileKey(fileKey, rule.match), http_methods: methodsOf([], {}, rule.methods, exp),
        },
      });
    }
  }
  return out;
}

/**
 * Manifest tier (#161; python has no analog): `package.json` is read from the artifact layer
 * (keyed by repo-relative path — the artifact record for the root manifest is always `"package.json"`),
 * falling back to disk when the artifact layer has no record OR recorded an empty `source`
 * (`--no-artifact-text` stores `""`, not absence — `||`, not `??`, so that case still falls
 * through to disk instead of silently disabling this whole tier).
 *
 * Returns `undefined` when there is no manifest text at all (nothing to report), or `{ error:
 * true }` when text existed but did not parse as a JSON object (a malformed manifest — counted by
 * the caller, not swallowed).
 */
function manifestOf(app: AnalysisInternal, input: string): { pkg: Record<string, unknown> } | { error: true } | undefined {
  const text = app.artifacts?.["package.json"]?.source
    || (() => { try { return fs.readFileSync(path.join(input, "package.json"), "utf8"); } catch { return undefined; } })();
  if (!text) return undefined;
  try {
    const j = JSON.parse(text);
    return typeof j === "object" && j ? { pkg: j as Record<string, unknown> } : { error: true };
  } catch {
    return { error: true };
  }
}

const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs"];
/** `dist/index.js` → the module `src/index.ts` (or `index.ts`, or as written) — whichever the symbol table has. */
function moduleForPath(app: AnalysisInternal, declared: string): string | undefined {
  const rel = declared.replace(/\\/g, "/").replace(/^\.\//, "");
  const stem = rel.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/, "");
  const bases = [stem, stem.replace(/^(dist|out|build|lib)\//, "src/"), stem.replace(/^(dist|out|build|lib)\//, "")];
  for (const b of bases) for (const ext of EXTS) if (app.symbol_table[b + ext]) return b + ext;
  return undefined;
}

/**
 * Manifest tier: a `main`/`bin` entry names a FILE, and "what runs when that file is executed" is
 * its module-scope calls (python has no analog — an npm-specific convention). Not a "heuristic"
 * framework — `never-doubles` (pipeline.ts calls tier) does not apply: a callable can legitimately
 * be both a framework handler AND a manifest-declared root, so this pushes unconditionally.
 */
export function entrypointsFromManifest(
  app: AnalysisInternal,
  input: string,
  rules: readonly ManifestRule[],
  unresolved: (key: string) => void,
): Array<{ target: TSCallable; ep: TSEntrypoint }> {
  const out: Array<{ target: TSCallable; ep: TSEntrypoint }> = [];
  const result = manifestOf(app, input);
  if (!result) return out;
  if ("error" in result) { unresolved("package.json"); return out; }
  const pkg = result.pkg;
  for (const rule of rules) {
    const raw = pkg[rule.field];
    const paths: string[] = typeof raw === "string" ? [raw]
      : raw && typeof raw === "object" ? Object.values(raw as Record<string, unknown>).filter((v): v is string => typeof v === "string")
      : [];
    for (const p of paths) {
      const key = moduleForPath(app, p);
      const mod = key ? app.symbol_table[key] : undefined;
      if (!mod) { unresolved(`package.json#${rule.field}:${p}`); continue; }
      const free = new Map(Object.values(mod.functions).map((c) => [c.name, c] as const));
      let hit = false;
      for (const site of mod.call_sites ?? []) {
        if (site.receiver_expr) continue;
        const target = free.get(site.method_name);
        if (!target) continue;
        hit = true;
        out.push({
          target,
          ep: { framework: "manifest", confidence: rule.confidence, rule: rule.id, ruleset: rule.origin,
            evidence: `package.json#${rule.field}`, http_methods: [], via: mod.id },
        });
      }
      if (!hit) unresolved(`package.json#${rule.field}:${p}`);
    }
  }
  return out;
}

/**
 * Entrypoint rules (#72; python #27 parity) — the declarative side of detection.
 *
 * Loading rules is CONFIGURATION, not detection: a malformed file is a hard error before analysis
 * starts (RulesError, thrown from analyze()). Detection is best-effort and lives in pipeline.ts.
 *
 * Task 1 of the plan lands the TYPES only; the loader arrives with Task 3.
 */
export type Confidence = "declared" | "certain" | "heuristic";

/** Where a route or method list comes from, per rule. Mirrors python's `route:` / `methods:`. */
export interface ArgSpec {
  from: "positional" | "keyword" | "match_suffix" | "export_name";
  index?: number; // positional; `-1` = last argument
  name?: string; // keyword
  default?: string[]; // methods only
}

export interface DecoratorRule {
  id: string;
  match: string;
  confidence: Confidence;
  route?: ArgSpec;
  methods?: ArgSpec;
  origin: string; // "shipped" | "user:<path>"
}

export interface CallRule extends DecoratorRule {
  /** Which argument is the handler the request reaches. Default: `{from: "positional", index: -1}`. */
  handler: ArgSpec;
}

export interface BaseRule {
  id: string;
  match: string;
  confidence: Confidence;
  transitive: boolean;
  dispatch: string[];
  origin: string;
}

export interface FileRule {
  id: string;
  match: string; // glob over the module file key, e.g. "app/**/route.{ts,js}"
  exports: string[]; // exported callable names; "default" = the default export
  confidence: Confidence;
  methods?: ArgSpec; // {from: export_name} → the export name uppercased is the HTTP method
  origin: string;
}

export interface ManifestRule {
  id: string;
  source: "package.json";
  field: "main" | "bin";
  confidence: Confidence;
  origin: string;
}

export interface Framework {
  name: string;
  detect: string[];
  decorators: DecoratorRule[];
  bases: BaseRule[];
  files: FileRule[];
}

export interface RuleSet {
  frameworks: Record<string, Framework>;
  /** Framework-independent, written-spelling tier. `confidence` is forced to "heuristic". */
  heuristics: { decorators: DecoratorRule[]; calls: CallRule[] };
  manifest: ManifestRule[];
  rulesets: string[];
}

export class RulesError extends Error {}

export const EMPTY_RULES: RuleSet = { frameworks: {}, heuristics: { decorators: [], calls: [] }, manifest: [], rulesets: [] };

// --- loader (Task 3) --------------------------------------------------------------------------
import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { PatternError, globToRegExp, validatePattern } from "./matching";
import SHIPPED_YAML from "./rules.yml" with { type: "text" };

const CONFIDENCE: ReadonlySet<string> = new Set(["declared", "certain", "heuristic"]);
// `declared:` readers and per-framework routing engines are spec blocks not implemented; they are
// deliberately absent here rather than accepted-and-ignored, so a user file using them fails
// loudly instead of loading clean and doing nothing.
const TOP_LEVEL = new Set(["version", "frameworks", "heuristics", "manifest", "disable"]);
const HEURISTIC_KEYS = new Set(["decorators", "calls"]);
const FRAMEWORK_KEYS = new Set(["detect", "decorators", "bases", "files"]);

type Raw = Record<string, unknown>;

export function loadRules(userPaths: readonly string[]): RuleSet {
  const out: RuleSet = { frameworks: {}, heuristics: { decorators: [], calls: [] }, manifest: [], rulesets: [] };
  merge(out, readYaml(SHIPPED_YAML, "shipped"), "shipped");
  for (const p of userPaths) {
    let text: string;
    try { text = fs.readFileSync(p, "utf8"); } catch { throw new RulesError(`rules file not found: ${p}`); }
    merge(out, readYaml(text, p), `user:${p}`);
  }
  return out;
}

function readYaml(text: string, origin: string): Raw {
  let data: unknown;
  try { data = parseYaml(text); } catch (e) { throw new RulesError(`${origin}: invalid YAML: ${(e as Error).message}`); }
  if (!isMap(data)) throw new RulesError(`${origin}: top level must be a mapping`);
  return data;
}

const isMap = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function merge(out: RuleSet, data: Raw, origin: string): void {
  const unknown = Object.keys(data).filter((k) => !TOP_LEVEL.has(k)).sort();
  if (unknown.length) throw new RulesError(`${origin}: unknown top-level key(s): ${unknown.join(", ")}`);
  out.rulesets.push(origin);
  const disabled = new Set(disableList(data, origin));

  const frameworks = data.frameworks ?? {};
  if (!isMap(frameworks)) throw new RulesError(`${origin}: \`frameworks\` must be a mapping`);
  for (const [name, body] of Object.entries(frameworks)) {
    if (!isMap(body)) throw new RulesError(`${origin}: framework \`${name}\` must be a mapping`);
    const bad = Object.keys(body).filter((k) => !FRAMEWORK_KEYS.has(k));
    if (bad.length) throw new RulesError(`${origin}: framework \`${name}\`: unknown key(s): ${bad.join(", ")}`);
    if (body.detect !== undefined && !Array.isArray(body.detect)) throw new RulesError(`${origin}: framework \`${name}\`: \`detect\` must be a list`);
    const fw = (out.frameworks[name] ??= { name, detect: [], decorators: [], bases: [], files: [] });
    fw.detect = [...new Set([...fw.detect, ...list(body.detect).map(String)])].sort();
    for (const raw of list(body.decorators)) fw.decorators.push(decoratorRule(raw, origin));
    for (const raw of list(body.bases)) fw.bases.push(baseRule(raw, origin));
    for (const raw of list(body.files)) fw.files.push(fileRule(raw, origin));
  }

  const heuristics = data.heuristics ?? {};
  if (!isMap(heuristics)) throw new RulesError(`${origin}: \`heuristics\` must be a mapping`);
  const badH = Object.keys(heuristics).filter((k) => !HEURISTIC_KEYS.has(k));
  if (badH.length) throw new RulesError(`${origin}: unknown heuristics key(s): ${badH.join(", ")}`);
  for (const raw of list(heuristics.decorators)) out.heuristics.decorators.push(decoratorRule({ ...(raw as Raw), confidence: "heuristic" }, origin));
  for (const raw of list(heuristics.calls)) out.heuristics.calls.push(callRule({ ...(raw as Raw), confidence: "heuristic" }, origin));

  for (const raw of list(data.manifest)) out.manifest.push(manifestRule(raw, origin));

  for (const fw of Object.values(out.frameworks)) {
    fw.decorators = fw.decorators.filter((r) => !disabled.has(r.id));
    fw.bases = fw.bases.filter((r) => !disabled.has(r.id));
    fw.files = fw.files.filter((r) => !disabled.has(r.id));
  }
  out.heuristics.decorators = out.heuristics.decorators.filter((r) => !disabled.has(r.id));
  out.heuristics.calls = out.heuristics.calls.filter((r) => !disabled.has(r.id));
  out.manifest = out.manifest.filter((r) => !disabled.has(r.id));
}

function disableList(data: Raw, origin: string): string[] {
  const raw = data.disable ?? [];
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) throw new RulesError(`${origin}: \`disable\` must be a list of rule id strings`);
  return raw as string[];
}

function require(raw: Raw, key: string, origin: string): unknown {
  if (!(key in raw)) throw new RulesError(`${origin}: rule ${JSON.stringify(raw)} is missing \`${key}\``);
  return raw[key];
}
function confidence(raw: Raw, origin: string): Confidence {
  const c = raw.confidence ?? "certain";
  if (typeof c !== "string" || !CONFIDENCE.has(c)) throw new RulesError(`${origin}: confidence must be one of declared, certain, heuristic — got ${JSON.stringify(c)}`);
  return c as Confidence;
}
function match(raw: Raw, origin: string): string {
  const m = String(require(raw, "match", origin));
  try { validatePattern(m); } catch (e) {
    if (e instanceof PatternError) throw new RulesError(`${origin}: rule ${JSON.stringify(raw.id ?? raw)}: ${e.message}`);
    throw e;
  }
  return m;
}
const ARG_FROM: ReadonlySet<string> = new Set(["positional", "keyword", "match_suffix", "export_name"]);
function argSpec(v: unknown, field: string, origin: string): ArgSpec | undefined {
  if (!isMap(v)) return undefined;
  const from = String(v.from);
  if (!ARG_FROM.has(from)) throw new RulesError(`${origin}: \`${field}.from\` must be one of positional, keyword, match_suffix, export_name — got ${JSON.stringify(v.from)}`);
  const spec: ArgSpec = { from: from as ArgSpec["from"] };
  if (typeof v.index === "number") spec.index = v.index;
  if (typeof v.name === "string") spec.name = v.name;
  if (Array.isArray(v.default)) spec.default = v.default.map(String);
  return spec;
}
function asRaw(raw: unknown, origin: string): Raw {
  if (!isMap(raw)) throw new RulesError(`${origin}: rule must be a mapping, got ${JSON.stringify(raw)}`);
  return raw;
}
function decoratorRule(raw0: unknown, origin: string): DecoratorRule {
  const raw = asRaw(raw0, origin);
  return { id: String(require(raw, "id", origin)), match: match(raw, origin), confidence: confidence(raw, origin),
           route: argSpec(raw.route, "route", origin), methods: argSpec(raw.methods, "methods", origin), origin };
}
function callRule(raw0: unknown, origin: string): CallRule {
  const raw = asRaw(raw0, origin);
  // `resolveHandler` (matching.ts) only ever reads a positional argument index; a `handler` spec
  // naming any other `from` would load clean and then silently resolve nothing.
  const handler = argSpec(raw.handler, "handler", origin) ?? { from: "positional", index: -1 };
  if (handler.from !== "positional") throw new RulesError(`${origin}: \`handler.from\` must be positional — got ${JSON.stringify(handler.from)}`);
  return { ...decoratorRule(raw, origin), handler };
}
function baseRule(raw0: unknown, origin: string): BaseRule {
  const raw = asRaw(raw0, origin);
  return { id: String(require(raw, "id", origin)), match: match(raw, origin), confidence: confidence(raw, origin),
           transitive: Boolean(raw.transitive ?? false), dispatch: list(raw.dispatch).map(String), origin };
}
function fileRule(raw0: unknown, origin: string): FileRule {
  const raw = asRaw(raw0, origin);
  const exports = list(require(raw, "exports", origin)).map(String);
  if (!exports.length) throw new RulesError(`${origin}: file rule ${JSON.stringify(raw.id)} needs a non-empty \`exports\``);
  const matchGlob = String(require(raw, "match", origin));
  try { globToRegExp(matchGlob); } catch (e) {
    if (e instanceof PatternError) throw new RulesError(`${origin}: file rule ${JSON.stringify(raw.id ?? raw)}: ${e.message}`);
    throw e;
  }
  return { id: String(require(raw, "id", origin)), match: matchGlob, exports,
           confidence: confidence(raw, origin), methods: argSpec(raw.methods, "methods", origin), origin };
}
function manifestRule(raw0: unknown, origin: string): ManifestRule {
  const raw = asRaw(raw0, origin);
  const field = String(require(raw, "field", origin));
  if (field !== "main" && field !== "bin") throw new RulesError(`${origin}: manifest field must be main or bin, got ${field}`);
  if ((raw.source ?? "package.json") !== "package.json") throw new RulesError(`${origin}: manifest source must be package.json`);
  const c = raw.confidence ?? "declared";
  return { id: String(require(raw, "id", origin)), source: "package.json", field, confidence: confidence({ confidence: c }, origin), origin };
}

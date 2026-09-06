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

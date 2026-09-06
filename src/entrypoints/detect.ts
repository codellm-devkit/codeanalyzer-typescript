/**
 * Stage 0: which frameworks does this project actually use? (#72; python #27 parity)
 *
 * Gates every later stage, so a project without NestJS never pays for NestJS rules AND cannot
 * false-positive on a locally defined `Controller`. A package counts as present if first-party
 * source imports it OR the dependency manifest names it — either is sufficient, since an import
 * may be dynamic. Both sides are lowercased: npm is case-insensitive in practice and a
 * `detect: [Flask]` user rule must not silently miss a `flask` import.
 */
import type { AnalysisInternal, TSModule } from "../schema";
import type { RuleSet } from "./rules";

export function detectedFrameworks(app: AnalysisInternal, rules: RuleSet): Set<string> {
  const present = new Set<string>();
  for (const mod of Object.values(app.symbol_table)) {
    for (const imp of mod.imports ?? []) present.add(packageOf(imp.module));
  }
  for (const dep of app.dependencies ?? []) present.add(dep.name.toLowerCase());
  const out = new Set<string>();
  for (const [name, fw] of Object.entries(rules.frameworks)) {
    const probes = fw.detect.length ? fw.detect : [name];
    if (probes.some((p) => present.has(p.toLowerCase()))) out.add(name);
  }
  return out;
}

/** The npm package a specifier belongs to: `@scope/name/sub` → `@scope/name`; `lodash/fp` → `lodash`. */
export function packageOf(specifier: string): string {
  const s = specifier.toLowerCase();
  if (s.startsWith(".") || s.startsWith("/")) return s; // relative: never a framework
  const parts = s.split("/");
  return (s.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
}

/**
 * ECMAScript + the DOM bases a first-party class commonly extends. A spelling headed by one of
 * these is nameable without any import, so it is not "unresolved". Fixed list, not `globalThis`
 * at analysis time: the counter must not depend on the analyzer's own runtime.
 */
export const JS_GLOBALS: ReadonlySet<string> = new Set([
  "Object", "Function", "Array", "Boolean", "Number", "String", "Symbol", "BigInt", "Date", "RegExp",
  "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Proxy", "Reflect", "JSON", "Math",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array",
  "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "Event", "EventTarget", "HTMLElement", "Element", "Node",
]);

/** Names that can head a nameable spelling in this module: its declared types, module-level fields (incl. `declare const`), and every local import binding. */
export function knownHeads(mod: TSModule): Set<string> {
  const heads = new Set<string>(Object.values(mod.types ?? {}).map((t) => t.name));
  for (const f of Object.values(mod.fields ?? {})) heads.add(f.name);
  for (const imp of mod.imports ?? []) {
    if (imp.import_kind === "side_effect") continue;
    heads.add(imp.alias ?? imp.name); // the LOCAL binding; for a named import without alias that is the name
  }
  return heads;
}

/** Whether a written base/decorator spelling maps to nothing this module can name. Generics/subscripts stripped first. */
export function unnameable(written: string, known: Set<string>): boolean {
  const head = written.split("<", 1)[0]!.split("[", 1)[0]!.split(".", 1)[0]!.trim();
  return head.length > 0 && !JS_GLOBALS.has(head) && !known.has(head);
}

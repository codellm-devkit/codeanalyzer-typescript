/**
 * Entrypoint pass (#72; python #27 parity) — a level-free post-pass over the built L1 tree.
 *
 * Runs after heritage (unit 4 matches on resolved extends_ids). Per-run, like heritage: the cached
 * tree is stamped fresh each run. Best-effort by contract — a failure here loses flags, never the
 * analysis — so the error path records into the report rather than throwing. (Loading the rules
 * is the one hard-error step, and it happens in analyze(), before any of this.)
 */
import { forEachCallable, forEachType, type AnalysisInternal, type TSCallable, type TSEntrypointReport, type TSType } from "../schema";
import { importTable, resolveWritten } from "../syntactic_analysis/importResolver";
import { detectedFrameworks, knownHeads, unnameable } from "./detect";
import { entrypointsFromBases, entrypointsFromCalls, entrypointsFromDecorators } from "./matching";
import { EMPTY_RULES, type RuleSet } from "./rules";

export function detectEntrypoints(app: AnalysisInternal, rules: RuleSet = EMPTY_RULES): TSEntrypointReport {
  const report: TSEntrypointReport = { frameworks_detected: [], rulesets: [...rules.rulesets], unresolved: {}, errors: [] };
  const bump = (k: string): void => { report.unresolved[k] = (report.unresolved[k] ?? 0) + 1; };
  try {
    // Reset: the contract says every callable and every class carries the fields, empty by default.
    for (const mod of Object.values(app.symbol_table)) {
      forEachCallable(mod, (c) => { c.entrypoints = []; c.is_entrypoint = false; });
      forEachType(mod, (t) => { if (t.kind === "class") { t.entrypoints = []; t.is_entrypoint = false; } });
    }
    report.frameworks_detected = [...detectedFrameworks(app, rules)].sort();

    // The counter that makes silence visible (python #177): every decorator and base spelling
    // that neither the import table nor the module itself can name.
    for (const mod of Object.values(app.symbol_table)) {
      const known = knownHeads(mod);
      forEachCallable(mod, (c) => { for (const d of c.decorators ?? []) if (!d.qualified_name && unnameable(d.name, known)) bump(d.name); });
      forEachType(mod, (t) => {
        for (const d of t.decorators ?? []) if (!d.qualified_name && unnameable(d.name, known)) bump(d.name);
        if (t.kind === "class") for (const b of t.base_classes ?? []) if (!isSignature(b) && unnameable(b, known)) bump(b);
      });
    }

    const frameworks = report.frameworks_detected;

    // Base-class tier (#159): class-only, one detected framework at a time, BEFORE the decorator
    // tiers — so a class/method a base rule claims counts as framework-claimed for never-doubles
    // (the heuristic decorator tier and the calls tier both check `entrypoints.length === 0`).
    // `typeById` and a resolver PER TYPE (its own module's import table — a transitive ancestor's
    // `base_classes` is written in that ancestor's own file, so `cls`'s import table cannot name
    // it) are both built once per run by this single walk.
    const typeById = new Map<string, TSType>();
    const resolveByType = new Map<string, (written: string) => string>();
    for (const mod of Object.values(app.symbol_table)) {
      const table = importTable(mod.imports ?? []);
      const resolveInModule = (written: string): string => resolveWritten(table, written) ?? written;
      forEachType(mod, (t) => { typeById.set(t.id, t); resolveByType.set(t.id, resolveInModule); });
    }
    const resolve = (written: string, owner: TSType): string => (resolveByType.get(owner.id) ?? ((w: string) => w))(written);
    for (const mod of Object.values(app.symbol_table)) {
      forEachType(mod, (t) => {
        if (t.kind !== "class") return;
        for (const name of frameworks) {
          const baseRules = rules.frameworks[name]!.bases;
          if (!baseRules.length) continue;
          const { classEps, methodEps } = entrypointsFromBases(t, name, baseRules, resolve, typeById);
          (t.entrypoints ??= []).push(...classEps);
          for (const [methodName, eps] of methodEps) {
            const m = t.callables?.[methodName];
            if (m) (m.entrypoints ??= []).push(...eps);
          }
        }
      });
    }

    // Framework tier (matches `qualified_name`), then the heuristic tier LAST (matches `name` as
    // written; never doubles a node a framework rule already claimed — python #185 parity).
    const visit = (node: TSCallable | TSType): void => {
      node.entrypoints = node.entrypoints ?? [];
      for (const name of frameworks) {
        node.entrypoints.push(...entrypointsFromDecorators(node, name, rules.frameworks[name]!.decorators, false));
      }
      if (node.entrypoints.length === 0) {
        node.entrypoints.push(...entrypointsFromDecorators(node, "heuristic", rules.heuristics.decorators, true));
      }
      node.is_entrypoint = node.entrypoints.length > 0;
    };
    for (const mod of Object.values(app.symbol_table)) {
      forEachCallable(mod, (c) => visit(c));
      forEachType(mod, (t) => { if (t.kind === "class") visit(t); });
    }

    // Calls tier (python parity): module-scope `app.get('/p', handler)` shapes attach to the
    // HANDLER, last, and never double a node a FRAMEWORK rule already claimed.
    for (const mod of Object.values(app.symbol_table)) {
      for (const { target, ep } of entrypointsFromCalls(mod, rules.heuristics.calls, bump)) {
        if ((target.entrypoints ?? []).some((e) => e.framework !== "heuristic")) continue;
        (target.entrypoints ??= []).push(ep);
        target.is_entrypoint = true;
      }
    }
  } catch (e) {
    report.errors.push((e as Error).message);
  }
  return report;
}

/** `base_classes` holds an in-project SIGNATURE when the checker resolved the base (`src/models.Entity`), else the written spelling. */
function isSignature(base: string): boolean {
  return base.includes("/") || (/^[^.<]+\.[^.<]/.test(base) && !/^[A-Z]/.test(base));
}

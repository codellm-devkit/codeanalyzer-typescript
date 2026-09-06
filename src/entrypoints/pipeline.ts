/**
 * Entrypoint pass (#72; python #27 parity) — a level-free post-pass over the built L1 tree.
 *
 * Runs after heritage (unit 4 matches on resolved extends_ids). Per-run, like heritage: the cached
 * tree is stamped fresh each run. Best-effort by contract — a failure here loses flags, never the
 * analysis — so the error path records into the report rather than throwing. (Loading the rules
 * is the one hard-error step, and it happens in analyze(), before any of this.)
 */
import { forEachCallable, forEachType, type AnalysisInternal, type TSEntrypointReport } from "../schema";
import { detectedFrameworks, knownHeads, unnameable } from "./detect";
import { EMPTY_RULES, type RuleSet } from "./rules";

export function detectEntrypoints(app: AnalysisInternal, rules: RuleSet = EMPTY_RULES): TSEntrypointReport {
  const report: TSEntrypointReport = { frameworks_detected: [], rulesets: [...rules.rulesets], unresolved: {}, errors: [] };
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
      const bump = (k: string): void => { report.unresolved[k] = (report.unresolved[k] ?? 0) + 1; };
      forEachCallable(mod, (c) => { for (const d of c.decorators ?? []) if (!d.qualified_name && unnameable(d.name, known)) bump(d.name); });
      forEachType(mod, (t) => {
        for (const d of t.decorators ?? []) if (!d.qualified_name && unnameable(d.name, known)) bump(d.name);
        if (t.kind === "class") for (const b of t.base_classes ?? []) if (!isSignature(b) && unnameable(b, known)) bump(b);
      });
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

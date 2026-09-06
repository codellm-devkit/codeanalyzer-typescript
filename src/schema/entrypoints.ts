/**
 * Entrypoint pass (#72; python #27 parity) — a level-free post-pass over the built L1 tree.
 *
 * Unit 1 (#153): the CONTRACT only. Every callable and every class is stamped `entrypoints: []` /
 * `is_entrypoint: false`, and the report is empty. Detection — the framework gate, the rules file,
 * the matchers — is units 2-5. Landing the shape first means the fields exist at every -a before
 * any detector does, and a consumer can already tell "no entrypoints" from "no pass ran".
 *
 * Per-run, like heritage: the cached tree is stamped fresh each run, so the cache stays free of
 * per-run layers. Best-effort by contract: a failure here loses flags, never the analysis, so the
 * error path records into the report rather than throwing.
 */
import { forEachCallable, forEachType, type AnalysisInternal, type TSEntrypointReport } from "./schema";

export function detectEntrypoints(app: AnalysisInternal): TSEntrypointReport {
  const report: TSEntrypointReport = { frameworks_detected: [], rulesets: [], unresolved: {}, errors: [] };
  try {
    for (const mod of Object.values(app.symbol_table)) {
      forEachCallable(mod, (c) => {
        c.entrypoints = [];
        c.is_entrypoint = false;
      });
      forEachType(mod, (t) => {
        if (t.kind !== "class") return; // python stamps PyClass; nothing else can be an entrypoint
        t.entrypoints = [];
        t.is_entrypoint = false;
      });
    }
  } catch (e) {
    report.errors.push((e as Error).message);
  }
  return report;
}

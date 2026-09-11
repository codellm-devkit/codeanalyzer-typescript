/**
 * finalizeAnalysis — the per-run pass spine (invoked by `analyze()`, python-parity: core runs the
 * passes; serialization is dumb): stamp the per-run layers onto the NATIVELY-built tree, assemble
 * the envelope, and strip the INTERNAL fields. No reshaping happens anywhere — the builders
 * construct the wire shapes directly (src/syntactic_analysis/builders.ts):
 *
 *   assignIds       — can:// ids (per-run: ids embed --app-name; the cache stays id-free)
 *   populateL1Body  — call_sites/config_accesses → body{} `call`/`config_access` nodes, callee: null
 *   resolveHeritage — extends_ids / implements_ids (resolved-only)
 *   [L2] homeExternals / homeSynthesized / backfillCallees / reidentifyCallGraph
 *   [L3/4] applyDataflow — program_graphs → body{} + cfg/cdg/ddg/summary + param_in/param_out
 *
 * The returned application is a DEEP, INTERNAL-FIELD-STRIPPED copy: the live tree keeps
 * `call_sites`, `config_accesses`, `abs_path`, and the cache metadata for the resolver/dataflow/
 * cache, while every consumer of the emission (JSON writer, Neo4j projection, tests) sees exactly
 * the wire.
 */

import * as path from "node:path";
import type { Project } from "ts-morph";
import type { AnalysisOptions } from "../options";
import { ANALYZER_VERSION } from "../utils/version";
import type { AnalysisInternal, TSAnalysis, TSApplication } from "./schema";
import type { ProgramGraphs } from "./graphs";
import { assignIds } from "./assignIds";
import { populateL1Body } from "./l1Body";
import { resolveHeritageIds } from "./heritage";
import { detectEntrypoints, type RuleSet } from "../entrypoints";
import { homeExternals, homeSynthesized } from "./homing";
import { backfillCallees, reidentifyCallGraph } from "./l2Callees";
import { applyDataflow } from "../dataflow/attach";
import { resolveLiteralConfigUses } from "../semantic_analysis/configUse";
import { widenConfigUses } from "../dataflow/configUse";

const LANGUAGE = "typescript";
const SCHEMA_VERSION = "2.0.0";
const ANALYZER_NAME = "codeanalyzer-typescript";
/** Highest analysis level this emitter populates today (L1 tree, L2 call graph, L3/L4 dataflow). */
const MAX_IMPLEMENTED = 4;

/**
 * Structural internal-field strip on the WIRE COPY's per-module clones: module cache trio +
 * callable join fields. Structural (walks the tree shape) rather than key-name-based, for two
 * load-bearing reasons: the artifact layer's `content_hash` is WIRE payload (a name-keyed replacer
 * would eat it), and a `JSON.stringify` deep-copy roundtrip builds one multi-GB string at
 * vscode-L4 scale and OOMs (measured). Per-module `structuredClone` + targeted deletes never
 * materializes a string and never serializes more than one module at a time (#180).
 */
function stripInternal(root: TSApplication): void {
  const stripCallable = (c: Record<string, unknown>): void => {
    delete c["call_sites"];
    delete c["config_accesses"];
    delete c["abs_path"];
    for (const nested of Object.values((c["callables"] as Record<string, Record<string, unknown>>) ?? {})) stripCallable(nested);
    for (const t of Object.values((c["types"] as Record<string, Record<string, unknown>>) ?? {})) stripType(t);
  };
  const stripType = (t: Record<string, unknown>): void => {
    for (const m of Object.values((t["callables"] as Record<string, Record<string, unknown>>) ?? {})) stripCallable(m);
    for (const f of Object.values((t["functions"] as Record<string, Record<string, unknown>>) ?? {})) stripCallable(f);
    for (const nt of Object.values((t["types"] as Record<string, Record<string, unknown>>) ?? {})) stripType(nt);
  };
  for (const mod of Object.values(root.symbol_table) as unknown as Record<string, unknown>[]) {
    // `content_hash` STAYS on the wire (#118). The Neo4j projection is built from this envelope
    // and writes it onto :TSModule, where the incremental push reads it back to find changed
    // modules -- stripping it here made that diff compare against NULL forever, so every push was
    // a full re-upsert. codeanalyzer-python keeps it for the same reason (schema/py_schema.py).
    delete mod["last_modified"];
    delete mod["file_size"];
    delete mod["call_sites"];
    for (const fn of Object.values((mod["functions"] as Record<string, Record<string, unknown>>) ?? {})) stripCallable(fn);
    for (const t of Object.values((mod["types"] as Record<string, Record<string, unknown>>) ?? {})) stripType(t);
  }
}

// ----------------------------------------------------------------------------------------------
// entry point
// ----------------------------------------------------------------------------------------------

export interface AnalysisResult {
  application: TSAnalysis; // the wire: deep, internal-field-stripped envelope
  internal: AnalysisInternal; // the live internal working set (tree + sig-keyed provider outputs)
  program_graphs?: ProgramGraphs; // the L3/L4 compute IR (already attached onto the wire tree)
  idBySig: Map<string, string>; // signature → can:// id (real callables + externals + synthesized)
  collisions: string[]; // signatures that mapped to two distinct ids (L1 id-uniqueness gate)
  dangling: string[]; // call-graph endpoints with no id home (L2 no-dangling gate; should be empty)
}

export function finalizeAnalysis(
  app: AnalysisInternal,
  pg: ProgramGraphs | null,
  opts: AnalysisOptions,
  resolutions?: Map<string, Map<string, string>>,
  project?: Project,
  rules?: RuleSet,
): AnalysisResult {
  const level = opts.analysisLevel;
  const appName = (opts.appName ?? (opts.input ? path.basename(opts.input) : "") ?? "").trim() || "app";

  // L1 — stamp ids, derive body{}, project heritage (all overwrite-idempotent per-run passes).
  const { appId, idBySig, typeIdBySig, callableBySig, collisions } = assignIds(app, appName);
  populateL1Body(app);
  // `extends`/`implements` name TYPES: on a merged name (#177) the type facet's id wins over the
  // value facet's, which is what `idBySig` holds for every other pass.
  resolveHeritageIds(app, new Map([...idBySig, ...typeIdBySig]));
  // Level-free, after heritage: unit 4 matches on resolved extends_ids.
  const entrypoint_report = detectEntrypoints(app, opts, rules);

  const root: TSApplication = {
    id: appId,
    name: appName,
    kind: "application",
    symbol_table: app.symbol_table,
    call_graph: [],
    param_in: [],
    param_out: [],
    artifacts: app.artifacts ?? {},
    dependencies: app.dependencies ?? [],
    unresolved_imports: app.unresolved_imports ?? [],
    config_uses: app.config_uses ?? [],
    config_reads: app.config_reads ?? [],
    entrypoint_report,
  };

  // L2 — home the off-tree edge endpoints, backfill `callee`, re-identify the call graph.
  const dangling: string[] = [];
  if (level >= 2) {
    root.external_symbols = homeExternals(app, appId, idBySig);
    root.synthesized_callables = homeSynthesized(app, appId, idBySig);
    backfillCallees(app, idBySig, resolutions);
    // config_use literal tier (#101): needs the artifact layer's keys and, for CALL rules, the
    // resolved call graph (`callee` ids only exist after backfillCallees) — so it runs here, not
    // in core.ts. `src`/`dst` reference can:// ids assignIds already stamped above.
    const literal = resolveLiteralConfigUses(app, root.external_symbols ?? {});
    root.config_uses = literal.uses;
    root.config_reads = literal.reads;
    root.call_graph = reidentifyCallGraph(app.call_graph ?? [], idBySig, dangling);
  }

  // config_use dataflow tiers (#101 unit C3): widens the literal tier over AST symbol resolution
  // (intra) and resolved internal call sites (interproc, -a 4). Needs the real AST, so it's
  // gated on `project` too, not just the level — core.ts always has one to pass at level >= 3.
  if (level >= 3 && project) {
    const widened = widenConfigUses(app, project, { uses: root.config_uses, reads: root.config_reads }, level);
    root.config_uses = widened.uses;
    root.config_reads = widened.reads;
  }

  // L3/L4 — grow body{} + cfg/cdg/ddg/summary on callables and param_in/param_out on the app.
  let k_limit: number | undefined;
  if (level >= 3 && pg) {
    applyDataflow(root, pg, idBySig, callableBySig, level);
    k_limit = pg.k_limit;
  }

  const envelope: TSAnalysis = {
    schema_version: SCHEMA_VERSION,
    language: LANGUAGE,
    max_level: Math.min(level, MAX_IMPLEMENTED),
    ...(k_limit !== undefined ? { k_limit } : {}),
    analyzer: { name: ANALYZER_NAME, version: ANALYZER_VERSION },
    application: root,
  };
  // The wire copy: detached from the live tree, internals stripped STRUCTURALLY. The strip only
  // ever touches modules (and what hangs off them), so the clone is per MODULE (#180): one
  // structuredClone of the whole envelope hits Bun's serialization ceiling on a large repository
  // (a TypeError at 13k files on 1.3.0; a hard abort with no exception at ~2 GiB on 1.3.14 —
  // measured), while the largest single module is megabytes. Everything else on the root
  // (call_graph, param_in/out, artifacts, config edges, entrypoint report) is untouched by the
  // strip and shared by reference. A stringify roundtrip is out for the same reason: the string
  // form OOMs at vscode-L4 scale.
  const symbol_table: TSApplication["symbol_table"] = {};
  for (const [key, mod] of Object.entries(root.symbol_table)) symbol_table[key] = structuredClone(mod);
  const application: TSAnalysis = { ...envelope, application: { ...root, symbol_table } };
  stripInternal(application.application);
  return { application, internal: app, ...(pg ? { program_graphs: pg } : {}), idBySig, collisions, dangling };
}

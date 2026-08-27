/**
 * Call-graph build seam. One backend: the tsc (ts-morph checker) resolver. `tscProvider` stays an
 * object (rather than a bare function) so tests can spy on the build being skipped at -a 1.
 * `mergeCallGraphs` merges edge/node sets by (source, target) with provenance union — the defuse
 * linker's edges overlay the tsc base through it (an edge found by both carries
 * `["defuse", "tsc"]` after the wire sort).
 */
import type { Project } from "ts-morph";
import type { TSExternalSymbol, TSModule } from "../schema";
import type { Logger } from "../utils";
import { buildCallGraph, type CallGraphResult } from "./callGraph";

/** Everything the builder needs to produce a call graph over the analyzed project. */
export interface CallGraphContext {
  project: Project;
  symbol_table: Record<string, TSModule>;
  root: string;
  log: Logger;
  phantoms: boolean;
  // Multi-program scoping: when set, iterate only callables whose module fileKey is in this set
  // (the current program's files). Signature GATING still uses the full merged symbol_table, so a
  // cross-program in-project call resolves rather than becoming a phantom. Undefined = all files.
  only?: Set<string>;
}

export interface CallGraphProvider {
  readonly name: string;
  build(ctx: CallGraphContext): CallGraphResult;
}

/** The one backend — the ts-morph checker resolver (+ RTA + phantoms). */
export const tscProvider: CallGraphProvider = {
  name: "tsc",
  build: (ctx) => buildCallGraph(ctx.project, ctx.symbol_table, ctx.root, ctx.log, ctx.phantoms, ctx.only),
};

/**
 * Merge two call-graph results into their union. Pure (no I/O) so it can be unit-tested directly.
 *
 * Edges are keyed by `(source, target)`. A duplicate edge sums its weight, unions its `provenance`,
 * and merges its tags (base wins on conflict — the base edge is authoritative for the shared key).
 * External symbols union by signature, base winning on conflict.
 */
export function mergeCallGraphs(a: CallGraphResult, b: CallGraphResult): CallGraphResult {
  const byKey = new Map<string, CallGraphResult["edges"][number]>();
  const key = (e: { source: string; target: string }): string => `${e.source} ${e.target}`;

  for (const e of a.edges) byKey.set(key(e), { ...e, provenance: [...e.provenance], tags: { ...e.tags } });
  for (const e of b.edges) {
    const ex = byKey.get(key(e));
    if (!ex) {
      byKey.set(key(e), { ...e, provenance: [...e.provenance], tags: { ...e.tags } });
      continue;
    }
    ex.weight += e.weight;
    for (const p of e.provenance) if (!ex.provenance.includes(p)) ex.provenance.push(p);
    for (const [k, v] of Object.entries(e.tags)) if (!(k in ex.tags)) ex.tags[k] = v;
  }

  const external_symbols: Record<string, TSExternalSymbol> = { ...b.external_symbols, ...a.external_symbols };
  const synthesized_callables = { ...b.synthesized_callables, ...a.synthesized_callables };
  return { edges: [...byKey.values()], external_symbols, synthesized_callables };
}

/**
 * Call-graph provider seam. The orchestrator builds the graph through a CallGraphProvider so the
 * backend is swappable:
 *   • `union` (default) — run tsc + jelly and emit the MERGED edge/node set (tsc ∪ jelly), tagged
 *     by `provenance` so consumers can still tell the two apart.
 *   • `tsc` — the always-on ts-morph resolver only (the explicit `--tsc-only` opt-out).
 *   • `jelly` — the cs-au-dk flow-based analyzer only.
 * `both` is a deprecated alias of `union`: it used to run each and log a diff while emitting tsc
 * only, which silently discarded every jelly edge and external symbol (see issue #11).
 */
import type { Project } from "ts-morph";
import type { TSExternalSymbol, TSModule } from "../schema";
import type { Logger } from "../utils";
import { buildCallGraph, type CallGraphResult } from "./callGraph";
import { jellyProvider } from "./jellyProvider";

/** Everything a provider needs to produce a call graph over the analyzed project. */
export interface CallGraphContext {
  project: Project;
  symbol_table: Record<string, TSModule>;
  root: string;
  log: Logger;
  phantoms: boolean;
}

export interface CallGraphProvider {
  readonly name: string;
  build(ctx: CallGraphContext): CallGraphResult;
}

/** The always-available backend — wraps the existing tsc resolver with zero behavior change. */
export const tscProvider: CallGraphProvider = {
  name: "tsc",
  build: (ctx) => buildCallGraph(ctx.project, ctx.symbol_table, ctx.root, ctx.log, ctx.phantoms),
};

/**
 * Merge two call-graph results into their union. Pure (no I/O) so it can be unit-tested directly.
 *
 * Edges are keyed by `(source, target)`. A duplicate edge sums its weight, unions its `provenance`
 * (so an edge found by both providers carries `["tsc", "jelly"]`), and merges its tags (base wins
 * on conflict — the tsc edge is the authoritative one for the shared key). External symbols union
 * by signature, base winning on conflict. `a` is treated as the base (tsc), `b` as the overlay
 * (jelly).
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

/** Count how the two edge sets overlap — preserves the old `both`-mode diagnostic. */
function diffSummary(tsc: CallGraphResult, jelly: CallGraphResult): string {
  const key = (e: { source: string; target: string }): string => `${e.source} ${e.target}`;
  const tscKeys = new Set(tsc.edges.map(key));
  const jellyKeys = new Set(jelly.edges.map(key));
  let shared = 0;
  for (const k of jellyKeys) if (tscKeys.has(k)) shared++;
  return (
    `${shared} shared, ${tscKeys.size - shared} tsc-only, ${jellyKeys.size - shared} jelly-only ` +
    `(tsc=${tscKeys.size}, jelly=${jellyKeys.size})`
  );
}

/**
 * Run tsc + jelly and emit their union. This is the default: jelly's edges and external symbols are
 * PERSISTED (tagged `provenance: ["jelly"]`) instead of being discarded after a diff. If jelly
 * fails, degrade to tsc only rather than failing the whole analysis.
 */
export const unionProvider: CallGraphProvider = {
  name: "union",
  build(ctx) {
    const tsc = tscProvider.build(ctx);
    let jelly: CallGraphResult;
    try {
      jelly = jellyProvider.build(ctx);
    } catch (e) {
      ctx.log.info(`call graph (union): jelly failed (${(e as Error).message}); emitting tsc only`);
      return tsc;
    }
    ctx.log.info(`call graph diff: ${diffSummary(tsc, jelly)}`);
    const merged = mergeCallGraphs(tsc, jelly);
    ctx.log.info(
      `call graph (union): ${merged.edges.length} edges, ` +
        `${Object.keys(merged.external_symbols).length} external symbols`,
    );
    return merged;
  },
};

export function selectProvider(name: string): CallGraphProvider {
  switch (name) {
    case "tsc":
      return tscProvider;
    case "jelly":
      return jellyProvider;
    default:
      // "union" (the default) and the deprecated "both" alias both land here.
      return unionProvider;
  }
}

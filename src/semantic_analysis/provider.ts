/**
 * Call-graph provider seam. The orchestrator builds the graph through a CallGraphProvider so the
 * backend is swappable: `tsc` (the always-on ts-morph resolver) or `jelly` (cs-au-dk flow-based),
 * with a `both` mode that runs each and logs an edge-set diff for comparison.
 */
import type { Project } from "ts-morph";
import type { TSModule } from "../schema";
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

/** The default, always-available backend — wraps the existing tsc resolver with zero behavior change. */
export const tscProvider: CallGraphProvider = {
  name: "tsc",
  build: (ctx) => buildCallGraph(ctx.project, ctx.symbol_table, ctx.root, ctx.log, ctx.phantoms),
};

/**
 * Run tsc (authoritative) + jelly (experimental), log how their edge sets differ, and return the
 * tsc result unchanged. This is the safe "compare before promoting" mode: the emitted graph is
 * still the trusted tsc one; jelly only feeds the diagnostic.
 */
export const bothProvider: CallGraphProvider = {
  name: "both",
  build(ctx) {
    const tsc = tscProvider.build(ctx);
    let jelly: CallGraphResult;
    try {
      jelly = jellyProvider.build(ctx);
    } catch (e) {
      ctx.log.info(`call graph (both): jelly failed (${(e as Error).message}); returning tsc only`);
      return tsc;
    }
    diffEdges(tsc, jelly, ctx.log);
    return tsc;
  },
};

function diffEdges(tsc: CallGraphResult, jelly: CallGraphResult, log: Logger): void {
  const key = (e: { source: string; target: string }): string => `${e.source} ${e.target}`;
  const tscKeys = new Set(tsc.edges.map(key));
  const jellyKeys = new Set(jelly.edges.map(key));
  let shared = 0;
  for (const k of jellyKeys) if (tscKeys.has(k)) shared++;
  log.info(
    `call graph diff: ${shared} shared, ${tscKeys.size - shared} tsc-only, ${jellyKeys.size - shared} jelly-only ` +
      `(tsc=${tscKeys.size}, jelly=${jellyKeys.size})`,
  );
}

export function selectProvider(name: string): CallGraphProvider {
  switch (name) {
    case "jelly":
      return jellyProvider;
    case "both":
      return bothProvider;
    default:
      return tscProvider;
  }
}

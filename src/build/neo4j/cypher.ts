/**
 * The snapshot writer: render `GraphRows` to a self-contained `.cypher` script. Running it
 * (e.g. `cypher-shell < graph.cypher`) rebuilds this project's subgraph from scratch — constraints,
 * a scoped wipe of the prior version, then batched `UNWIND … MERGE` for nodes and edges.
 *
 * This artifact is intentionally NOT incremental: a static script has no view of the live DB, so
 * it expresses the full truth. Incremental updates are the bolt writer's job.
 */

import type { EdgeRow, GraphRows, NodeRow, Props } from "./rows";
import { chunk, cypherMap, cypherValue } from "./rows";
import { CONSTRAINTS, INDEXES } from "./schema";

const BATCH = 500;

export function renderCypher(rows: GraphRows, appName: string): string {
  const out: string[] = [];

  out.push("// ── constraints & indexes ──");
  for (const stmt of CONSTRAINTS) out.push(`${stmt};`);
  for (const stmt of INDEXES) out.push(`${stmt};`);

  out.push("", "// ── wipe this project's prior subgraph (externals/packages/decorators are shared) ──");
  out.push(wipe(appName));

  out.push("", "// ── nodes ──");
  for (const block of nodeStatements(rows.nodes)) out.push(block);

  out.push("", "// ── relationships ──");
  for (const block of edgeStatements(rows.edges)) out.push(block);

  out.push("");
  return out.join("\n");
}

function wipe(appName: string): string {
  const name = cypherValue(appName);
  return [
    `MATCH (a:TSApplication {name: ${name}})`,
    "OPTIONAL MATCH (a)-[:TS_HAS_MODULE]->(m:TSModule)",
    "OPTIONAL MATCH (m)-[:TS_DECLARES|TS_HAS_METHOD|TS_HAS_ATTRIBUTE|TS_DECLARES_VAR|TS_HAS_CALLSITE*1..]->(x)",
    "DETACH DELETE x, m, a;",
  ].join("\n");
}

// ----------------------------------------------------------------------------------------------
// Nodes — grouped by their full label set + key property, batched into UNWIND lists.
// ----------------------------------------------------------------------------------------------

function nodeStatements(nodes: NodeRow[]): string[] {
  const groups = new Map<string, NodeRow[]>();
  for (const n of nodes) {
    const k = `${n.labels.join(":")}|${n.keyProp}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(n);
  }

  const blocks: string[] = [];
  for (const group of groups.values()) {
    const { labels, keyProp } = group[0];
    const mergeLabel = labels[0];
    const extra = labels.slice(1);
    const setLabels = extra.length ? `, n:${extra.join(":")}` : "";
    for (const batch of chunk(group, BATCH)) {
      const list = batch
        .map((n) => `  {k: ${cypherValue(n.value)}, p: ${cypherMap(n.props)}}`)
        .join(",\n");
      blocks.push(
        `UNWIND [\n${list}\n] AS row\n` +
          `MERGE (n:${mergeLabel} {${keyProp}: row.k})\n` +
          `SET n += row.p${setLabels};`,
      );
    }
  }
  return blocks;
}

// ----------------------------------------------------------------------------------------------
// Edges — grouped by (type, endpoint labels + key props), batched.
// ----------------------------------------------------------------------------------------------

function edgeStatements(edges: EdgeRow[]): string[] {
  const groups = new Map<string, EdgeRow[]>();
  for (const e of edges) {
    const k = `${e.type}|${e.from.label}.${e.from.keyProp}|${e.to.label}.${e.to.keyProp}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  }

  const blocks: string[] = [];
  for (const group of groups.values()) {
    const { type, from, to } = group[0];
    for (const batch of chunk(group, BATCH)) {
      const list = batch
        .map((e) => `  {f: ${cypherValue(e.from.value)}, t: ${cypherValue(e.to.value)}, p: ${cypherMap(e.props)}}`)
        .join(",\n");
      blocks.push(
        `UNWIND [\n${list}\n] AS row\n` +
          `MATCH (a:${from.label} {${from.keyProp}: row.f})\n` +
          `MATCH (b:${to.label} {${to.keyProp}: row.t})\n` +
          `MERGE (a)-[r:${type}]->(b)\n` +
          `SET r += row.p;`,
      );
    }
  }
  return blocks;
}

// Re-exported for the bolt writer (which batches the same rows but binds them as params).
export type { Props };

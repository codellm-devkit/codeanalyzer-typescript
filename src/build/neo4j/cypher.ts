/**
 * The snapshot writer: render `GraphRows` to a self-contained `.cypher` script. Running it
 * (e.g. `cypher-shell < graph.cypher`) rebuilds this project's subgraph from scratch — constraints,
 * a scoped wipe of the prior version, then batched `UNWIND … MERGE` for nodes and edges.
 *
 * This artifact is intentionally NOT incremental: a static script has no view of the live DB, so
 * it expresses the full truth. Incremental updates are the bolt writer's job.
 */

import * as fs from "node:fs";
import type { EdgeRow, GraphRows, NodeRow, Props } from "./rows";
import { cypherMap, cypherValue } from "./rows";
import { CONSTRAINTS, INDEXES } from "./schema";

const BATCH = 500;

export function renderCypher(rows: GraphRows, appId: string): string {
  return [...cypherBlocks(rows, appId)].join("\n");
}

export function writeCypherFile(filePath: string, rows: GraphRows, appId: string): void {
  const file = fs.openSync(filePath, "w");
  try {
    let first = true;
    for (const block of cypherBlocks(rows, appId)) {
      fs.writeFileSync(file, first ? block : `\n${block}`);
      first = false;
    }
  } finally {
    fs.closeSync(file);
  }
}

function* cypherBlocks(rows: GraphRows, appId: string): Generator<string> {
  yield "// ── constraints & indexes ──";
  for (const stmt of CONSTRAINTS) yield `${stmt};`;
  for (const stmt of INDEXES) yield `${stmt};`;

  yield "";
  yield "// ── wipe this project's prior subgraph (external targets are shared) ──";
  yield wipe(appId);

  yield "";
  yield "// ── nodes ──";
  yield* nodeStatements(rows.nodes);

  yield "";
  yield "// ── relationships ──";
  yield* edgeStatements(rows.edges);
  yield "";
}

function wipe(appId: string): string {
  const id = cypherValue(appId);
  return [
    `MATCH (a:Application {id: ${id}})`,
    "OPTIONAL MATCH (a)-[:TS_HAS_MODULE]->(m:TSModule)",
    "OPTIONAL MATCH (m)-[:TS_DECLARES|TS_HAS_METHOD|TS_HAS_FIELD|TS_HAS_BODY_NODE*1..]->(x)",
    "DETACH DELETE x, m, a;",
  ].join("\n");
}

// ----------------------------------------------------------------------------------------------
// Nodes — grouped by their full label set + key property, batched into UNWIND lists.
// ----------------------------------------------------------------------------------------------

function* nodeStatements(nodes: NodeRow[]): Generator<string> {
  const groups = new Map<string, NodeRow[]>();
  for (const n of nodes) {
    const k = `${n.labels.join(":")}|${n.keyProp}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(n);
  }

  for (const group of groups.values()) {
    const { labels, keyProp } = group[0];
    const mergeLabel = labels[0];
    const extra = labels.slice(1);
    const setLabels = extra.length ? `, n:${extra.join(":")}` : "";
    for (const batch of batches(group, BATCH)) {
      const list = batch
        .map((n) => `  {k: ${cypherValue(n.value)}, p: ${cypherMap(n.props)}}`)
        .join(",\n");
      yield (
        `UNWIND [\n${list}\n] AS row\n` +
        `MERGE (n:${mergeLabel} {${keyProp}: row.k})\n` +
        `SET n += row.p${setLabels};`
      );
    }
  }
}

// ----------------------------------------------------------------------------------------------
// Edges — grouped by (type, endpoint labels + key props), batched.
// ----------------------------------------------------------------------------------------------

function* edgeStatements(edges: EdgeRow[]): Generator<string> {
  const groups = new Map<string, EdgeRow[]>();
  for (const e of edges) {
    const k = `${e.type}|${e.from.label}.${e.from.keyProp}|${e.to.label}.${e.to.keyProp}|${e.key !== undefined}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  }

  for (const group of groups.values()) {
    const { type, from, to } = group[0];
    // Discriminated relationships MERGE on `{_k}` — see EdgeRow.key (issue #70).
    const keyed = group[0].key !== undefined;
    for (const batch of batches(group, BATCH)) {
      const list = batch
        .map((e) => `  {f: ${cypherValue(e.from.value)}, t: ${cypherValue(e.to.value)}, ${keyed ? `k: ${cypherValue(e.key!)}, ` : ""}p: ${cypherMap(e.props)}}`)
        .join(",\n");
      yield (
        `UNWIND [\n${list}\n] AS row\n` +
        `MATCH (a:${from.label} {${from.keyProp}: row.f})\n` +
        `MATCH (b:${to.label} {${to.keyProp}: row.t})\n` +
        `MERGE (a)-[r:${type}${keyed ? " {_k: row.k}" : ""}]->(b)\n` +
        `SET r += row.p;`
      );
    }
  }
}

function* batches<T>(items: T[], size: number): Generator<T[]> {
  for (let offset = 0; offset < items.length; offset += size) {
    yield items.slice(offset, offset + size);
  }
}

// Re-exported for the bolt writer (which batches the same rows but binds them as params).
export type { Props };

/**
 * The incremental writer: push `GraphRows` into a live Neo4j over Bolt. Unlike the snapshot
 * writer, this one reads the DB's current state and updates only what changed.
 *
 * Algorithm (the module subgraph is the unit of idempotent replacement):
 *  1. ensure constraints + indexes.
 *  2. diff each module's `content_hash` against the DB → the set of changed modules.
 *  3. per changed module, in a transaction: delete the edges it owned (edges out of its nodes),
 *     detach-delete the declarations it no longer emits, then upsert its current nodes.
 *  4. upsert edges owned by changed modules (+ the shared edges).
 *  5. on a FULL run only, prune modules whose source file vanished.
 *
 * Nodes are MERGE-upserted, never blindly deleted, so a declaration another (unchanged) module
 * still references survives and its incoming edges stay valid. `:External`/`:Package`/`:Decorator`
 * are shared (no `_module`) and are MERGE-only.
 *
 * `neo4j-driver` is imported dynamically so it stays off the hot path and out of the default
 * (json) output entirely.
 */

import type { Logger } from "../../utils";
import type { EdgeRow, GraphRows, NodeRow, Prop } from "./rows";
import { chunk } from "./rows";
import { CONSTRAINTS, INDEXES } from "./schema";

export interface BoltConfig {
  uri: string;
  user: string;
  password: string;
  database: string | null;
}

const DESCENDANTS = "[:DECLARES|HAS_METHOD|HAS_ATTRIBUTE|DECLARES_VAR|HAS_CALLSITE*1..]";
const BATCH = 1000;

export async function boltWriter(
  rows: GraphRows,
  cfg: BoltConfig,
  log: Logger,
  fullRun: boolean,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const neo4j: any = (await import("neo4j-driver")).default;
  const driver = neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password));
  const sessionOpts = cfg.database ? { database: cfg.database } : {};
  const session = () => driver.session(sessionOpts);

  try {
    // 1. schema (DDL runs in its own autocommit transactions).
    await withSession(session, async (s) => {
      for (const stmt of [...CONSTRAINTS, ...INDEXES]) await s.run(stmt);
    });

    // Partition nodes by owning module; shared nodes have no _module.
    const byModule = new Map<string, NodeRow[]>();
    const shared: NodeRow[] = [];
    const moduleOf = new Map<string, string>(); // node value → owning module
    for (const n of rows.nodes) {
      const m = n.props._module;
      if (typeof m === "string") {
        bucket(byModule, m).push(n);
        moduleOf.set(n.value, m);
      } else {
        shared.push(n);
      }
    }

    // 2. diff content_hash.
    const dbHash = new Map<string, string | null>();
    await withSession(session, async (s) => {
      const res = await s.run("MATCH (m:Module) RETURN m.file_key AS k, m.content_hash AS h");
      for (const rec of res.records) dbHash.set(rec.get("k"), rec.get("h"));
    });
    const changed = new Set<string>();
    for (const [m, nodes] of byModule) {
      const rowHash = hashOf(nodes, m);
      if (!dbHash.has(m) || rowHash === undefined || rowHash !== dbHash.get(m)) changed.add(m);
    }
    log.info(
      `neo4j(bolt): ${byModule.size} modules (${changed.size} changed), ${shared.length} shared nodes, ` +
        `${rows.edges.length} edges`,
    );

    // 3. shared nodes are always upserted (MERGE-only).
    await upsertNodes(session, neo4j, shared);

    // 4. per changed module: purge owned edges + vanished decls, then upsert its nodes.
    for (const m of changed) {
      const nodes = byModule.get(m)!;
      const keys = nodes.map((n) => n.value);
      await withSession(session, async (s) => {
        await s.executeWrite(async (tx: any) => {
          await tx.run(`MATCH (x {_module: $m})-[r]->() DELETE r`, { m });
          await tx.run(
            `MATCH (x {_module: $m}) WHERE NOT coalesce(x.signature, x.id, x.file_key) IN $keys DETACH DELETE x`,
            { m, keys },
          );
        });
      });
      await upsertNodes(session, neo4j, nodes);
    }

    // 5. upsert edges owned by a changed module (owner = source node's module) or shared.
    const edges = rows.edges.filter((e) => {
      const owner = moduleOf.get(e.from.value);
      return owner === undefined || changed.has(owner);
    });
    await upsertEdges(session, neo4j, edges);

    // 6. orphan prune — only safe on a full run (a targeted run can't tell deleted from untargeted).
    if (fullRun) {
      const present = [...byModule.keys()];
      await withSession(session, async (s) => {
        const res = await s.run(
          `MATCH (m:Module) WHERE NOT m.file_key IN $present ` +
            `OPTIONAL MATCH (m)-${DESCENDANTS}->(x) DETACH DELETE x, m RETURN count(m) AS pruned`,
          { present },
        );
        const pruned = res.records[0]?.get("pruned") ?? 0;
        log.info(`neo4j(bolt): pruned ${pruned} vanished module(s)`);
      });
    } else {
      log.info("neo4j(bolt): targeted run — orphan pruning skipped (deleted files not removed)");
    }
  } finally {
    await driver.close();
  }
}

// ----------------------------------------------------------------------------------------------
// Batched upserts
// ----------------------------------------------------------------------------------------------

async function upsertNodes(session: () => any, neo4j: any, nodes: NodeRow[]): Promise<void> {
  const groups = new Map<string, NodeRow[]>();
  for (const n of nodes) bucket(groups, `${n.labels.join(":")}|${n.keyProp}`).push(n);

  for (const group of groups.values()) {
    const { labels, keyProp } = group[0];
    const setLabels = labels.length > 1 ? `, n:${labels.slice(1).join(":")}` : "";
    const cypher =
      `UNWIND $rows AS row MERGE (n:${labels[0]} {${keyProp}: row.k}) SET n += row.p${setLabels}`;
    for (const batch of chunk(group, BATCH)) {
      const payload = batch.map((n) => ({ k: n.value, p: toParams(n.props, neo4j) }));
      await withSession(session, (s) => s.run(cypher, { rows: payload }));
    }
  }
}

async function upsertEdges(session: () => any, neo4j: any, edges: EdgeRow[]): Promise<void> {
  const groups = new Map<string, EdgeRow[]>();
  for (const e of edges) {
    bucket(groups, `${e.type}|${e.from.label}.${e.from.keyProp}|${e.to.label}.${e.to.keyProp}`).push(e);
  }

  for (const group of groups.values()) {
    const { type, from, to } = group[0];
    const cypher =
      `UNWIND $rows AS row ` +
      `MATCH (a:${from.label} {${from.keyProp}: row.f}) ` +
      `MATCH (b:${to.label} {${to.keyProp}: row.t}) ` +
      `MERGE (a)-[r:${type}]->(b) SET r += row.p`;
    for (const batch of chunk(group, BATCH)) {
      const payload = batch.map((e) => ({ f: e.from.value, t: e.to.value, p: toParams(e.props, neo4j) }));
      await withSession(session, (s) => s.run(cypher, { rows: payload }));
    }
  }
}

// ----------------------------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------------------------

async function withSession<T>(session: () => any, fn: (s: any) => Promise<T>): Promise<T> {
  const s = session();
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

function bucket<K, V>(map: Map<K, V[]>, key: K): V[] {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  return arr;
}

function hashOf(nodes: NodeRow[], fileKey: string): string | undefined {
  const mod = nodes.find((n) => n.labels[0] === "Module" && n.value === fileKey);
  const h = mod?.props.content_hash;
  return typeof h === "string" ? h : undefined;
}

/**
 * Map props to driver params, converting integer-valued numbers to Neo4j integers so the bolt and
 * snapshot writers agree on type (the JS driver otherwise stores every number as a float).
 */
function toParams(props: Record<string, Prop>, neo4j: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "number") out[k] = Number.isInteger(v) ? neo4j.int(v) : v;
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "number" && Number.isInteger(x) ? neo4j.int(x) : x));
    else out[k] = v;
  }
  return out;
}

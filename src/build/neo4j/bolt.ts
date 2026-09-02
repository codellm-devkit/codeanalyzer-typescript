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
 * still references survives and its incoming edges stay valid. `:TSExternal` nodes are shared (no
 * `_module`) and are MERGE-only.
 *
 * `neo4j-driver` is imported dynamically so it stays off the hot path and out of the default
 * (json) output entirely.
 */

import type { ManagedTransaction } from "neo4j-driver";
import type { Logger } from "../../utils";
import type { EdgeRow, GraphRows, NodeRow, Prop } from "./rows";
import { chunk } from "./rows";
import { CONSTRAINTS, INDEXES, SCHEMA_VERSION } from "./schema";

export interface BoltConfig {
  uri: string;
  user: string;
  password: string;
  database: string | null;
}

const DESCENDANTS = "[:TS_DECLARES|TS_HAS_METHOD|TS_HAS_FIELD|TS_HAS_BODY_NODE*1..]";
const BATCH = 1000;

/** #68: a DB written by a different schema version must be fully re-upserted, not hash-diffed —
 * otherwise unchanged modules keep the old label vocabulary while :Application advertises the new. */
export function shouldForceFullUpsert(dbVersion: string | null, producerVersion: string): boolean {
  return dbVersion !== producerVersion;
}

/**
 * #46/#68 migration: wipe the pre-2.0.0 (schema 1.x) residue when the version gate forces a full
 * upsert. Pushing 2.0.0 onto a 1.1.0 DB otherwise orphans the whole 1.x subgraph AND poisons v2
 * queries — 1.x nodes carry twin TS labels (`:Module:TSModule`, `:Symbol:TSCallable`) so they match
 * v2 patterns, and a second `:Application` (keyed on name, no `id`) makes the version read
 * nondeterministic. These run ONCE, before the per-module loop; they are ordered, idempotent, and
 * no-op on a fresh DB.
 *
 * They are intentionally UNANCHORED (no `:CanNode` guard on the MATCH) — that is the whole point:
 * they must match the *legacy* nodes, which never carry `:CanNode`. Every v2 project-owned node DOES
 * carry `:CanNode`, so the `AND NOT n:CanNode` predicate spares everything current. RETURN count so
 * the caller can log what each statement removed.
 */
export const LEGACY_WIPE_STATEMENTS: readonly string[] = [
  // 1.x project-owned nodes carried `_module` under twin labels (:Module:TSModule, …) but not :CanNode.
  "MATCH (n) WHERE n._module IS NOT NULL AND NOT n:CanNode DETACH DELETE n RETURN count(n) AS wiped",
  // 1.x shared nodes (externals / packages / decorators) had no `_module`; keyed on name, not id.
  "MATCH (n) WHERE (n:External OR n:Package OR n:Decorator) AND NOT n:CanNode DETACH DELETE n RETURN count(n) AS wiped",
  // The 1.x :Application node was keyed on `name`, so it has no `id`.
  "MATCH (a:Application) WHERE a.id IS NULL DETACH DELETE a RETURN count(a) AS wiped",
];

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

    // 2. read schema version and decide if we need to force a full upsert. Scope the read to THIS
    // app's :Application (by id) — an unscoped `MATCH (a:Application)` could read a foreign analyzer's
    // node in a shared database and misjudge the version. Absent id → null → forces (safe default).
    const appId = rows.nodes.find((n) => n.labels[0] === "Application")?.value ?? null;
    let dbSchemaVersion: string | null = null;
    if (appId !== null) {
      await withSession(session, async (s) => {
        const res = await s.run(
          "MATCH (a:Application {id: $appId}) RETURN a.schema_version AS v LIMIT 1",
          { appId },
        );
        dbSchemaVersion = res.records[0]?.get("v") ?? null;
      });
    }
    const forceAll = shouldForceFullUpsert(dbSchemaVersion, SCHEMA_VERSION);
    if (forceAll) {
      log.info(
        `neo4j(bolt): schema ${dbSchemaVersion ?? "(none)"} → ${SCHEMA_VERSION}, full upsert forced`,
      );
      // Detect-and-wipe the pre-2.0.0 subgraph in one step, BEFORE any new write, so stale twin-label
      // nodes can't survive to poison v2 queries or the content-hash diff. Idempotent on fresh DBs.
      const counts: number[] = [];
      await withSession(session, async (s) => {
        for (const stmt of LEGACY_WIPE_STATEMENTS) {
          const res = await s.run(stmt);
          const c = res.records[0]?.get("wiped");
          counts.push(typeof c?.toNumber === "function" ? c.toNumber() : Number(c ?? 0));
        }
      });
      const wiped = counts.reduce((a, b) => a + b, 0);
      if (wiped > 0) {
        log.info(
          `neo4j(bolt): wiped ${wiped} legacy (pre-2.0.0) nodes ` +
            `(module=${counts[0]}, shared=${counts[1]}, app=${counts[2]})`,
        );
      }
    }
    // Full runs reconcile the current application's artifact ownership. Artifact and ConfigKey
    // ids are neutral across sibling analyzers, so remove only this app's stale ownership edges
    // first and delete the shared subtree only when no Application still owns the artifact.
    if (fullRun && appId !== null) {
      const artifactIds = rows.nodes
        .filter((n) => n.labels.includes("Artifact"))
        .map((n) => n.value);
      await withSession(session, async (s) => {
        await s.executeWrite(async (tx: ManagedTransaction) => {
          await tx.run(
            `MATCH (a:Application {id: $appId})-[r:HAS_ARTIFACT]->(artifact:Artifact) ` +
              `WHERE NOT artifact.id IN $artifactIds DELETE r`,
            { appId, artifactIds },
          );
          await tx.run(
            `MATCH (artifact:Artifact) WHERE NOT ()-[:HAS_ARTIFACT]->(artifact) ` +
              `OPTIONAL MATCH (artifact)-[:DEFINES_CONFIG]->(config:ConfigKey) ` +
              `DETACH DELETE config, artifact`,
          );
        });
      });
    }

    // 3. diff content_hash.
    const dbHash = new Map<string, string | null>();
    await withSession(session, async (s) => {
      const res = await s.run("MATCH (m:TSModule) RETURN m._module AS k, m.content_hash AS h");
      for (const rec of res.records) dbHash.set(rec.get("k"), rec.get("h"));
    });
    const changed = new Set<string>();
    for (const [m, nodes] of byModule) {
      const rowHash = hashOf(nodes, m);
      if (forceAll || !dbHash.has(m) || rowHash === undefined || rowHash !== dbHash.get(m)) changed.add(m);
    }
    log.info(
      `neo4j(bolt): ${byModule.size} modules (${changed.size} changed), ${shared.length} shared nodes, ` +
        `${rows.edges.length} edges`,
    );

    // 4. shared nodes are always upserted (MERGE-only).
    await upsertNodes(session, neo4j, shared);

    // 5. per changed module: purge owned edges + vanished decls, then upsert its nodes.
    for (const m of changed) {
      const nodes = byModule.get(m)!;
      const keys = nodes.map((n) => n.value);
      await withSession(session, async (s) => {
        await s.executeWrite(async (tx: any) => {
          // Anchor on :CanNode so these seek the module's index slice instead of scanning the whole
          // store (and never touch non-CanNode nodes). The `x.id IS NULL` guard defends the sweep
          // against a null key — three-valued logic would otherwise drop the row from `NOT x.id IN`.
          await tx.run(`MATCH (x:CanNode {_module: $m})-[r]->() DELETE r`, { m });
          await tx.run(
            `MATCH (x:CanNode {_module: $m}) WHERE x.id IS NULL OR NOT x.id IN $keys DETACH DELETE x`,
            { m, keys },
          );
        });
      });
      await upsertNodes(session, neo4j, nodes);
    }

    // 6. upsert edges owned by a changed module (owner = source node's module) or shared.
    const edges = rows.edges.filter((e) => {
      const owner = moduleOf.get(e.from.value);
      return owner === undefined || changed.has(owner);
    });
    await upsertEdges(session, neo4j, edges);

    // 7. orphan prune — only safe on a full run (a targeted run can't tell deleted from untargeted).
    if (fullRun) {
      const present = [...byModule.keys()];
      await withSession(session, async (s) => {
        const res = await s.run(
          `MATCH (m:TSModule) WHERE NOT m._module IN $present ` +
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
    bucket(groups, `${e.type}|${e.from.label}.${e.from.keyProp}|${e.to.label}.${e.to.keyProp}|${e.key !== undefined}`).push(e);
  }

  for (const group of groups.values()) {
    const { type, from, to } = group[0];
    // Discriminated relationships MERGE on `{_k}` so several distinct edges of one type coexist
    // between the same endpoint pair (per-var DDG, the true/false CFG_NEXT pair). See EdgeRow.key.
    const relKey = group[0].key !== undefined ? " {_k: row.k}" : "";
    const cypher =
      `UNWIND $rows AS row ` +
      `MATCH (a:${from.label} {${from.keyProp}: row.f}) ` +
      `MATCH (b:${to.label} {${to.keyProp}: row.t}) ` +
      `MERGE (a)-[r:${type}${relKey}]->(b) SET r += row.p`;
    for (const batch of chunk(group, BATCH)) {
      const payload = batch.map((e) => ({ f: e.from.value, t: e.to.value, k: e.key ?? null, p: toParams(e.props, neo4j) }));
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

function hashOf(nodes: NodeRow[], _fileKey: string): string | undefined {
  // Every node in `nodes` shares the same _module; the Module row (labels include "TSModule") carries the hash.
  const mod = nodes.find((n) => n.labels.includes("TSModule"));
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

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

import type { Logger } from "../../utils";
import type { EdgeRow, GraphRows, NodeRow, Prop } from "./rows";
import { JS_MARKER, TS_MARKER, applicationPrefixes, chunk, descendantPrefix, markerFor } from "./rows";
import { CONSTRAINTS, INDEXES, SCHEMA_VERSION } from "./schema";

export interface BoltConfig {
  uri: string;
  user: string;
  password: string;
  database: string | null;
}

const BATCH = 1000;

/** #68: a DB written by a different schema version must be fully re-upserted, not hash-diffed —
 * otherwise unchanged modules keep the old label vocabulary while :Application advertises the new. */
export function shouldForceFullUpsert(dbVersion: string | null, producerVersion: string): boolean {
  return dbVersion !== producerVersion;
}

/**
 * `--eager` purge (#116): delete THIS APPLICATION's own nodes, then repopulate from scratch.
 *
 * Scoped two ways at once, and both matter. `id STARTS WITH <app id>` keeps it to this
 * application, so a second app in the same database survives. `:CanNode` keeps it to nodes this
 * analyzer wrote, so a sibling analyzer's graph survives — codeanalyzer-python and
 * codeanalyzer-java both tag nodes with `_module` and neither applies `:CanNode`, so a predicate
 * like "has _module but no :CanNode" is an exact description of THEIR nodes, not of stale ours.
 * That is what the pre-2.0.0 wipe this replaces got wrong: it deleted foreign graphs.
 *
 * Batched, because deleting a whole application in one transaction exhausts
 * `dbms.memory.transaction.total.max` on a modestly-sized server (#116, measured at 2.7 GiB).
 */
/**
 * `--eager` purge (#140): everything under this application's prefix, per language namespace,
 * anchored on that namespace's marker so the prefix predicate seeks an index. `$prefix` is the
 * `/`-terminated descendant prefix from `applicationPrefixes`, never a bare app id — a bare id also
 * matches `can://typescript/appXtra/...`.
 */
export const EAGER_PURGE = eagerPurge(TS_MARKER);
export const EAGER_PURGE_JS = eagerPurge(JS_MARKER);
function eagerPurge(marker: string): string {
  return `MATCH (n:${marker}) WHERE n.id STARTS WITH $prefix CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 5000 ROWS`;
}
/** The per-module purge (#140): the module by equality, its subtree by `/`-prefix; `$keys` survive. */
function purgeModuleEdges(marker: string): string {
  return `MATCH (x:${marker}) WHERE x.id = $mid OR x.id STARTS WITH $pre MATCH (x)-[r]->() DELETE r`;
}
function purgeModuleStale(marker: string): string {
  return `MATCH (x:${marker}) WHERE (x.id = $mid OR x.id STARTS WITH $pre) AND NOT x.id IN $keys DETACH DELETE x`;
}
/** The orphan prune (#140): modules inside this app's prefix that the run no longer emits, with their subtrees. */
function pruneVanished(marker: string): string {
  return (
    `MATCH (m:TSModule:${marker}) WHERE m.id STARTS WITH $prefix AND NOT m.id IN $present ` +
    `CALL { WITH m MATCH (x:${marker}) WHERE x.id = m.id OR x.id STARTS WITH m.id + '/' DETACH DELETE x } ` +
    `IN TRANSACTIONS OF 1000 ROWS RETURN count(DISTINCT m) AS pruned`
  );
}
/** The TSModule row of one module's group carries the module's `can://` id and its content_hash. */
function moduleRow(nodes: NodeRow[]): NodeRow | undefined {
  return nodes.find((n) => n.labels.includes("TSModule"));
}

export async function boltWriter(
  rows: GraphRows,
  cfg: BoltConfig,
  log: Logger,
  fullRun: boolean,
  eager: boolean,
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
      const m = n.module;
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
    // Every scoped statement below — the diff, the purges, the prune — needs the application's
    // prefixes, and applicationPrefixes refuses an empty one (#140). project() always emits the
    // Application row, so this only trips on a hand-built GraphRows.
    const prefixes = applicationPrefixes(appId);
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
    // Version mismatch no longer deletes anything: a schema change forces a full re-UPSERT, and
    // MERGE overwrites in place. Removing nodes is `--eager`'s job alone (#116).
    const forceAll = shouldForceFullUpsert(dbSchemaVersion, SCHEMA_VERSION);
    if (forceAll) {
      log.info(
        `neo4j(bolt): schema ${dbSchemaVersion ?? "(none)"} → ${SCHEMA_VERSION}, full upsert forced`,
      );
    }

    // --eager: drop this application's own nodes and rebuild. Without it the push only ever adds
    // and updates -- managing the database's lifetime is the operator's call, not the analyzer's.
    if (eager) {
      await withSession(session, async (s) => {
        await s.run(EAGER_PURGE, { prefix: prefixes.ts });
        await s.run(EAGER_PURGE_JS, { prefix: prefixes.js });
      });
      log.info(`neo4j(bolt): --eager, purged the existing graph under ${prefixes.ts} and ${prefixes.js}`);
    }

    // 3. diff content_hash.
    const dbHash = new Map<string, string | null>();
    await withSession(session, async (s) => {
      // Keyed by module ID inside this application's prefixes (#140): a file key alone collides
      // across applications; the id carries language, application and file.
      const res = await s.run(
        "MATCH (m:TSModule) WHERE m.id STARTS WITH $ts OR m.id STARTS WITH $js RETURN m.id AS k, m.content_hash AS h",
        { ts: prefixes.ts, js: prefixes.js },
      );
      for (const rec of res.records) dbHash.set(rec.get("k"), rec.get("h"));
    });
    const moduleIdOf = new Map<string, string>(); // file key → the module's can:// id
    const changed = new Set<string>();
    for (const [m, nodes] of byModule) {
      const mid = moduleRow(nodes)?.value;
      if (!mid || !(mid.startsWith(prefixes.ts) || mid.startsWith(prefixes.js))) {
        throw new Error(`neo4j: module ${m} has no can:// id under ${prefixes.ts} / ${prefixes.js}; refusing to scope a purge on it`);
      }
      moduleIdOf.set(m, mid);
      const rowHash = hashOf(nodes, m);
      if (forceAll || !dbHash.has(mid) || rowHash === undefined || rowHash !== dbHash.get(mid)) changed.add(m);
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
      // Only --eager removes a module's vanished declarations. A default push MERGEs current
      // nodes over the old ones and leaves anything no longer emitted in place: deleting is the
      // operator's call (#116). Anchored on :CanNode either way, so a sibling analyzer's nodes
      // sharing this `_module` key are never in scope.
      if (eager) {
        // The module by equality, its subtree by `/`-prefix, anchored on the module's own
        // language marker (#140). Application-scoped by construction: the id carries the app.
        const mid = moduleIdOf.get(m)!;
        const marker = markerFor(mid)!;
        const params = { mid, pre: descendantPrefix(mid), keys };
        await withSession(session, async (s) => {
          await s.executeWrite(async (tx: any) => {
            await tx.run(purgeModuleEdges(marker), params);
            await tx.run(purgeModuleStale(marker), params);
          });
        });
      }
      await upsertNodes(session, neo4j, nodes);
    }

    // 6. upsert edges owned by a changed module (owner = source node's module) or shared.
    const edges = rows.edges.filter((e) => {
      const owner = moduleOf.get(e.from.value);
      return owner === undefined || changed.has(owner);
    });
    await upsertEdges(session, neo4j, edges);

    // 7. orphan prune — only safe on a full run (a targeted run can't tell deleted from untargeted).
    // appId === null would make `STARTS WITH ""` match every node in the store.
    if (fullRun && eager) {
      // Scoped on this app's prefixes and the module's own marker (#140); a second TypeScript app
      // in the same database, whose modules are all "not in $present", is outside the prefix.
      const present = [...moduleIdOf.values()];
      let pruned = 0;
      await withSession(session, async (s) => {
        for (const [marker, prefix] of [[TS_MARKER, prefixes.ts], [JS_MARKER, prefixes.js]] as const) {
          const res = await s.run(pruneVanished(marker), { present, prefix });
          pruned += Number(res.records[0]?.get("pruned") ?? 0);
        }
      });
      log.info(`neo4j(bolt): pruned ${pruned} vanished module(s)`);
    } else {
      log.info("neo4j(bolt): orphan pruning skipped (use --eager to remove vanished modules)");
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
  // Every node in `nodes` shares one owning module; its TSModule row carries the hash.
  const mod = moduleRow(nodes);
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

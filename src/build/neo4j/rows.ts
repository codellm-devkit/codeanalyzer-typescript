/**
 * The output-agnostic intermediate between `project()` and the two writers (cypher snapshot /
 * bolt incremental). Pure data — no I/O, no driver. A `GraphRows` is a deterministic, deduped
 * bag of nodes and edges that both writers consume identically.
 *
 * Property values are restricted to Neo4j-legal shapes: primitives and homogeneous arrays of
 * primitives. `null`/`undefined` are pruned (in Neo4j a null property is simply absence).
 */

export type Scalar = string | number | boolean;
export type Prop = Scalar | string[] | number[] | boolean[];
export type Props = Record<string, Prop>;

/** The shared MERGE label for every `can://`-id-keyed node (mirrors `project.ts`'s `CAN` constant). */
const CAN_NODE = "CanNode";

/** How an edge addresses one of its endpoints: the label + key property to MATCH on, and value. */
export interface NodeRef {
  label: string; // the label carrying the uniqueness constraint ("CanNode", "Application", ...)
  // Usually "id" — every can://-keyed node. Shared, non-can:// nodes key on their own natural
  // identity instead (:Package/:ConfigKey on "id", :TSDecorator on "name").
  keyProp: string;
  value: string;
}

export interface NodeRow {
  labels: string[]; // labels[0] is the constrained MERGE label; the rest are SET as extra labels
  keyProp: string;
  value: string;
  props: Props;
  /**
   * The owning module's file key, for the incremental writer's per-module diff. IN MEMORY ONLY
   * (#140): it used to be emitted as `_module` and every destructive statement matched on it, which
   * is application-blind — two apps sharing a file key deleted each other's nodes. Scope now comes
   * from the `can://` id prefix; this field only groups rows.
   */
  module?: string;
}

/**
 * The marker labels (#140): one per language namespace this analyzer emits, on every node keyed by
 * a `can://<lang>/` id. They are INDEX ANCHORS, nothing more — Neo4j property indexes are
 * label-scoped, so `id STARTS WITH $p` needs a label to seek on. Safety comes from the prefix, which
 * carries language, application and module.
 */
export const TS_CAN_PREFIX = "can://typescript/";
export const JS_CAN_PREFIX = "can://javascript/";
export const TS_MARKER = "TSCanNode";
export const JS_MARKER = "JSCanNode";

/** The marker for a `can://` id, or null for ids outside both language namespaces (artifacts, packages). */
export function markerFor(id: string): string | null {
  if (id.startsWith(TS_CAN_PREFIX)) return TS_MARKER;
  if (id.startsWith(JS_CAN_PREFIX)) return JS_MARKER;
  return null;
}

/**
 * The prefix that matches a node's descendants and nothing else. The separator is the point:
 * `can://typescript/app/src/foo.ts` is also a prefix of `can://typescript/app/src/foo.tsx`, so
 * descendants match on `id + '/'` and the node itself by equality.
 */
export function descendantPrefix(canId: string): string {
  return `${canId}/`;
}

/**
 * The scope of every destructive statement: this application's two namespaces,
 * `can://typescript/<app>/` and `can://javascript/<app>/`. Refuses a missing or empty application:
 * `STARTS WITH ''` would match every node in the database.
 */
export function applicationPrefixes(appId: string | null | undefined): { ts: string; js: string } {
  const name = appId?.startsWith(TS_CAN_PREFIX) ? appId.slice(TS_CAN_PREFIX.length) : "";
  if (!name) throw new Error("neo4j: refusing a destructive statement without an application id");
  return { ts: descendantPrefix(`${TS_CAN_PREFIX}${name}`), js: descendantPrefix(`${JS_CAN_PREFIX}${name}`) };
}

export interface EdgeRow {
  type: string;
  from: NodeRef;
  to: NodeRef;
  props: Props;
  /**
   * Optional relationship discriminant: when set, the MERGE is on `{_k: key}` so several
   * legitimately-distinct edges of one type may coexist between the same endpoint pair (per-var
   * DDG edges, a conditional's true/false CFG_NEXT pair). Undefined keeps the plain
   * endpoint-pair MERGE. (issue #70)
   */
  key?: string;
}

export interface GraphRows {
  nodes: NodeRow[];
  edges: EdgeRow[];
}

/** Drop null/undefined entries — in Neo4j a null property means "absent", so we never store one. */
export function prune(p: Record<string, Prop | null | undefined>): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Accumulates nodes/edges with `MERGE` semantics in memory, so the same node touched many times
 * (a hot external symbol, a canonical decorator) collapses to one row, and cross-reference edges
 * to a target that never materialized are dropped (the "edge-only-when-resolved" rule).
 */
export class RowBuilder {
  private readonly nodes = new Map<string, NodeRow>(); // key: `${labels[0]}\0${value}`
  private readonly edges: EdgeRow[] = [];
  private readonly deferred: EdgeRow[] = []; // edges gated against node existence at finish()
  private readonly keys = new Set<string>(); // every node value seen, for resolved-gating

  /**
   * Upsert a node. Re-seeing the same (mergeLabel, value) merges props (last write wins) and
   * unions labels — the in-memory analog of `MERGE (n:Label {key}) SET n += props`. `labels[0]`
   * must be the merge label ("Application" | "CanNode").
   */
  node(labels: string[], keyProp: string, value: string, props: Props): NodeRef {
    const id = `${labels[0]}\0${value}`;
    // `_module` is lifted off the graph (#140): it groups rows for the incremental diff and is
    // never emitted. The marker label rides every `can://<lang>/` id, as an index anchor.
    const { _module, ...rest } = props as Props & { _module?: unknown };
    const module = typeof _module === "string" ? _module : undefined;
    const marker = keyProp === "id" ? markerFor(value) : null;
    const allLabels = marker && !labels.includes(marker) ? [...labels, marker] : [...labels];
    const existing = this.nodes.get(id);
    if (existing) {
      Object.assign(existing.props, rest);
      for (const l of allLabels) if (!existing.labels.includes(l)) existing.labels.push(l);
      if (module !== undefined) existing.module = module;
    } else {
      this.nodes.set(id, { labels: allLabels, keyProp, value, props: rest, ...(module !== undefined ? { module } : {}) });
    }
    this.keys.add(value);
    return { label: labels[0], keyProp, value };
  }

  /** An edge whose endpoints are known to exist (both ends emitted as nodes this run).
   * `key` sets the relationship discriminant (see EdgeRow.key). */
  edge(type: string, from: NodeRef, to: NodeRef, props: Props = {}, key?: string): void {
    this.edges.push({ type, from, to, props, key });
  }

  /**
   * An edge to a `can://`-id target (e.g. a resolved supertype) that might not have materialized
   * as a node this run. Deferred and kept only if the target id was actually emitted as a
   * `:CanNode` this run — so EXTENDS / IMPLEMENTS never dangle (the id is already resolved-only by
   * the time it reaches here; this is the defense-in-depth gate, not the primary resolution step).
   */
  edgeToSymbol(type: string, from: NodeRef, targetId: string, props: Props = {}, key?: string): void {
    this.deferred.push({
      type,
      from,
      to: { label: CAN_NODE, keyProp: "id", value: targetId },
      props,
      key,
    });
  }

  finish(): GraphRows {
    for (const e of this.deferred) if (this.keys.has(e.to.value)) this.edges.push(e);
    const nodes = [...this.nodes.values()].sort((a, b) =>
      `${a.labels[0]}\0${a.value}`.localeCompare(`${b.labels[0]}\0${b.value}`),
    );
    const edges = this.edges.sort((a, b) =>
      `${a.type}\0${a.from.value}\0${a.to.value}`.localeCompare(
        `${b.type}\0${b.from.value}\0${b.to.value}`,
      ),
    );
    return { nodes, edges };
  }
}

// ----------------------------------------------------------------------------------------------
// Cypher literal rendering (used by the snapshot writer; the bolt writer passes params instead).
// ----------------------------------------------------------------------------------------------

/** Render a property value as a Cypher literal. */
export function cypherValue(v: Prop): string {
  if (typeof v === "string") return cypherString(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  // homogeneous primitive array
  return `[${v.map((x) => cypherValue(x as Prop)).join(", ")}]`;
}

/** Render a props map as a Cypher map literal: `{key: value, ...}`. Keys are valid identifiers. */
export function cypherMap(props: Props): string {
  const entries = Object.entries(props).map(([k, v]) => `${k}: ${cypherValue(v)}`);
  return `{${entries.join(", ")}}`;
}

function cypherString(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `'${escaped}'`;
}

/** Split an array into chunks of at most `size` (UNWIND batch sizing). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

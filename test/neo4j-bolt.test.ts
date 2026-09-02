/**
 * Integration test for the Neo4j bolt writer. Spins up a real Neo4j via @testcontainers/neo4j,
 * projects the sample fixture to graph rows, pushes them, and asserts the graph in the database —
 * including the incremental behaviours (idempotent re-push, vanished-declaration cleanup, and
 * full-run orphan pruning).
 *
 * Requires a container runtime reachable by testcontainers (Docker, or Podman via DOCKER_HOST).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Neo4jContainer, type StartedNeo4jContainer } from "@testcontainers/neo4j";
import neo4j, { type Driver } from "neo4j-driver";
import { type BoltConfig, boltWriter, CONSTRAINTS, INDEXES, project, SCHEMA_VERSION } from "../src/build/neo4j";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import { finalizeAnalysis } from "../src/schema";
import { Logger } from "../src/utils";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/sample-app");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cants-neo4j-test-"));
const log = new Logger(0);

// This suite needs a container runtime (Docker / Podman), so it is OPT-IN: it is skipped by default
// (CI release gate, and contributors without a runtime) and runs only with RUN_CONTAINER_TESTS=1
// — e.g. `bun run test:container`. The no-container schema conformance test always runs.
const containerSuite = process.env.RUN_CONTAINER_TESTS ? describe : describe.skip;

function optsFor(overrides: Partial<AnalysisOptions> = {}): AnalysisOptions {
  return {
    input: FIXTURE,
    output: null,
    emit: "json",
    appName: null,
    neo4jUri: null,
    neo4jUser: "neo4j",
    neo4jPassword: "",
    neo4jDatabase: null,
    // >= 2: the call graph (incl. jelly) solve is skipped below that level since the v2 emitter
    // discards it at -a 1 (#46 sibling fix, 6078c7e) — this suite asserts on TS_CALLS edges.
    analysisLevel: 2,
    graphs: ["cfg", "dfg", "pdg", "sdg"],
    graphFieldDepth: 3,
    jobs: 1,
    targetFiles: null,
    skipTests: true,
    eager: true,
    noBuild: true,
    phantoms: true,
    cacheDir: path.join(TMP, "cache"),
    verbosity: 0,
    ...overrides,
  };
}

containerSuite("neo4j bolt writer", () => {
  let container: StartedNeo4jContainer;
  let driver: Driver;
  let cfg: BoltConfig;

  beforeAll(async () => {
    container = await new Neo4jContainer("neo4j:5").withPassword("testpassword123").start();
    cfg = {
      uri: container.getBoltUri(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: null,
    };
    driver = neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password));
  }, 240_000);

  afterAll(async () => {
    await driver?.close();
    await container?.stop();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  /** Run a single-aggregate Cypher query and return it as a number. */
  async function num(cypher: string, params: Record<string, unknown> = {}): Promise<number> {
    const session = driver.session();
    try {
      const res = await session.run(cypher, params);
      const v = res.records[0]?.get(0);
      return typeof v?.toNumber === "function" ? v.toNumber() : Number(v ?? 0);
    } finally {
      await session.close();
    }
  }

  test(
    "full push materializes the whole graph + schema",
    async () => {
      const opts = optsFor();
      const rows = project((await analyze(opts)).application);
      await boltWriter(rows, cfg, log, true);

      // Every projected node/edge lands (the fixture has no library deps, so endpoints all resolve).
      expect(await num("MATCH (n) RETURN count(n)")).toBe(rows.nodes.length);
      expect(await num("MATCH ()-[r]->() RETURN count(r)")).toBe(rows.edges.length);

      // Shared :CanNode label spans every project-owned node kind (schema v2's universal
      // merge label — Application is the only node kind that sits outside it).
      const canNode = await num("MATCH (s:CanNode) RETURN count(s)");
      const kinds = await num(
        "MATCH (s:CanNode) WHERE s:TSModule OR s:TSClass OR s:TSInterface OR s:TSEnum OR s:TSTypeAlias OR s:TSNamespace OR s:TSCallable OR s:TSField OR s:TSBodyNode OR s:TSExternal OR s:TSAnonymousCallable RETURN count(s)",
      );
      expect(canNode).toBeGreaterThan(0);
      expect(kinds).toBe(canNode);

      // Constraints + indexes were created up front. Expectations derive from the catalog (a
      // uniqueness constraint also spawns a backing index, so SHOW INDEXES only grows from here).
      expect(await num("SHOW CONSTRAINTS YIELD name RETURN count(*)")).toBeGreaterThanOrEqual(
        CONSTRAINTS.length,
      );
      expect(await num("SHOW INDEXES YIELD name RETURN count(*)")).toBeGreaterThanOrEqual(
        INDEXES.length,
      );

      // A known resolved call edge from the fixture (index.ts calls services.announce).
      expect(
        await num(
          "MATCH (:TSCallable)-[:TS_CALLS]->(t:TSCallable {name:$n}) RETURN count(*)",
          { n: "announce" },
        ),
      ).toBeGreaterThan(0);
    },
    120_000,
  );

  test(
    "re-pushing identical analysis is idempotent",
    async () => {
      const opts = optsFor();
      const rows = project((await analyze(opts)).application);
      await boltWriter(rows, cfg, log, true);
      expect(await num("MATCH (n) RETURN count(n)")).toBe(rows.nodes.length);
      expect(await num("MATCH ()-[r]->() RETURN count(r)")).toBe(rows.edges.length);
    },
    120_000,
  );

  test(
    "a full run prunes a module whose source vanished",
    async () => {
      const opts = optsFor();
      const result = await analyze(opts);
      const app = result.internal;
      const victim = Object.keys(app.symbol_table).sort()[0];
      delete app.symbol_table[victim];

      const rows = project(finalizeAnalysis(app, result.program_graphs ?? null, opts).application);
      await boltWriter(rows, cfg, log, true);

      // The victim's nodes are gone.
      expect(await num("MATCH (n {_module:$m}) RETURN count(n)", { m: victim })).toBe(0);

      // The surviving module-scoped graph matches the reduced projection. (Shared :TSExternal
      // nodes are MERGE-only and intentionally never pruned, so we compare only _module-tagged nodes.)
      const moduleScoped = rows.nodes.filter((n) => "_module" in n.props).length;
      expect(await num("MATCH (n) WHERE n._module IS NOT NULL RETURN count(n)")).toBe(moduleScoped);
    },
    120_000,
  );

  test(
    "a full run prunes an artifact no longer owned by the application",
    async () => {
      const rows = project((await analyze(optsFor())).application);
      const victim = rows.nodes.find((n) => n.labels.includes("Artifact"))?.value;
      expect(victim).toBeDefined();

      const reduced = {
        nodes: rows.nodes.filter((n) => n.value !== victim),
        edges: rows.edges.filter((e) => e.from.value !== victim && e.to.value !== victim),
      };
      await boltWriter(reduced, cfg, log, true);

      expect(
        await num(
          "MATCH (:Application)-[:HAS_ARTIFACT]->(a:Artifact {id:$id}) RETURN count(a)",
          { id: victim },
        ),
      ).toBe(0);
      expect(await num("MATCH (a:Artifact {id:$id}) RETURN count(a)", { id: victim })).toBe(0);
    },
    120_000,
  );

  test(
    "migrates a 1.1.0-shaped graph to the current schema, wiping legacy residue (#46)",
    async () => {
      // Seed a minimal schema-1.1.0 graph on a clean store: twin labels, the old
      // name/file_key/signature keys, and an :Application keyed on `name` (no `id`).
      const seed = driver.session();
      try {
        await seed.run("MATCH (n) DETACH DELETE n");
        await seed.run(
          "CREATE (:Application {name:'sample-app', schema_version:'1.1.0'}) " +
            "CREATE (:Module:TSModule {file_key:'x.ts', _module:'x.ts', content_hash:'stale'}) " +
            "CREATE (:Symbol:TSCallable {signature:'x', _module:'x.ts'})",
        );
      } finally {
        await seed.close();
      }

      // A full current-version push against the same DB must detect the mismatch and wipe the residue.
      const opts = optsFor();
      const rows = project((await analyze(opts)).application);
      await boltWriter(rows, cfg, log, true);

      // Exactly one :Application survives — the fresh v2 one (id set, version bumped). The 1.x app,
      // keyed on name with no id, was wiped, so the version read is no longer nondeterministic.
      expect(await num("MATCH (a:Application) RETURN count(a)")).toBe(1);
      expect(
        await num(
          `MATCH (a:Application) WHERE a.id IS NOT NULL AND a.schema_version = '${SCHEMA_VERSION}' RETURN count(a)`,
        ),
      ).toBe(1);

      // No legacy twin-label residue remains (would-be poison for v2 label queries).
      expect(
        await num("MATCH (n) WHERE n._module IS NOT NULL AND NOT n:CanNode RETURN count(n)"),
      ).toBe(0);

      // The stale 'x.ts' :TSModule seed did not survive as a duplicate — exactly the fixture's modules.
      const fixtureModules = rows.nodes.filter((n) => n.labels.includes("TSModule")).length;
      expect(await num("MATCH (m:TSModule) RETURN count(m)")).toBe(fixtureModules);
    },
    120_000,
  );
});

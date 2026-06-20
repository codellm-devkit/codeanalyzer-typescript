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
import { type BoltConfig, boltWriter, project } from "../src/build/neo4j";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
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
    analysisLevel: 1,
    targetFiles: null,
    skipTests: true,
    eager: true,
    noBuild: true,
    phantoms: true,
    callGraphProvider: "tsc",
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
      const rows = project(analyze(optsFor()), "sample-app");
      await boltWriter(rows, cfg, log, true);

      // Every projected node/edge lands (the fixture has no library deps, so endpoints all resolve).
      expect(await num("MATCH (n) RETURN count(n)")).toBe(rows.nodes.length);
      expect(await num("MATCH ()-[r]->() RETURN count(r)")).toBe(rows.edges.length);

      // Shared :TSSymbol label spans the signature-keyed declaration kinds.
      const symbol = await num("MATCH (s:TSSymbol) RETURN count(s)");
      const kinds = await num(
        "MATCH (s:TSSymbol) WHERE s:TSCallable OR s:TSClass OR s:TSInterface OR s:TSEnum OR s:TSTypeAlias OR s:TSNamespace OR s:TSExternal RETURN count(s)",
      );
      expect(symbol).toBeGreaterThan(0);
      expect(kinds).toBe(symbol);

      // Constraints + indexes were created up front.
      expect(await num("SHOW CONSTRAINTS YIELD name RETURN count(*)")).toBeGreaterThanOrEqual(8);
      expect(await num("SHOW INDEXES YIELD name RETURN count(*)")).toBeGreaterThanOrEqual(11);

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
      const rows = project(analyze(optsFor()), "sample-app");
      await boltWriter(rows, cfg, log, true);
      expect(await num("MATCH (n) RETURN count(n)")).toBe(rows.nodes.length);
      expect(await num("MATCH ()-[r]->() RETURN count(r)")).toBe(rows.edges.length);
    },
    120_000,
  );

  test(
    "a full run prunes a module whose source vanished",
    async () => {
      const app = analyze(optsFor());
      const victim = Object.keys(app.symbol_table).sort()[0];
      delete app.symbol_table[victim];

      const rows = project(app, "sample-app");
      await boltWriter(rows, cfg, log, true);

      // The victim's nodes are gone.
      expect(await num("MATCH (n {_module:$m}) RETURN count(n)", { m: victim })).toBe(0);

      // The surviving module-scoped graph matches the reduced projection. (Shared :TSExternal/:TSPackage
      // nodes are MERGE-only and intentionally never pruned, so we compare only _module-tagged nodes.)
      const moduleScoped = rows.nodes.filter((n) => "_module" in n.props).length;
      expect(await num("MATCH (n) WHERE n._module IS NOT NULL RETURN count(n)")).toBe(moduleScoped);
    },
    120_000,
  );
});

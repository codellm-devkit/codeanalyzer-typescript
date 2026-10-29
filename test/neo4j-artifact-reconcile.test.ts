/**
 * Bolt artifact reconciliation on a full `--eager` run: stale artifacts, config keys and
 * TS-owned artifact edges go; anything another analyzer still claims stays. Same contract as
 * codeanalyzer-java's and codeanalyzer-python's Bolt writers. Opt-in, like neo4j-bolt.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Neo4jContainer, type StartedNeo4jContainer } from "@testcontainers/neo4j";
import neo4j, { type Driver } from "neo4j-driver";
import { type BoltConfig, boltWriter, project } from "../src/build/neo4j";
import type { GraphRows } from "../src/build/neo4j/rows";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import { Logger } from "../src/utils";

const FIXTURES = path.resolve(import.meta.dir, "fixtures");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cants-reconcile-"));
const log = new Logger(0);
const APP = "can://app";
const ART = `${APP}/artifact/`;
const containerSuite = process.env.RUN_CONTAINER_TESTS ? describe : describe.skip;

/** artifacts-app copied to `<repo>/services/app`, so it can be pushed with or without a workspace root. */
function repo(): { repo: string; input: string } {
  const root = fs.mkdtempSync(path.join(TMP, "repo-"));
  const input = path.join(root, "services/app");
  fs.cpSync(path.join(FIXTURES, "artifacts-app"), input, { recursive: true });
  return { repo: root, input };
}

async function rows(input: string, over: Partial<AnalysisOptions> = {}): Promise<GraphRows> {
  const opts = {
    input, output: null, emit: "json", appName: "app", neo4jUri: null, neo4jUser: "neo4j",
    neo4jPassword: "", neo4jDatabase: null, analysisLevel: 2, graphs: [], graphFieldDepth: 3, jobs: 1,
    targetFiles: null, skipTests: true, eager: true, noBuild: true, phantoms: true, verbosity: 0,
    cacheDir: fs.mkdtempSync(path.join(TMP, "cache-")), workspaceRoot: null, ...over,
  } as AnalysisOptions;
  return project((await analyze(opts)).application);
}

containerSuite("neo4j bolt artifact reconciliation", () => {
  let container: StartedNeo4jContainer;
  let driver: Driver;
  let cfg: BoltConfig;

  beforeAll(async () => {
    container = await new Neo4jContainer("neo4j:5").withPassword("testpassword123").start();
    cfg = { uri: container.getBoltUri(), user: container.getUsername(), password: container.getPassword(), database: null };
    driver = neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password));
  }, 240_000);

  afterAll(async () => {
    await driver?.close();
    await container?.stop();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await run("MATCH (n) DETACH DELETE n");
  });

  async function run(cypher: string, params: Record<string, unknown> = {}): Promise<void> {
    const s = driver.session();
    try { await s.run(cypher, params); } finally { await s.close(); }
  }

  async function num(cypher: string, params: Record<string, unknown> = {}): Promise<number> {
    const s = driver.session();
    try {
      const v = (await s.run(cypher, params)).records[0]?.get(0);
      return typeof v?.toNumber === "function" ? v.toNumber() : Number(v ?? 0);
    } finally {
      await s.close();
    }
  }

  const stale = (rooted: string) =>
    num("MATCH (n) WHERE (n:Artifact OR n:ConfigKey) AND n.id STARTS WITH $p AND NOT n.id STARTS WITH $r RETURN count(n)",
      { p: ART, r: ART + rooted });

  test("toggling --workspace-root leaves no old-keyed artifact, config key or edge", async () => {
    const { repo: root, input } = repo();
    await boltWriter(await rows(input), cfg, log, true, true);
    expect(await num("MATCH (a:Artifact {id: $id}) RETURN count(a)", { id: ART + "package.json" })).toBe(1);

    const rooted = await rows(input, { workspaceRoot: root });
    await boltWriter(rooted, cfg, log, true, true);

    expect(await stale("services/app/")).toBe(0);
    const arts = rooted.nodes.filter((n) => n.labels[0] === "Artifact").length;
    expect(await num("MATCH (:TSApplication)-[r:HAS_ARTIFACT]->() RETURN count(r)")).toBe(arts);
    expect(await num("MATCH ()-[r:DECLARES_DEPENDENCY]->(:Package {id: 'pkg:npm/react'}) RETURN count(r)")).toBe(1);
    const uses = rooted.edges.filter((e) => e.type === "TS_USES_CONFIG").length;
    expect(uses).toBeGreaterThan(0);
    expect(await num("MATCH ()-[r:TS_USES_CONFIG]->() RETURN count(r)")).toBe(uses);
  }, 180_000);

  test("a targeted or non-eager push reconciles no artifacts", async () => {
    const { repo: root, input } = repo();
    await boltWriter(await rows(input), cfg, log, true, true);
    const rooted = await rows(input, { workspaceRoot: root });
    await boltWriter(rooted, cfg, log, false, true);
    await boltWriter(rooted, cfg, log, true, false);
    expect(await num("MATCH (a:Artifact {id: $id}) RETURN count(a)", { id: ART + "package.json" })).toBe(1);
  }, 180_000);

  test("a changed manifest drops its removed dependency, config key and their edges", async () => {
    const { input } = repo();
    await boltWriter(await rows(input), cfg, log, true, true);
    expect(await num("MATCH ()-[r:DECLARES_DEPENDENCY]->(:Package {id: 'pkg:npm/react'}) RETURN count(r)")).toBe(1);
    const envKey = `${ART}.env@key/PAYMENT_HOST`;
    expect(await num("MATCH ()-[r:TS_USES_CONFIG]->(:ConfigKey {id: $k}) RETURN count(r)", { k: envKey })).toBeGreaterThan(0);

    const pkg = JSON.parse(fs.readFileSync(path.join(input, "package.json"), "utf8"));
    delete pkg.peerDependencies;
    fs.writeFileSync(path.join(input, "package.json"), JSON.stringify(pkg));
    const env = fs.readFileSync(path.join(input, ".env"), "utf8");
    fs.writeFileSync(path.join(input, ".env"), env.split("\n").filter((l) => !l.startsWith("PAYMENT_HOST")).join("\n"));
    await boltWriter(await rows(input), cfg, log, true, true);

    expect(await num("MATCH ()-[r:DECLARES_DEPENDENCY]->(:Package {id: 'pkg:npm/react'}) RETURN count(r)")).toBe(0);
    expect(await num("MATCH (k:ConfigKey {id: $k}) RETURN count(k)", { k: envKey })).toBe(0);
    expect(await num("MATCH ()-[r:TS_USES_CONFIG]->(:ConfigKey {id: $k}) RETURN count(r)", { k: envKey })).toBe(0);
  }, 180_000);

  test("an unchanged eager re-push is idempotent", async () => {
    const { input } = repo();
    const r = await rows(input);
    await boltWriter(r, cfg, log, true, true);
    const shape = "MATCH (n) OPTIONAL MATCH (n)-[r]-() RETURN count(DISTINCT n) * 1000000 + count(DISTINCT r)";
    const before = await num(shape);
    await boltWriter(r, cfg, log, true, true);
    expect(await num(shape)).toBe(before);
  }, 180_000);

  test("a sibling's claims survive: shared nodes, its edges, and nodes only it wrote", async () => {
    const { input } = repo();
    await boltWriter(await rows(input), cfg, log, true, true);
    // What codeanalyzer-python writes: its own inventory of pyproject.toml with a pypi dependency and
    // a config key, plus an artifact TypeScript never emits.
    await run(
      "MATCH (a:Artifact {id: $pp}) SET a:PyCanNode " +
        "MERGE (app:PyApplication {id: 'can://app'}) MERGE (app)-[:HAS_ARTIFACT]->(a) " +
        "MERGE (p:Package {id: 'pkg:pypi/flask'}) MERGE (a)-[:DECLARES_DEPENDENCY {_k: 'runtime'}]->(p) " +
        "MERGE (k:ConfigKey:PyCanNode {id: $pp + '@key/tool.name'}) MERGE (a)-[:DEFINES_CONFIG]->(k) " +
        "MERGE (o:Artifact:PyCanNode {id: $py}) MERGE (app)-[:HAS_ARTIFACT]->(o)",
      { pp: ART + "pyproject.toml", py: ART + "setup.cfg" },
    );
    // Stop emitting pyproject.toml: TypeScript releases its claim but must not delete python's node.
    fs.rmSync(path.join(input, "pyproject.toml"));
    await boltWriter(await rows(input), cfg, log, true, true);

    const pp = ART + "pyproject.toml";
    expect(await num("MATCH (a:Artifact:PyCanNode {id: $id}) WHERE NOT a:TSCanNode RETURN count(a)", { id: pp })).toBe(1);
    expect(await num("MATCH (:TSApplication)-[r:HAS_ARTIFACT]->(:Artifact {id: $id}) RETURN count(r)", { id: pp })).toBe(0);
    expect(await num("MATCH (:Artifact {id: $id})-[r:DECLARES_DEPENDENCY]->(:Package {id: 'pkg:pypi/flask'}) RETURN count(r)", { id: pp })).toBe(1);
    expect(await num("MATCH (:Artifact {id: $id})-[:DEFINES_CONFIG]->(:ConfigKey:PyCanNode) RETURN count(*)", { id: pp })).toBe(1);
    expect(await num("MATCH (a:Artifact {id: $id}) RETURN count(a)", { id: ART + "setup.cfg" })).toBe(1);
  }, 180_000);

  test("a config key another analyzer claims survives TypeScript dropping it", async () => {
    const { input } = repo();
    await boltWriter(await rows(input), cfg, log, true, true);
    const key = `${ART}.env@key/PAYMENT_HOST`;
    await run("MATCH (k:ConfigKey {id: $k}) SET k:PyCanNode", { k: key });
    const env = fs.readFileSync(path.join(input, ".env"), "utf8");
    fs.writeFileSync(path.join(input, ".env"), env.split("\n").filter((l) => !l.startsWith("PAYMENT_HOST")).join("\n"));
    await boltWriter(await rows(input), cfg, log, true, true);
    expect(await num("MATCH (:Artifact)-[:DEFINES_CONFIG]->(k:ConfigKey:PyCanNode {id: $k}) WHERE NOT k:TSCanNode RETURN count(k)", { k: key })).toBe(1);
  }, 180_000);

  test("an app whose name extends another's is not reconciled by it", async () => {
    const a = repo();
    const b = repo();
    await boltWriter(await rows(b.input, { appName: "apps" }), cfg, log, true, true);
    const before = await num("MATCH (n) WHERE (n:Artifact OR n:ConfigKey) AND n.id STARTS WITH 'can://apps/' RETURN count(n)");
    expect(before).toBeGreaterThan(0);
    for (const f of fs.readdirSync(a.input)) if (f !== "src") fs.rmSync(path.join(a.input, f), { recursive: true });
    await boltWriter(await rows(a.input), cfg, log, true, true);
    expect(await num("MATCH (n:TSCanNode) WHERE (n:Artifact OR n:ConfigKey) AND n.id STARTS WITH 'can://apps/' RETURN count(n)")).toBe(before);
  }, 180_000);

  test("pre-re-key artifacts are released; a sibling's are left alone", async () => {
    await run(
      "MERGE (a:Artifact {id: 'can://artifact/app/old.json'}) MERGE (k:ConfigKey {id: 'can://artifact/app/old.json@key/x'}) " +
        "MERGE (a)-[:DEFINES_CONFIG]->(k) MERGE (j:Artifact:JCanNode {id: 'can://artifact/app/pom.xml'})",
    );
    const { input } = repo();
    await boltWriter(await rows(input), cfg, log, true, true);
    expect(await num("MATCH (n) WHERE n.id STARTS WITH 'can://artifact/app/old.json' RETURN count(n)")).toBe(0);
    expect(await num("MATCH (n:JCanNode {id: 'can://artifact/app/pom.xml'}) RETURN count(n)")).toBe(1);
  }, 180_000);

  test("--eager --target-files purges no artifact and drops none of their edges", async () => {
    const { input } = repo();
    const full = await rows(input);
    await boltWriter(full, cfg, log, true, true);
    // A sibling's claim on the shared package.json: the old purge DETACH-deleted it on every eager run.
    await run("MATCH (a:Artifact {id: $id}) MERGE (p:PyApplication {id: 'can://app'}) MERGE (p)-[:HAS_ARTIFACT]->(a) " +
      "MERGE (k:Package {id: 'pkg:pypi/flask'}) MERGE (a)-[:DECLARES_DEPENDENCY {_k: 'runtime'}]->(k)", { id: ART + "package.json" });
    const shape = "MATCH (a) WHERE a:Artifact OR a:ConfigKey OPTIONAL MATCH (a)-[r]-() " +
      "RETURN count(DISTINCT a) * 1000000 + count(DISTINCT r)";
    const before = await num(shape);
    await boltWriter(full, cfg, log, false, true);
    expect(await num(shape)).toBe(before);
    expect(await num("MATCH (:PyApplication)-[:HAS_ARTIFACT]->(:Artifact {id: $id})-[:DECLARES_DEPENDENCY]->(:Package {id: 'pkg:pypi/flask'}) " +
      "RETURN count(*)", { id: ART + "package.json" })).toBe(1);
  }, 180_000);

  test("a pre-1.5.1 unmarked artifact a sibling still inventories survives", async () => {
    await run("MERGE (a:Artifact {id: 'can://artifact/app/requirements.txt'}) " +
      "MERGE (p:PyApplication {id: 'can://app'}) MERGE (p)-[:HAS_ARTIFACT]->(a)");
    const { input } = repo();
    await boltWriter(await rows(input), cfg, log, true, true);
    expect(await num("MATCH (:PyApplication)-[:HAS_ARTIFACT]->(a:Artifact {id: 'can://artifact/app/requirements.txt'}) " +
      "RETURN count(a)")).toBe(1);
  }, 180_000);

  test("a removed dependency and a now-declared import drop their import edges", async () => {
    const { input } = repo();
    await boltWriter(await rows(input), cfg, log, true, true);
    const provides = "MATCH (:Package {id: 'pkg:npm/express'})-[r:TS_PROVIDES]->() RETURN count(r)";
    const unresolved = "MATCH (:TSApplication)-[r:TS_UNRESOLVED_IMPORT]->(g) WHERE g.id ENDS WITH '/@external/left-pad' RETURN count(r)";
    expect(await num(provides)).toBe(1);
    expect(await num(unresolved)).toBe(1);

    const pkg = JSON.parse(fs.readFileSync(path.join(input, "package.json"), "utf8"));
    delete pkg.dependencies.express;
    pkg.dependencies["left-pad"] = "^1.3.0";
    fs.writeFileSync(path.join(input, "package.json"), JSON.stringify(pkg));
    for (const lock of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) fs.rmSync(path.join(input, lock), { force: true });
    await boltWriter(await rows(input), cfg, log, true, true);

    expect(await num(provides)).toBe(0);
    expect(await num(unresolved)).toBe(0);
  }, 180_000);

  test("javascript-namespace code edges into config keys are rebuilt, not lost", async () => {
    const { input } = repo();
    const ts = path.join(input, "src/config.ts");
    fs.writeFileSync(path.join(input, "src/config.js"),
      "export function readHost() { return process.env.PAYMENT_HOST; }\n");
    fs.rmSync(ts);
    fs.writeFileSync(path.join(input, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, target: "ES2022" }, include: ["src"] }));
    const r = await rows(input);
    const jsUses = r.edges.filter((e) => e.type === "TS_USES_CONFIG" && e.from.value.includes("/javascript/")).length;
    expect(jsUses).toBeGreaterThan(0);
    await boltWriter(r, cfg, log, true, true);
    await boltWriter(r, cfg, log, true, true); // second push: every module unchanged, edges must come back
    expect(await num("MATCH (s:JSCanNode)-[r:TS_USES_CONFIG]->(:ConfigKey) RETURN count(r)")).toBe(jsUses);
  }, 180_000);

  test("reconciliation spans several batches", async () => {
    await run("UNWIND range(1, 2500) AS i CREATE (:Artifact:TSCanNode {id: $p + 'stale/' + toString(i)})", { p: ART });
    const { input } = repo();
    await boltWriter(await rows(input), cfg, log, true, true);
    expect(await num("MATCH (a:Artifact) WHERE a.id STARTS WITH $p RETURN count(a)", { p: ART + "stale/" })).toBe(0);
  }, 180_000);
});

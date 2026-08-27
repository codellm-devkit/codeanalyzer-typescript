/**
 * Repository-artifact layer gates (#101, docs/design/specs/artifacts-and-dependencies.md):
 * level-invariance, npm scope mapping incl. the coined `peer` token, JSON-lock backfill
 * (declared-only), config keys, capture policy, wire content_hash, id grammar, determinism,
 * and the Neo4j projection of the three families.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { project } from "../src/build/neo4j";
import type { AnalysisOptions } from "../src/options";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/artifacts-app");

function options(over: Partial<AnalysisOptions> = {}): AnalysisOptions {
  return {
    input: FIXTURE, output: null, emit: "json", appName: "artifacts-app", neo4jUri: null,
    neo4jUser: "neo4j", neo4jPassword: "", neo4jDatabase: null, analysisLevel: 1, graphs: [],
    graphFieldDepth: 3, jobs: 1, targetFiles: null, skipTests: true, eager: true, noBuild: true,
    phantoms: true, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cants-art-")), verbosity: 0,
    ...over,
  } as AnalysisOptions;
}

const r1 = await analyze(options());
const arts = r1.application.application.artifacts;
const APP = "can://typescript/artifacts-app";

describe("artifact inventory (#101)", () => {
  test("non-source files are inventoried; source files are not", () => {
    for (const key of [
      "package.json", "package-lock.json", "packages/web/package.json", "packages/web/bun.lock",
      "yarn.lock", ".env", "tsconfig.json", "Dockerfile", ".github/workflows/ci.yml", "README.md", "logo.bin",
    ]) {
      expect(arts[key], key).toBeDefined();
    }
    expect(Object.keys(arts).some((k) => k.endsWith(".ts"))).toBe(false);
  });

  test("ids use the @artifact marker, dotfiles keep their dot; children chain off the artifact id", () => {
    expect(arts[".env"]?.id).toBe(`${APP}/@artifact/.env`);
    expect(arts["package.json"]?.dependencies["express"]?.id).toBe(`${APP}/@artifact/package.json/express`);
    expect(arts[".env"]?.config_keys["PAYMENT_HOST"]?.id).toBe(`${APP}/@artifact/.env/PAYMENT_HOST`);
  });

  test("classification: kinds and formats from the rules table", () => {
    expect(arts["package.json"]?.artifact_kind).toBe("build_manifest");
    expect(arts["package-lock.json"]?.artifact_kind).toBe("dependency_lockfile");
    expect(arts["yarn.lock"]?.artifact_kind).toBe("dependency_lockfile");
    expect(arts[".env"]?.artifact_kind).toBe("configuration");
    expect(arts["tsconfig.json"]?.artifact_kind).toBe("configuration");
    expect(arts["Dockerfile"]?.artifact_kind).toBe("container");
    expect(arts[".github/workflows/ci.yml"]?.artifact_kind).toBe("ci");
    expect(arts["README.md"]?.artifact_kind).toBe("documentation");
    expect(arts["logo.bin"]?.artifact_kind).toBe("other");
    expect(arts[".env"]?.format).toBe("env");
    expect(arts["packages/web/bun.lock"]?.format).toBe("jsonc");
  });

  test("binary files carry hash+size but no text; wire keeps content_hash (strip-collision gate)", () => {
    const bin = arts["logo.bin"];
    expect(bin?.text).toBeUndefined();
    expect(bin?.content_hash?.length).toBe(64);
    expect(bin?.size_bytes).toBe(6);
    // the module cache trio stays stripped while artifact content_hash survives on the SAME wire
    const mod = r1.application.application.symbol_table["src/index.ts"] as unknown as Record<string, unknown>;
    expect(mod["content_hash"]).toBeUndefined();
  });
});

describe("dependencies: scopes, workspace manifests, lock backfill (#101)", () => {
  const deps = arts["package.json"]?.dependencies ?? {};

  test("every npm section maps to the shared scope vocabulary, peer included", () => {
    expect(deps["express"]?.scope).toBe("runtime");
    expect(deps["typescript"]?.scope).toBe("development");
    expect(deps["fsevents"]?.scope).toBe("optional");
    expect(deps["react"]?.scope).toBe("peer");
    expect(deps["@scope/util"]?.name).toBe("@scope/util");
    for (const d of Object.values(deps)) {
      expect(d.ecosystem).toBe("npm");
      expect(d.direct).toBe(true);
    }
  });

  test("package-lock backfills resolved_version on DECLARED records only", () => {
    expect(deps["express"]?.resolved_version).toBe("4.19.2");
    expect(deps["@scope/util"]?.resolved_version).toBe("2.1.5");
    expect(deps["typescript"]?.resolved_version).toBe("5.5.4");
    expect(deps["react"]?.resolved_version).toBeUndefined(); // declared, not locked
    expect(Object.keys(deps)).not.toContain("lockonly-transitive"); // lock never creates records
    expect(Object.keys(deps)).not.toContain("transitive-shadow"); // nested lock entries ignored
  });

  test("a workspace member's manifest is its own artifact with its OWN lock (bun.lock JSONC)", () => {
    const web = arts["packages/web/package.json"]?.dependencies ?? {};
    expect(web["lodash"]?.scope).toBe("runtime");
    expect(web["lodash"]?.resolved_version).toBe("4.17.21");
  });

  test("yarn.lock is inventory-only: an artifact node, no extraction", () => {
    expect(Object.keys(arts["yarn.lock"]?.dependencies ?? {})).toEqual([]);
  });
});

describe("config keys (#101)", () => {
  test(".env flat keys under namespace env, quotes stripped, placeholder refs recorded", () => {
    const keys = arts[".env"]?.config_keys ?? {};
    expect(keys["PAYMENT_HOST"]?.value).toBe("https://pay.example.com");
    expect(keys["PAYMENT_HOST"]?.namespace).toBe("env");
    expect(keys["DB_URL"]?.references).toEqual(["env:PAYMENT_HOST"]);
    expect(keys["NODE_OPTIONS"]?.value).toBe("--max-old-space-size=4096");
  });

  test("JSON configs flatten to dotted keys", () => {
    const keys = arts["tsconfig.json"]?.config_keys ?? {};
    expect(keys["compilerOptions.strict"]?.value).toBe(true);
    expect(keys["compilerOptions.target"]?.value).toBe("ES2022");
  });
});

describe("level-invariance, capture policy, determinism (#101)", () => {
  test("artifacts are identical at -a 1 and -a 4 (level-free)", async () => {
    const r4 = await analyze(options({ analysisLevel: 4, graphs: ["cfg", "dfg", "pdg", "sdg"] }));
    expect(r4.application.application.artifacts).toEqual(arts);
  });

  test("--no-artifact-text drops text but keeps the inventory AND extraction", async () => {
    const r = await analyze(options({ artifactText: false }));
    const a = r.application.application.artifacts;
    expect(a[".env"]?.text).toBeUndefined();
    expect(a[".env"]?.config_keys["PAYMENT_HOST"]?.value).toBe("https://pay.example.com");
    expect(a["package.json"]?.dependencies["express"]?.resolved_version).toBe("4.19.2");
  });

  test("the byte cap truncates and flags", async () => {
    const r = await analyze(options({ artifactTextMaxBytes: 8 }));
    const a = r.application.application.artifacts["README.md"];
    expect(a?.text_truncated).toBe(true);
    expect((a?.text ?? "").length).toBeLessThanOrEqual(8);
    expect(a?.content_hash).toBe(arts["README.md"]?.content_hash as string); // hash is of the FULL bytes
  });

  test("two consecutive default runs are byte-identical", async () => {
    const a = JSON.stringify((await analyze(options())).application);
    const b = JSON.stringify((await analyze(options())).application);
    expect(a).toBe(b);
  });
});

describe("Neo4j projection (#101, contract 2.2.0)", () => {
  const rows = project(r1.application);

  test("the three families project with containment edges", () => {
    const artNode = rows.nodes.find((n) => n.value === `${APP}/@artifact/package.json`);
    expect(artNode?.labels).toContain("TSArtifact");
    expect(artNode?.props["content_hash"]).toBeDefined();
    expect(artNode?.props["text"]).toBeUndefined(); // text stays off the graph
    const depNode = rows.nodes.find((n) => n.value === `${APP}/@artifact/package.json/react`);
    expect(depNode?.labels).toContain("TSDependency");
    expect(depNode?.props["scope"]).toBe("peer");
    const ckNode = rows.nodes.find((n) => n.value === `${APP}/@artifact/.env/DB_URL`);
    expect(ckNode?.labels).toContain("TSConfigKey");
    expect(rows.edges.some((e) => e.type === "TS_HAS_ARTIFACT" && e.to.value === artNode?.value)).toBe(true);
    expect(rows.edges.some((e) => e.type === "TS_DECLARES_DEPENDENCY" && e.to.value === depNode?.value)).toBe(true);
    expect(rows.edges.some((e) => e.type === "TS_DEFINES_CONFIG" && e.to.value === ckNode?.value)).toBe(true);
  });
});

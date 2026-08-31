/**
 * Repository-artifact layer gates (#101, recalibrated to python PR #160 / the ratified
 * 2026-08-27 spec): neutral artifact ids, rules-matched capture, flat evidence-tagged
 * dependencies (npm kinds incl. the coined `peer`), lock backfill with `lockfile` prov,
 * unresolved imports with the @types type-only rule, level-invariance, determinism, and the
 * neutral :Artifact/:Package Neo4j projection.
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
const root = r1.application.application;
const arts = root.artifacts;
const deps = root.dependencies;
const byName = new Map(deps.map((d) => [d.name, d]));

describe("artifact inventory — rules-matched, neutral ids (#101/PR-160)", () => {
  test("rules-matched files are inventoried; unmatched and source files are not", () => {
    for (const key of [
      "package.json", "package-lock.json", "packages/web/package.json", "packages/web/bun.lock",
      "yarn.lock", ".env", "tsconfig.json", "Dockerfile", ".github/workflows/ci.yml", "README.md", "LICENSE",
    ]) {
      expect(arts[key], key).toBeDefined();
    }
    expect(Object.keys(arts).some((k) => k.endsWith(".ts"))).toBe(false);
  });

  test("ids are LANGUAGE-NEUTRAL (can://artifact/<app>/<path>); dotfiles keep the dot", () => {
    expect(arts[".env"]?.id).toBe("can://artifact/artifacts-app/.env");
    expect(arts["packages/web/package.json"]?.id).toBe("can://artifact/artifacts-app/packages/web/package.json");
  });

  test("roles and formats from the rules table; roles union across matches", () => {
    expect(arts["package.json"]?.roles).toEqual(["dependency-manifest", "tool-config"]);
    expect(arts["package-lock.json"]?.roles).toEqual(["dependency-manifest"]);
    expect(arts[".env"]?.roles).toEqual(["env"]);
    expect(arts["tsconfig.json"]?.roles).toEqual(["tool-config"]);
    expect(arts["Dockerfile"]?.roles).toEqual(["container-image"]);
    expect(arts[".github/workflows/ci.yml"]?.roles).toEqual(["ci"]);
    expect(arts["README.md"]?.roles).toEqual(["docs"]);
    expect(arts["LICENSE"]?.roles).toEqual(["legal"]);
    expect(arts["packages/web/bun.lock"]?.format).toBe("jsonc");
  });

  test("verbatim source + sha256 + extraction status", () => {
    expect(arts["package.json"]?.source).toContain('"express"');
    expect(arts["package.json"]?.sha256?.length).toBe(64);
    expect(arts["package.json"]?.extraction).toBe("full");
    expect(arts["yarn.lock"]?.extraction).toBe("none"); // inventory-only lock format
    expect(arts["README.md"]?.extraction).toBe("none");
  });
});

describe("dependencies — flat, evidence-tagged (#101/PR-160)", () => {
  test("npm sections map to the shared kind vocabulary, `peer` included; prov declared", () => {
    expect(byName.get("express")?.kind).toBe("runtime");
    expect(byName.get("typescript")?.kind).toBe("dev");
    expect(byName.get("fsevents")?.kind).toBe("optional");
    expect(byName.get("react")?.kind).toBe("peer");
    for (const d of deps) {
      expect(d.prov).toContain("declared");
      expect(d.extras).toEqual([]);
    }
  });

  test("declared_in is the manifest's neutral artifact id (workspace member keeps its own)", () => {
    expect(byName.get("express")?.declared_in).toBe("can://artifact/artifacts-app/package.json");
    expect(byName.get("lodash")?.declared_in).toBe("can://artifact/artifacts-app/packages/web/package.json");
  });

  test("locks backfill locked_version on declared records only, prov gains lockfile", () => {
    expect(byName.get("express")?.locked_version).toBe("4.19.2");
    expect(byName.get("express")?.prov).toEqual(["declared", "lockfile"]);
    expect(byName.get("lodash")?.locked_version).toBe("4.17.21"); // sibling bun.lock (JSONC)
    expect(byName.get("react")?.locked_version).toBeUndefined();
    expect(byName.has("lockonly-transitive")).toBe(false); // locks never create records
    expect(byName.has("transitive-shadow")).toBe(false); // nested lock entries ignored
  });

  test("provides_imports: the name itself; @types/x also provides x", () => {
    expect(byName.get("express")?.provides_imports).toEqual(["express"]);
    expect(byName.get("@types/typed-only-pkg")?.provides_imports).toEqual(["@types/typed-only-pkg", "typed-only-pkg"]);
  });
});

describe("unresolved imports — the hygiene signal (#101/PR-160)", () => {
  test("an undeclared VALUE import surfaces; declared and type-only-via-@types do not", () => {
    const mods = root.unresolved_imports.map((u) => u.module);
    expect(mods).toContain("left-pad"); // imported, never declared
    expect(mods).not.toContain("express"); // declared runtime
    expect(mods).not.toContain("typed-only-pkg"); // import type + @types declared → satisfied
    expect(mods).not.toContain("node:fs"); // builtin
  });

  test("--resolve-installed binds via node_modules metadata (prov installed-metadata)", async () => {
    const r = await analyze(options({ resolveInstalled: true }));
    const u = r.application.application.unresolved_imports.find((x) => x.module === "left-pad");
    expect(u?.bound_to).toBe("left-pad");
    expect(u?.prov).toEqual(["installed-metadata"]);
  });
});

describe("level-invariance + determinism (#101)", () => {
  test("the three sections are identical at -a 1 and -a 4", async () => {
    const r4 = await analyze(options({ analysisLevel: 4, graphs: ["cfg", "dfg", "pdg", "sdg"] }));
    expect(r4.application.application.artifacts).toEqual(arts);
    expect(r4.application.application.dependencies).toEqual(deps);
    expect(r4.application.application.unresolved_imports).toEqual(root.unresolved_imports);
  });

  test("two consecutive default runs are byte-identical", async () => {
    const a = JSON.stringify((await analyze(options())).application);
    const b = JSON.stringify((await analyze(options())).application);
    expect(a).toBe(b);
  });

  test("text capture: on by default, truncates under the cap, hash stays full-file", async () => {
    const full = (await analyze(options())).application.application.artifacts["README.md"];
    expect(full?.source.length).toBeGreaterThan(0);
    expect(full?.text_truncated).toBe(false);

    const capped = (await analyze(options({ artifactTextMaxBytes: 8 }))).application.application.artifacts["README.md"];
    expect(capped?.text_truncated).toBe(true);
    expect(capped!.source.length).toBeLessThanOrEqual(8);
    expect(capped?.sha256).toBe(full?.sha256); // hash is of the FULL file
    expect(capped?.size_bytes).toBe(full?.size_bytes);
  });

  test("--no-artifact-text drops source but keeps inventory AND extraction", async () => {
    const a = (await analyze(options({ artifactText: false }))).application.application;
    expect(a.artifacts["package.json"]?.source).toBe("");
    expect(a.dependencies.find((d) => d.name === "express")?.locked_version).toBe("4.19.2");
  });

  test("text cap is byte-accurate on multi-byte UTF-8 (not character-count)", async () => {
    // Create a test .md file with multi-byte chars to verify cap is byte-accurate, not char-count.
    // "Hi 🎉": H=1 byte, i=1 byte, space=1 byte, emoji=4 bytes (UTF-8) = 7 bytes total, 5 chars.
    const testFile = path.join(FIXTURE, "multi-byte-test.md");
    const fullContent = "Hi 🎉";
    fs.writeFileSync(testFile, fullContent, "utf8");

    // Analyze with a cap of 3 bytes. This is enough for "Hi " but splits the emoji.
    const r = await analyze(options({ artifactTextMaxBytes: 3 }));
    const art = r.application.application.artifacts["multi-byte-test.md"];

    expect(art?.text_truncated).toBe(true);
    // The stored source should be truncated (not the full 7 bytes).
    // With a 3-byte cap, we get "Hi " exactly (3 bytes), no truncation of multi-byte sequence.
    expect(art!.source).not.toBe(fullContent);
    expect(art!.source).toBe("Hi ");
    expect(Buffer.byteLength(art!.source, "utf8")).toBe(3);
    expect(art?.sha256).toBeDefined(); // hash is always full-file
    expect(art?.size_bytes).toBe(7); // size is full-file (7 bytes)

    // Clean up
    fs.unlinkSync(testFile);
  });
});

describe("Neo4j projection — neutral :Artifact/:Package (#101, contract 2.2.0)", () => {
  const rows = project(r1.application);

  test("neutral nodes with purl ids; TS-prefixed claims into the ghost space", () => {
    const art = rows.nodes.find((n) => n.value === "can://artifact/artifacts-app/package.json");
    expect(art?.labels).toEqual(["Artifact"]);
    expect(art?.props["roles"]).toEqual(["dependency-manifest", "tool-config"]);
    expect(art?.props["source"]).toBeUndefined(); // text stays off the graph
    const pkg = rows.nodes.find((n) => n.value === "pkg:npm/react");
    expect(pkg?.labels).toEqual(["Package"]);
    const scoped = rows.nodes.find((n) => n.value === "pkg:npm/%40scope/util");
    expect(scoped, "scoped purl").toBeDefined();
    expect(rows.edges.some((e) => e.type === "HAS_ARTIFACT" && e.to.value === art?.value)).toBe(true);
    const decl = rows.edges.find((e) => e.type === "DECLARES_DEPENDENCY" && e.to.value === "pkg:npm/react");
    expect(decl?.props["kind"]).toBe("peer");
    expect(rows.edges.some((e) => e.type === "LOCKS" && e.to.value === "pkg:npm/express")).toBe(true);
    expect(
      rows.edges.some(
        (e) => e.type === "TS_PROVIDES" && e.from.value === "pkg:npm/express" && String(e.to.value).endsWith("/@external/express"),
      ),
    ).toBe(true);
    expect(
      rows.edges.some((e) => e.type === "TS_UNRESOLVED_IMPORT" && String(e.to.value).endsWith("/@external/left-pad")),
    ).toBe(true);
  });
});

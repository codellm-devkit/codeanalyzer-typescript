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
  test("rules-matched files are present; source files (ts/js/tsx/jsx) are absent", () => {
    for (const key of [
      "package.json", "package-lock.json", "packages/web/package.json", "packages/web/bun.lock",
      "yarn.lock", ".env", "tsconfig.json", "Dockerfile", ".github/workflows/ci.yml", "README.md", "LICENSE",
    ]) {
      expect(arts[key], key).toBeDefined();
    }
    expect(Object.keys(arts).some((k) => k.endsWith(".ts"))).toBe(false);
  });

  test("never drops: unmatched files are unknown-role, binaries are hash-only", () => {
    const unknown = arts["notes.dat"];
    expect(unknown?.roles).toEqual(["unknown"]);
    expect(unknown?.format).toBe("text");
    expect(unknown?.source.length).toBeGreaterThan(0);

    const bin = arts["logo.bin"];
    expect(bin?.format).toBe("binary");
    expect(bin?.roles).toEqual(["unknown"]);
    expect(bin?.source).toBe("");
    expect(bin?.sha256.length).toBe(64);
    expect(bin?.size_bytes).toBeGreaterThan(0);
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
    for (const d of deps.filter((d) => d.direct)) {
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
    expect(byName.has("transitive-shadow")).toBe(false); // nested lock entries ignored
  });

  test("lock-only packages become direct:false records attributed to the lock", () => {
    const t = deps.find((d) => d.name === "lockonly-transitive");
    expect(t).toBeDefined();
    expect(t?.direct).toBe(false);
    expect(t?.kind).toBe("runtime");
    expect(t?.prov).toEqual(["lockfile"]);
    expect(t?.locked_version).toBe("1.0.0");
    expect(t?.declared_in).toBe("can://artifact/artifacts-app/package-lock.json");
    // declared packages stay direct
    expect(byName.get("express")?.direct).toBe(true);
    // nested shadow entries are NOT records
    expect(deps.some((d) => d.name === "transitive-shadow")).toBe(false);
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
    // The probe reads a real path, so plant the install the fixture is meant to have.
    // node_modules is gitignored everywhere, so it cannot ship with the fixture.
    const pkgDir = path.join(FIXTURE, "node_modules", "left-pad");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "left-pad", version: "1.3.0" }));

    const r = await analyze(options({ resolveInstalled: true }));
    const u = r.application.application.unresolved_imports.find((x) => x.module === "left-pad");
    expect(u?.bound_to).toBe("left-pad");
    expect(u?.prov).toEqual(["installed-metadata"]);

    // Clean up
    fs.rmSync(path.join(FIXTURE, "node_modules"), { recursive: true, force: true });
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

  // No byte cap (#116): a file is captured whole or not at all. A truncated `source` is a prefix
  // that reads like a complete file, so every consumer then needs a flag to tell the two apart.
  test("text capture: on by default, always the WHOLE file, hash matches", async () => {
    const app = (await analyze(options())).application.application;
    const readme = app.artifacts["README.md"];
    expect(readme?.source.length).toBeGreaterThan(0);
    // The stored text is the entire file, byte for byte -- not a prefix.
    const onDisk = fs.readFileSync(path.join(FIXTURE, "README.md"), "utf8");
    expect(readme!.source).toBe(onDisk);
    expect(Buffer.byteLength(readme!.source, "utf8")).toBe(readme!.size_bytes);
  });

  test("--no-artifact-text drops source but keeps inventory AND extraction", async () => {
    const a = (await analyze(options({ artifactText: false }))).application.application;
    expect(a.artifacts["package.json"]?.source).toBe("");
    expect(a.dependencies.find((d) => d.name === "express")?.locked_version).toBe("4.19.2");
  });

});

describe("Neo4j projection — neutral :Artifact/:Package (#101)", () => {
  const rows = project(r1.application);

  test("neutral nodes with purl ids; TS-prefixed claims into the ghost space", () => {
    const art = rows.nodes.find((n) => n.value === "can://artifact/artifacts-app/package.json");
    expect(art?.labels).toEqual(["Artifact"]);
    expect(art?.props["roles"]).toEqual(["dependency-manifest", "tool-config"]);
    // Artifact text belongs on the graph: python has carried `source` on :Artifact since it
    // shipped the layer, so a consumer reading the same neutral node from two analyzers must not
    // get text from one and nothing from the other (#116).
    expect(art?.props["source"]).toBeDefined();
    const pkg = rows.nodes.find((n) => n.value === "pkg:npm/react");
    expect(pkg?.labels).toEqual(["Package"]);
    const scoped = rows.nodes.find((n) => n.value === "pkg:npm/%40scope/util");
    expect(scoped, "scoped purl").toBeDefined();
    expect(rows.edges.some((e) => e.type === "HAS_ARTIFACT" && e.to.value === art?.value)).toBe(true);
    const decl = rows.edges.find((e) => e.type === "DECLARES_DEPENDENCY" && e.to.value === "pkg:npm/react");
    expect(decl?.props["kind"]).toBe("peer");
    // direct:true (declared in package.json) vs. direct:false (lock-only transitive) — the
    // recipe `MATCH (:Artifact)-[d:DECLARES_DEPENDENCY {direct: true}]->(p:Package)` separates
    // the declared SURFACE from the full lockfile-inclusive SUPPLY CHAIN.
    expect(decl?.props["direct"]).toBe(true);
    const transitive = rows.edges.find((e) => e.type === "DECLARES_DEPENDENCY" && e.to.value === "pkg:npm/lockonly-transitive");
    expect(transitive?.props["direct"]).toBe(false);
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

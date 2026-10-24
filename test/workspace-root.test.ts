/**
 * `--workspace-root`: published file keys and the ids built from them are repo-relative.
 *
 * Re-keying happens at emission only: signatures, entrypoint path rules, test-file detection and
 * the cache keep the --input-relative key, so a workspace root changes WHAT a file is called, never
 * WHETHER it is analysed or how it matches. Same semantics as codeanalyzer-java, so a
 * language-neutral artifact id names the same node whichever analyzer emitted it.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InputError, analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import { forEachCallable, type TSApplication } from "../src/schema";
import { loadCache } from "../src/utils";

const ROOT = path.resolve(import.meta.dir, "..");
const FIXTURES = path.resolve(import.meta.dir, "fixtures");

/**
 * A repository whose path ABOVE --input holds a `test` segment: discovery's test-tree skip must
 * judge the --input-relative key, or every file here would read as a test and vanish.
 */
function repoWith(fixture: string): { repo: string; input: string; prefix: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cants-219-"));
  const rel = "test/services/app";
  const input = path.join(repo, rel);
  fs.cpSync(path.join(FIXTURES, fixture), input, { recursive: true });
  return { repo, input, prefix: `${rel}/` };
}

function options(input: string, over: Partial<AnalysisOptions> = {}): AnalysisOptions {
  return {
    input, output: null, emit: "json", appName: "app", neo4jUri: null, neo4jUser: "neo4j",
    neo4jPassword: "", neo4jDatabase: null, analysisLevel: 1, graphs: ["cfg", "dfg", "pdg", "sdg"], graphFieldDepth: 3, jobs: 1,
    targetFiles: null, skipTests: true, eager: true, noBuild: true, phantoms: true,
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cants-219-cache-")), verbosity: 0,
    workspaceRoot: null, ...over,
  } as AnalysisOptions;
}

/** Every `can://app/...` id in a payload, wherever it sits. */
function idsIn(json: string): string[] {
  return [...json.matchAll(/"(can:\/\/app\/[^"]*)"/g)].map((m) => m[1]!);
}

function cli(args: string[]): { code: number; stderr: string } {
  const p = Bun.spawnSync(["bun", "run", path.join(ROOT, "src/index.ts"), ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stderr: p.stderr.toString() };
}

describe("--workspace-root", () => {
  test("symbol_table keys, module ids and every code id below them are repo-relative, through L3", async () => {
    const { repo, input, prefix } = repoWith("dataflow-app");
    const without = (await analyze(options(input, { analysisLevel: 3 }))).application.application;
    const r = await analyze(options(input, { analysisLevel: 3, workspaceRoot: repo }));
    const app = r.application.application;

    expect(app.id).toBe("can://app"); // the app segment does not move
    const keys = Object.keys(app.symbol_table);
    expect(keys.length).toBe(Object.keys(without.symbol_table).length); // nothing lost to the test-dir skip
    for (const k of keys) {
      expect(k.startsWith(prefix)).toBe(true);
      expect(k.startsWith("/") || k.includes("..")).toBe(false);
      expect(app.symbol_table[k]!.id).toBe(`can://app/typescript/${k}`);
    }
    for (const k of Object.keys(without.symbol_table)) expect(app.symbol_table[prefix + k]).toBeDefined();

    const json = JSON.stringify(app);
    const ids = idsIn(json).filter((id) => /^can:\/\/app\/(typescript|javascript)\//.test(id));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(new RegExp(`^can://app/(typescript|javascript)/${prefix}`));
    expect(json).toContain('"cfg"'); // L3 overlays rode along

    expect(app.call_graph.length).toBe(without.call_graph.length);
    for (const e of app.call_graph) expect(e.src.includes(`/${prefix}`)).toBe(true);
  });

  test("signatures stay --input-relative: the re-key is the published name, not the analysis", async () => {
    const { repo, input } = repoWith("sample-app");
    const a = (await analyze(options(input))).application.application;
    const b = (await analyze(options(input, { workspaceRoot: repo }))).application.application;
    const sigs = (app: typeof a) =>
      Object.values(app.symbol_table).flatMap((m) => Object.values(m.functions ?? {}).map((f) => f.signature)).sort();
    expect(sigs(b)).toEqual(sigs(a));
  });

  test("entrypoint path rules still match against the --input-relative key", async () => {
    // A Next.js route file: the shipped rule `app/**/route.{ts,...}` is matched against the
    // --input-relative key, so the prefix above it must not stop it matching.
    const { repo, input, prefix } = repoWith("sample-app");
    // The Next.js rules are gated on `next` being a declared dependency.
    const pkg = JSON.parse(fs.readFileSync(path.join(input, "package.json"), "utf8"));
    fs.writeFileSync(path.join(input, "package.json"), JSON.stringify({ ...pkg, dependencies: { next: "14.0.0" } }));
    const route = path.join(input, "app/api/hello/route.ts");
    fs.mkdirSync(path.dirname(route), { recursive: true });
    fs.writeFileSync(route, "export async function GET() { return new Response('hi'); }\n");
    const get = (app: TSApplication, key: string) => {
      let found: unknown[] | undefined;
      forEachCallable(app.symbol_table[key]!, (c) => { if (c.name === "GET") found = c.entrypoints ?? []; });
      return found;
    };
    const a = (await analyze(options(input))).application.application;
    const b = (await analyze(options(input, { workspaceRoot: repo }))).application.application;
    const expected = { rule: "nextjs.app-route", evidence: "app/api/hello/route.ts", route: "/api/hello" };
    expect(get(a, "app/api/hello/route.ts")?.[0]).toMatchObject(expected); // precondition: the rule fires
    expect(get(b, `${prefix}app/api/hello/route.ts`)?.[0]).toMatchObject(expected);
  });

  test("artifact keys, paths and ids are prefixed; classification and extraction are unchanged", async () => {
    const { repo, input, prefix } = repoWith("artifacts-app");
    const a = (await analyze(options(input))).application.application;
    const b = (await analyze(options(input, { workspaceRoot: repo }))).application.application;

    expect(Object.keys(b.artifacts).sort()).toEqual(Object.keys(a.artifacts).map((k) => prefix + k).sort());
    for (const [k, art] of Object.entries(a.artifacts)) {
      const moved = b.artifacts[prefix + k]!;
      expect(moved.path).toBe(prefix + k);
      expect(moved.id).toBe(`can://app/artifact/${prefix}${k}`);
      expect(moved.format).toBe(art.format);
      expect(moved.roles).toEqual(art.roles);
      expect(moved.config_keys.length).toBe(art.config_keys.length);
      for (const ck of moved.config_keys) expect(ck.id.startsWith(moved.id)).toBe(true);
    }
    expect(b.dependencies.length).toBe(a.dependencies.length);
    for (const d of b.dependencies) expect(d.declared_in.startsWith(`can://app/artifact/${prefix}`)).toBe(true);
  });

  test("the cache stays --input-relative, so toggling the flag reuses it", async () => {
    const { repo, input, prefix } = repoWith("sample-app");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-219-shared-"));
    const plain = (await analyze(options(input, { cacheDir }))).application.application;
    const cachedKeys = () => Object.keys(loadCache(cacheDir)!.symbol_table).sort();
    const before = cachedKeys();
    const moved = (await analyze(options(input, { cacheDir, eager: false, workspaceRoot: repo }))).application.application;
    expect(cachedKeys()).toEqual(before); // no prefixed key written into the cache
    for (const k of before) expect(k.startsWith(prefix)).toBe(false);
    expect(Object.keys(moved.symbol_table).sort()).toEqual(Object.keys(plain.symbol_table).map((k) => prefix + k).sort());
  });

  test("a workspace root equal to --input changes nothing", async () => {
    const { input } = repoWith("artifacts-app");
    const a = (await analyze(options(input))).application;
    const b = (await analyze(options(input, { workspaceRoot: input }))).application;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test("an --input outside the workspace root is an InputError naming both", async () => {
    const { input } = repoWith("sample-app");
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "cants-219-elsewhere-"));
    const run = analyze(options(input, { workspaceRoot: elsewhere }));
    await expect(run).rejects.toBeInstanceOf(InputError);
    await expect(analyze(options(input, { workspaceRoot: elsewhere }))).rejects.toThrow(elsewhere);
  });

  test("CLI: the flag reaches the analysis, and an outside input exits 1 writing nothing", () => {
    const { repo, input, prefix } = repoWith("sample-app");
    const out = path.join(repo, "out");
    expect(cli(["-i", input, "-o", out, "--no-build", "--app-name", "app", "--workspace-root", repo]).code).toBe(0);
    const j = JSON.parse(fs.readFileSync(path.join(out, "analysis.json"), "utf8"));
    for (const k of Object.keys(j.application.symbol_table)) expect(k.startsWith(prefix)).toBe(true);

    const bad = path.join(repo, "bad-out");
    const r = cli(["-i", input, "-o", bad, "--no-build", "--workspace-root", path.join(repo, "nope")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--workspace-root");
    expect(fs.existsSync(path.join(bad, "analysis.json"))).toBe(false);
  });
});

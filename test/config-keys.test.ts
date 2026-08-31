import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { parseJsonc } from "../src/artifacts/configKeys";
import type { AnalysisOptions } from "../src/options";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/artifacts-app");
const opts = {
  input: FIXTURE, output: null, emit: "json", appName: "artifacts-app", neo4jUri: null,
  neo4jUser: "neo4j", neo4jPassword: "", neo4jDatabase: null, analysisLevel: 1, graphs: [],
  graphFieldDepth: 3, jobs: 1, targetFiles: null, skipTests: true, eager: true, noBuild: true,
  phantoms: true, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cants-keys-")), verbosity: 0,
} as AnalysisOptions;

const arts = (await analyze(opts)).application.application.artifacts;
const keysOf = (p: string): Record<string, { value?: string | number | boolean; namespace: string; id: string; references: string[] }> =>
  Object.fromEntries((arts[p]?.config_keys ?? []).map((k) => [k.key, k]));

describe("config keys — flat and JSON (#101 unit B)", () => {
  test(".env keys land in the env namespace with refs and stripped quotes", () => {
    const k = keysOf(".env");
    expect(k["PAYMENT_HOST"]?.value).toBe("https://pay.example.com");
    expect(k["PAYMENT_HOST"]?.namespace).toBe("env");
    expect(k["DB_URL"]?.references).toEqual(["env:PAYMENT_HOST"]);
    expect(k["NODE_OPTIONS"]?.value).toBe("--max-old-space-size=4096");
  });

  test("JSONC tsconfig parses despite comments and trailing commas", () => {
    const k = keysOf("tsconfig.json");
    expect(k["compilerOptions.strict"]?.value).toBe(true);
    expect(k["compilerOptions.target"]?.value).toBe("ES2022");
    expect(k["include.0"]?.value).toBe("src"); // arrays get numeric segments
    expect(arts["tsconfig.json"]?.extraction).toBe("full");
  });

  test("key ids chain off the artifact id", () => {
    expect(keysOf(".env")["PAYMENT_HOST"]?.id).toBe("can://artifact/artifacts-app/.env@key/PAYMENT_HOST");
  });

  test("a dependency manifest is never also a config file — manifests/lockfiles yield zero keys", () => {
    expect(arts["package.json"]?.config_keys.length).toBe(0);
    expect(arts["package-lock.json"]?.config_keys.length).toBe(0);
    expect(arts["packages/web/bun.lock"]?.config_keys.length).toBe(0);
    // the gate is role-scoped, not blanket — plain config files in the same formats still extract
    expect(arts["tsconfig.json"]?.config_keys.length).toBeGreaterThan(0);
    expect(arts[".env"]?.config_keys.length).toBeGreaterThan(0);
  });

  test("a genuinely malformed config file falls back to partial — node survives intact", () => {
    const art = arts["tsconfig.broken.json"];
    expect(art?.extraction).toBe("partial");
    expect(art?.config_keys).toEqual([]); // nothing salvaged, but no throw escaped
    expect(art?.sha256.length).toBe(64); // inventory fields untouched by the failed extraction
    expect(art?.size_bytes).toBeGreaterThan(0);
  });
});

// Direct unit tests of the parser (fix round 2): faster and clearer than round-tripping
// every case through a full analyze() run, since these are pure-function properties of
// parseJsonc itself, not of the artifact pipeline around it.
describe("parseJsonc — comments then trailing commas, each pass string-aware", () => {
  test("a string containing ', }' survives byte-for-byte (not mistaken for a trailing comma)", () => {
    expect(parseJsonc(`{"note": "hi, }"}`)).toEqual({ note: "hi, }" });
  });

  test("a string containing ',]' survives byte-for-byte", () => {
    expect(parseJsonc(`{"pattern": "a,]b"}`)).toEqual({ pattern: "a,]b" });
  });

  test("a string containing a trailing-comma-shaped glob token survives byte-for-byte", () => {
    expect(parseJsonc(`{"files": "dist/{cjs,}"}`)).toEqual({ files: "dist/{cjs,}" });
  });

  test("a string containing '//' survives (not mistaken for a line comment)", () => {
    expect(parseJsonc(`{"homepage": "https://example.com"}`)).toEqual({ homepage: "https://example.com" });
  });

  test("a string containing '/*' survives (not mistaken for a block comment)", () => {
    expect(parseJsonc(`{"glob": "a/*b"}`)).toEqual({ glob: "a/*b" });
  });

  test("an escaped quote inside a string doesn't end it early, even with a real comment right after", () => {
    // Built with a single-quoted JS string (not a template literal) so `\\"` in the SOURCE
    // collapses to a literal `\"` (backslash + quote) at RUNTIME — i.e. an actual escaped
    // quote inside the JSON text, the way it would read straight off disk.
    const doc = '{"note": "he said \\"hi\\"", "x": 1} // trailing comment';
    expect(parseJsonc(doc)).toEqual({ note: 'he said "hi"', x: 1 });
  });

  test("a genuine trailing comma is still stripped before both } and ]", () => {
    expect(parseJsonc(`{ "a": 1, "b": [1, 2, 3,], }`)).toEqual({ a: 1, b: [1, 2, 3] });
  });

  // Fix round 3: a trailing comma separated from its closing bracket by a comment (not just
  // whitespace) is an everyday tsconfig shape — comments removed in pass 1 make it reachable by
  // pass 2. A non-empty result here is exactly what flips the caller's `extraction` to "full"
  // (src/artifacts/index.ts: `if (keys.length) { ... extraction = "full" }`) — already pinned
  // end-to-end by the "JSONC tsconfig parses..." test above.
  test("a trailing comma followed by a line comment before the closing brace still parses", () => {
    expect(parseJsonc(`{"a": 1, // note\n}`)).toEqual({ a: 1 });
  });

  test("a trailing comma followed by a block comment before the closing brace still parses", () => {
    expect(parseJsonc(`{"a": 1, /* note */ }`)).toEqual({ a: 1 });
  });

  test("a genuinely malformed document still throws (caller marks the artifact partial)", () => {
    expect(() => parseJsonc(`{"a": "unterminated}`)).toThrow();
  });
});

describe("config keys — YAML (#101 unit B)", () => {
  test("nested maps and sequences flatten with numeric segments and real spans", () => {
    const k = keysOf("docker-compose.yml");
    expect(k["services.web.image"]?.value).toBe("node:22");
    expect(k["services.web.ports.0"]?.value).toBe("3000:3000");
    expect(k["services.web.image"]?.namespace).toBe("yaml");
    expect(k["services.web.image"]?.span?.start[0]).toBeGreaterThan(0);
  });
});

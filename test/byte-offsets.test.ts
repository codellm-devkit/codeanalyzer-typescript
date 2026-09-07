/**
 * #179 — `span.bytes` are UTF-8 BYTE offsets (spec: docs/design/specs/span-bytes-are-bytes.md).
 *
 * The fixture puts multibyte characters BEFORE and INSIDE declarations (a 3-byte em dash, a 4-byte
 * emoji, 3-byte CJK), so any producer still emitting UTF-16 char offsets lands short. Every node
 * kind that carries a span is sliced with the one rule the keystone and python use:
 * `Buffer.from(source).subarray(lo, hi)`.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { project } from "../src/build/neo4j";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSAnalysis, TSCallable, TSModule } from "../src/schema";
import { offsetMapOf, sliceBytes } from "../src/schema/offsets";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-bytes-"));
fs.mkdirSync(path.join(dir, "src"));
fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["src/**/*.ts"] }));
fs.writeFileSync(path.join(dir, "src", "m.ts"), [
  "// — an em dash before anything, 日本語 too 🎉",
  "export function greet(name: string): string {",
  '  const banner = "→ " + name; // arrow inside',
  '  const key = process.env["API_KEY"];',
  "  return banner + key;",
  "}",
  "export const emoji = '🎉';",
  "export default function handler(): string { return greet('日本'); }",
  "",
].join("\n"));
fs.writeFileSync(path.join(dir, ".env"), "API_KEY=x\n");
// compose.yaml is a recognized artifact (src/artifacts/rules.ts); an arbitrary *.yaml is not.
fs.writeFileSync(path.join(dir, "compose.yaml"), "title: naïve\nnested:\n  key: 值\n");

async function run(level: number) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-bytes-cache-"));
  const opts = { input: dir, appName: "b", analysisLevel: level, noBuild: true, emit: "json", eager: true, cacheDir, graphs: ["cfg", "dfg", "pdg", "sdg"] } as unknown as AnalysisOptions;
  const r = await analyze(opts);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  return r;
}
const bytesOf = (n: { span?: { bytes: [number, number] } }): [number, number] => n.span!.bytes;

describe("offsetMapOf", () => {
  test("ASCII text is the identity; multibyte text maps both ways", () => {
    const a = offsetMapOf("abc");
    expect([a.toByte(0), a.toByte(3), a.toChar(2)]).toEqual([0, 3, 2]);
    const m = offsetMapOf("a—b🎉c"); // a(1) —(3) b(1) 🎉(4, two code units) c(1)
    expect(m.toByte(0)).toBe(0);
    expect(m.toByte(1)).toBe(1); // "—" starts at byte 1
    expect(m.toByte(2)).toBe(4); // "b"
    expect(m.toByte(3)).toBe(5); // "🎉" high surrogate
    expect(m.toByte(5)).toBe(9); // "c"
    expect(m.toByte(6)).toBe(10); // end
    expect(m.toChar(4)).toBe(2);
    expect(m.toChar(9)).toBe(5);
    expect(sliceBytes("a—b🎉c", [m.toByte(1), m.toByte(2)])).toBe("—");
  });
});

describe("#179 span.bytes are UTF-8 byte offsets", () => {
  test("declarations, call sites, config_access and the module span slice byte-exact at L1", async () => {
    const r = await run(1);
    const mod = (r.application as TSAnalysis).application.symbol_table["src/m.ts"] as TSModule;
    const src = mod.source;
    expect(bytesOf(mod)).toEqual([0, Buffer.byteLength(src, "utf8")]);
    const greet = mod.functions["src/m.greet"] ?? (Object.values(mod.functions).find((f) => f.name === "greet") as TSCallable);
    expect(sliceBytes(src, bytesOf(greet)).startsWith("export function greet")).toBe(true);
    expect(sliceBytes(src, bytesOf(greet)).endsWith("}")).toBe(true);
    const handler = Object.values(mod.functions).find((f) => f.name === "handler") as TSCallable;
    expect(sliceBytes(src, bytesOf(handler))).toBe("export default function handler(): string { return greet('日本'); }");
    // L1 body nodes: the call inside handler, and the config_access inside greet
    const call = Object.values(handler.body).find((n) => n.kind === "call")!;
    expect(sliceBytes(src, bytesOf(call))).toBe("greet('日本')");
    const access = Object.values(greet.body).find((n) => n.kind === "config_access")!;
    expect(sliceBytes(src, bytesOf(access))).toBe('process.env["API_KEY"]');
    // the field
    const emoji = Object.values(mod.fields).find((f) => f.name === "emoji")!;
    expect(sliceBytes(src, bytesOf(emoji))).toContain("'🎉'");
  });

  test("L3 statements and @entry/@exit slice byte-exact", async () => {
    const r = await run(3);
    const mod = (r.application as TSAnalysis).application.symbol_table["src/m.ts"] as TSModule;
    const greet = Object.values(mod.functions).find((f) => f.name === "greet") as TSCallable;
    const stmts = Object.entries(greet.body).filter(([, n]) => n.kind === "statement");
    expect(stmts.length).toBeGreaterThan(0);
    const texts = stmts.map(([, n]) => sliceBytes(mod.source, bytesOf(n)));
    expect(texts).toContain('const banner = "→ " + name;');
    expect(texts).toContain("return banner + key;");
    expect(sliceBytes(mod.source, bytesOf(greet.body["@entry"]!))).toBe(sliceBytes(mod.source, bytesOf(greet)));
  });

  test("the graph's :TSCallable.code equals the byte slice, closing brace included", async () => {
    const r = await run(1);
    const app = r.application as TSAnalysis;
    const mod = app.application.symbol_table["src/m.ts"] as TSModule;
    const rows = project(app);
    for (const fn of Object.values(mod.functions)) {
      const node = rows.nodes.find((n) => n.value === fn.id)!;
      expect(node.props.code).toBe(sliceBytes(mod.source, bytesOf(fn)));
    }
  });

  test("a yaml ConfigKey span slices its own text out of the artifact", async () => {
    const r = await run(1);
    const app = (r.application as TSAnalysis).application;
    const art = Object.values(app.artifacts).find((a) => a.path === "compose.yaml")!;
    expect(art).toBeDefined();
    const key = art.config_keys.find((k) => k.key === "nested.key")!;
    expect(key.span).toBeDefined();
    expect(sliceBytes(art.source, key.span!.bytes)).toContain("值");
  });

  test("consumers that need compiler positions still resolve: config_use literal tier past multibyte text", async () => {
    const r = await run(2);
    const app = (r.application as TSAnalysis).application;
    // greet reads process.env["API_KEY"], declared in .env → one resolved use, no unresolved read
    expect(app.config_uses.length).toBe(1);
    expect(app.config_reads.length).toBe(0);
  });
});

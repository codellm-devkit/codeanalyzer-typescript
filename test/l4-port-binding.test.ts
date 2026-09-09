/**
 * #81 / #80 (python #115 parity): the L4 port lattice is wired INTO the statement-level ddg.
 * Before this, one of four binding classes existed (`stmt → @formal_out`), so an end-to-end
 * flows_to walk could cross a call only on the return leg: a caller's definition never reached
 * `actual_in`, `actual_out` never reached a use, and a walk entering through param_in dead-ended
 * at `formal_in`. #81's acceptance: on `y = build(x)`, all four classes exist, `reaching-defs`
 * tagged, endpoints present in `body`.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { forEachCallable } from "../src/schema";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication, TSCallable } from "../src/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-l4port-"));
fs.mkdirSync(path.join(dir, "src"));
fs.writeFileSync(path.join(dir, "src", "a.ts"), [
  "export function build(x: number): number {",
  "  const t = x + 1;",          // formal_in:0 → this statement (first use of x)
  "  return t;",                  // this statement → @formal_out
  "}",
  "export function main(): number {",
  "  const a = 1;",               // def a
  "  const y = build(a);",        // def a → <L>/actual_in:0 ; <L>/actual_out → L
  "  return y;",                  // L → this statement (existing intra edge)
  "}",
].join("\n"));
fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["src/**/*.ts"] }));
const opts = (analysisLevel: number) => ({ input: dir, appName: "pb", analysisLevel, eager: true, noBuild: true, emit: "json",
  graphs: ["cfg", "dfg", "pdg", "sdg"], graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true, entrypointRules: null }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;
type Ddg = { src: string; dst: string; var?: string; prov?: string[] };
function fn(root: TSApplication, name: string): TSCallable { let out: TSCallable | undefined; for (const m of Object.values(root.symbol_table)) forEachCallable(m, (c) => { if (c.name === name) out = c; }); if (!out) throw new Error(name); return out; }
const kindOf = (c: TSCallable, key: string) => c.body?.[key]?.kind ?? c.body?.[key.replace(/^@/, "")]?.kind;

describe("L4 port lattice ↔ statement ddg (#81)", () => {
  test("all four binding classes exist on y = build(x), reaching-defs tagged, endpoints in body", async () => {
    const root = rootOf(await analyze(opts(4)));
    const build = fn(root, "build"), main = fn(root, "main");
    const bd = (build.ddg ?? []) as Ddg[], md = (main.ddg ?? []) as Ddg[];
    const rd = (e: Ddg) => (e.prov ?? []).includes("reaching-defs");

    // (1) formal_in:0 → first-use statement inside the callee
    const fi = bd.filter((e) => e.src === "@formal_in:0" && rd(e));
    expect(fi.length).toBeGreaterThan(0);
    for (const e of fi) { expect(kindOf(build, e.dst)).toBe("statement"); expect(e.var).toBe("x"); }
    // (2) return statement → @formal_out (pre-existing class, still present)
    expect(bd.some((e) => e.dst === "@formal_out" && rd(e) && kindOf(build, e.src) === "statement")).toBe(true);

    // the call statement and its ports
    const L = Object.keys(main.body ?? {}).find((k) => main.body![k]!.kind === "actual_in")!.split("/")[0]!;
    expect(main.body?.[`${L}/actual_in:0`]?.kind).toBe("actual_in");
    expect(main.body?.[`${L}/actual_out`]?.kind).toBe("actual_out");
    // (3) def a → <L>/actual_in:0 — the caller's definition binds to the argument port
    const din = md.filter((e) => e.dst === `${L}/actual_in:0` && rd(e));
    expect(din.map((e) => [kindOf(main, e.src), e.var])).toEqual([["statement", "a"]]);
    // (4) <L>/actual_out → L — the return value flows into the call statement
    expect(md.some((e) => e.src === `${L}/actual_out` && e.dst === L && rd(e))).toBe(true);
    // and the pre-existing intra edge carries it on to the use
    expect(md.some((e) => e.src === L && e.var === "y")).toBe(true);

    // every endpoint of every ddg edge names a body node
    for (const c of [build, main]) for (const e of c.ddg as Ddg[]) { expect(c.body?.[e.src], `${c.name} src ${e.src}`).toBeDefined(); expect(c.body?.[e.dst], `${c.name} dst ${e.dst}`).toBeDefined(); }
  });

  test("a parameter passed straight through binds from its own port: g(x) { return build(x) }", async () => {
    fs.writeFileSync(path.join(dir, "src", "b.ts"), "import { build } from './a';\nexport function g(x: number): number { return build(x); }\n");
    const root = rootOf(await analyze(opts(4)));
    const g = fn(root, "g");
    const L = Object.keys(g.body ?? {}).find((k) => g.body![k]!.kind === "actual_in")!.split("/")[0]!;
    expect((g.ddg as Ddg[]).some((e) => e.src === "@formal_in:0" && e.dst === `${L}/actual_in:0` && e.var === "x")).toBe(true);
    fs.rmSync(path.join(dir, "src", "b.ts"));
  });

  test("additive: the L3 ddg is a subset of the L4 ddg (monotonicity holds)", async () => {
    const l3 = rootOf(await analyze(opts(3))), l4 = rootOf(await analyze(opts(4)));
    for (const name of ["build", "main"]) {
      const key = (e: Ddg) => `${e.src}|${e.dst}|${e.var ?? ""}`;
      const s4 = new Set((fn(l4, name).ddg as Ddg[]).map(key));
      for (const e of fn(l3, name).ddg as Ddg[]) expect(s4.has(key(e)), `${name}: ${key(e)}`).toBe(true);
    }
  });

  test("every param_in / param_out edge names the formal it binds (codeanalyzer-python#195)", async () => {
    const root = rootOf(await analyze(opts(4)));
    const edges = [...root.param_in, ...root.param_out];
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) expect(e.var, `${e.src} -> ${e.dst}`).toBeTruthy();
    const build = fn(root, "build");
    const pin = root.param_in.find((e) => e.dst === `${build.id}@formal_in:0`);
    expect(pin?.var).toBe("x");
    const pout = root.param_out.find((e) => e.src === `${build.id}@formal_out`);
    expect(pout?.var).toBe("$ret");
  });
});

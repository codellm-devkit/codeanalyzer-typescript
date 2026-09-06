/**
 * Framework-tier call rules and the non-web ruleset (#167). The property that matters most is the
 * NEGATIVE one: `app.on(...)` exists on every EventEmitter, so with `electron` absent from the
 * manifest the identical source must register nothing from these rules — the gate plus the
 * resolved-callee match are what keep a false positive out.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication } from "../src/schema";
import { forEachCallable } from "../src/schema";

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-nonweb-"));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["src/**/*.ts"] }));
  return dir;
}
const opts = (input: string) => ({ input, appName: "nw", analysisLevel: 1, eager: true, noBuild: true, emit: "json", graphs: ["cfg", "dfg", "pdg", "sdg"],
  graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true, entrypointRules: null }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;
const byName = (root: TSApplication) => { const o: Record<string, Array<{ rule: string; confidence: string; framework: string; route?: string; evidence?: string }>> = {}; for (const m of Object.values(root.symbol_table)) forEachCallable(m, (c) => { o[c.name] = (c.entrypoints ?? []) as never; }); return o; };

const MAIN = [
  'import { app, ipcMain as ipc } from "electron";',
  "function onReady(): void {}",
  "app.on('ready', onReady);",
  "ipc.handle('ping', (_e: unknown) => 1);",
  "app.on('error', onReady);",
].join("\n");

describe("framework-tier call rules (#167)", () => {
  test("electron: gated on the dependency, matched on the RESOLVED callee (alias included), certain", async () => {
    const dir = fixture({ "package.json": JSON.stringify({ name: "x", dependencies: { electron: "^30" } }), "src/main.ts": MAIN });
    const root = rootOf(await analyze(opts(dir)));
    expect(root.entrypoint_report.frameworks_detected).toEqual(["electron"]);
    const n = byName(root);
    // two app.on registrations of the same handler → two records, both certain, evidence resolved
    expect(n.onReady).toEqual([
      expect.objectContaining({ framework: "electron", rule: "electron.app-on", confidence: "certain", route: "ready", evidence: "electron.app.on" }),
      expect.objectContaining({ rule: "electron.app-on", route: "error" }),
    ]);
    // `ipc` is an ALIAS of ipcMain: the import table maps it back before matching
    expect(n["(anonymous)"]?.[0]).toMatchObject({ rule: "electron.ipc", confidence: "certain", route: "ping", evidence: "electron.ipcMain.handle" });
  });

  test("the gate: the identical source WITHOUT electron in the manifest registers nothing from these rules", async () => {
    const dir = fixture({ "package.json": JSON.stringify({ name: "x", dependencies: { express: "^4" } }), "src/main.ts": MAIN.replace('"electron"', '"./events"'), "src/events.ts": "export const app = { on(_e: string, _h: unknown) {} }; export const ipcMain = { handle(_c: string, _h: unknown) {} };" });
    const root = rootOf(await analyze(opts(dir)));
    expect(root.entrypoint_report.frameworks_detected).toEqual([]);
    const n = byName(root);
    expect(n.onReady).toEqual([]);          // no framework claim — and no heuristic either: `app.on` is not an HTTP verb
    expect(n["(anonymous)"] ?? []).toEqual([]);
  });

  test("commander: a chained receiver resolves through its head", async () => {
    const dir = fixture({ "package.json": JSON.stringify({ name: "x", dependencies: { commander: "^12" } }),
      "src/cli.ts": 'import { program } from "commander";\nfunction run(): void {}\nprogram.command("start").option("-v").action(run);\nprogram.parse();' });
    const n = byName(rootOf(await analyze(opts(dir))));
    expect(n.run?.[0]).toMatchObject({ framework: "commander", rule: "commander.action", confidence: "certain", evidence: 'commander.program.command("start").option("-v").action' });
  });

  test("worker_threads via node: specifier, and process.on as a dependency-free heuristic", async () => {
    const dir = fixture({ "package.json": JSON.stringify({ name: "x" }),
      "src/w.ts": 'import { parentPort } from "node:worker_threads";\nfunction onMsg(): void {}\nfunction onSig(): void {}\nparentPort.on("message", onMsg);\nprocess.on("SIGINT", onSig);' });
    const root = rootOf(await analyze(opts(dir)));
    expect(root.entrypoint_report.frameworks_detected).toEqual(["worker_threads"]);
    const n = byName(root);
    expect(n.onMsg?.[0]).toMatchObject({ framework: "worker_threads", rule: "worker_threads.parent-port", confidence: "certain", route: "message" });
    expect(n.onSig?.[0]).toMatchObject({ framework: "heuristic", rule: "heuristic.process-on", confidence: "heuristic", route: "SIGINT" });
  });

  test("never doubles: a framework call claim blocks a heuristic call record on the same handler", async () => {
    // `app.get` is the shipped heuristic Express shape; `app.on` (electron) claims `h` first.
    const dir = fixture({ "package.json": JSON.stringify({ name: "x", dependencies: { electron: "^30" } }),
      "src/m.ts": 'import { app } from "electron";\nfunction h(): void {}\napp.on("ready", h);\n(app as unknown as { get(p: string, f: unknown): void }).get("/x", h);' });
    const n = byName(rootOf(await analyze(opts(dir))));
    expect(n.h?.map((e) => e.rule)).toEqual(["electron.app-on"]);
  });
});

// test/entrypoints-invariance.test.ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication } from "../src/schema";
import { forEachCallable, forEachType } from "../src/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-epi-"));
fs.mkdirSync(path.join(dir, "src"));
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", main: "src/index.ts", dependencies: { "@nestjs/common": "^10", express: "^4" } }));
fs.writeFileSync(path.join(dir, "src", "index.ts"), [
  'import { Controller, Get } from "@nestjs/common";', 'import express from "express";',
  "@Controller('/u') export class U { @Get() list(): string { return ''; } }",
  "const app = express(); export function h(): void {} app.get('/h', h); export function boot(): void {} boot();",
].join("\n"));
fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020", experimentalDecorators: true }, include: ["src/**/*.ts"] }));
const opts = (analysisLevel: number, eager: boolean) => ({ input: dir, appName: "i", analysisLevel, eager, noBuild: true, emit: "json", graphs: ["cfg","dfg","pdg","sdg"],
  graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true, entrypointRules: null }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;
const stamped = (root: TSApplication) => { const o: Record<string, unknown> = { __report: root.entrypoint_report };
  for (const m of Object.values(root.symbol_table)) { forEachCallable(m, (c) => { o[c.id] = [c.entrypoints, c.is_entrypoint]; }); forEachType(m, (t) => { o[t.id] = [t.entrypoints, t.is_entrypoint]; }); } return o; };

describe("entrypoints are identical at every -a", () => {
  test("L1 cold, then L2-L4 warm, with every matcher kind firing", async () => {
    const l1 = stamped(rootOf(await analyze(opts(1, true))));
    expect(l1.__report).toMatchObject({ frameworks_detected: ["nestjs"], errors: [] });
    // sanity: something actually fired at each tier
    const all = JSON.stringify(l1);
    for (const rule of ["nestjs.controller", "nestjs.verb", "heuristic.http-verb-call", "manifest.main"]) expect(all).toContain(rule);
    for (const level of [2, 3, 4]) expect(stamped(rootOf(await analyze(opts(level, false))))).toEqual(l1);
  });
});

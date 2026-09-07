/**
 * #180 — finalizeAnalysis must never structuredClone the whole envelope.
 *
 * Bun's structuredClone has a hard serialization ceiling (measured on 1.3.14: a ~2.2 GiB object
 * aborts the process with no exception; a 13k-file repository hit a TypeError at 1.3.0). The
 * envelope is only cloned so the wire copy can be internal-field-stripped without touching the
 * live tree that `result.internal` hands back — and the strip only ever touches modules. So the
 * clone is per MODULE (the largest is megabytes, never gigabytes); everything else on the root is
 * shared by reference. This pins both halves: the wire is detached from and stripped relative to
 * the internal tree, and the strip never reached into the internal tree.
 */
import { describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSAnalysis } from "../src/schema";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/sample-app");
const opts = { input: FIXTURE, appName: "sa", analysisLevel: 2, noBuild: true, emit: "json", eager: true } as unknown as AnalysisOptions;

describe("#180 finalize clones per module", () => {
  test("structuredClone is called once per module and never on the envelope or the root", async () => {
    const spy = spyOn(globalThis, "structuredClone");
    try {
      const r = await analyze(opts);
      const modules = Object.keys(r.internal.symbol_table).length;
      const cloned = spy.mock.calls.map((c) => c[0] as Record<string, unknown>);
      expect(cloned.length).toBe(modules);
      for (const arg of cloned) {
        expect(arg.kind).toBe("module");
        expect(arg.schema_version).toBeUndefined();
        expect(arg.symbol_table).toBeUndefined();
      }
    } finally {
      spy.mockRestore();
    }
  });

  test("every wire module is a distinct object from its internal twin, stripped, with the twin intact", async () => {
    const r = await analyze(opts);
    const wire = (r.application as TSAnalysis).application;
    const keys = Object.keys(wire.symbol_table);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const w = wire.symbol_table[k] as unknown as Record<string, unknown>;
      const i = r.internal.symbol_table[k] as unknown as Record<string, unknown>;
      expect(w).not.toBe(i);
      // the strip landed on the wire...
      expect(w.call_sites).toBeUndefined();
      expect(w.last_modified).toBeUndefined();
      expect(w.file_size).toBeUndefined();
      expect(w.content_hash).toBe(i.content_hash); // #118: content_hash stays on the wire
      // ...and only on the wire: the live tree still carries the per-run join fields
      expect(Array.isArray(i.call_sites)).toBe(true);
      expect(typeof i.last_modified).toBe("number");
    }
    // a module with callables: the callable-level strip detached too
    const mod = wire.symbol_table["src/services.ts"]!;
    const fn = Object.values(mod.types)[0]!.callables ? Object.values(Object.values(mod.types)[0]!.callables!)[0] : undefined;
    expect(fn).toBeDefined();
    expect((fn as unknown as Record<string, unknown>).call_sites).toBeUndefined();
    expect((fn as unknown as Record<string, unknown>).abs_path).toBeUndefined();
  });

  test("the wire survives a JSON roundtrip identical to itself (no shared-reference surprise)", async () => {
    const r = await analyze(opts);
    const once = JSON.stringify(r.application);
    // mutating the internal tree after finalize must not leak into an already-finalized wire
    delete (r.internal.symbol_table["src/index.ts"] as unknown as Record<string, unknown>).functions;
    expect(JSON.stringify(r.application)).toBe(once);
  });
});

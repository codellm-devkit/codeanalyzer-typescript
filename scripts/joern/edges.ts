/** Ledger helper (#98): print the analyzer's L2 signature-level edge set + signature universe
 * for a target app as JSON — consumed by compare_joern.py. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../../src/core";
import { forEachCallable } from "../../src/schema";
import type { AnalysisOptions } from "../../src/options";

const input = path.resolve(process.argv[2] as string);
const opts = {
  input, output: null, emit: "json", appName: null, neo4jUri: null, neo4jUser: "neo4j",
  neo4jPassword: "", neo4jDatabase: null, analysisLevel: 2, graphs: [], graphFieldDepth: 3,
  jobs: 1, targetFiles: null, skipTests: true, eager: true, noBuild: true, phantoms: true,
  cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), verbosity: 0,
} as AnalysisOptions;
const r = await analyze(opts);
const sigs: string[] = [];
for (const [fileKey, mod] of Object.entries(r.internal.symbol_table)) {
  sigs.push(fileKey.replace(/\.d\.ts$/, "").replace(/\.(tsx|ts|jsx|js|mts|cts|mjs|cjs)$/, ""));
  forEachCallable(mod, (c) => sigs.push(c.signature));
}
process.stdout.write(JSON.stringify({ edges: r.internal.call_graph.map((e) => [e.source, e.target]), sigs }));

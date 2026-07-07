import * as fs from "node:fs";
import * as path from "node:path";
import { boltWriter, buildSchemaDocument, project, renderCypher } from "../build/neo4j";
import type { AnalysisOptions } from "../options";
import type { TSApplication } from "../schema";
import { toV2, toV2Detailed } from "../schema/v2";
import { Logger } from "./logging";

/**
 * The only facade-visible artifact. Two output targets:
 *  - json (default): with no -o, print compact JSON to stdout (the SDK reads stdout); with -o,
 *    write `<output>/analysis.json`.
 *  - neo4j: project the IR to a graph. With --neo4j-uri, push incrementally to a live DB over
 *    Bolt; otherwise write a self-contained `<output>/graph.cypher` snapshot.
 */
export async function emit(app: TSApplication, opts: AnalysisOptions): Promise<void> {
  if (opts.emit === "neo4j") {
    await emitNeo4j(app, opts);
    return;
  }
  // schema v2: reshape the v1 model into the canonical additive-CPG tree before serializing.
  const out = toV2(app, opts);
  if (opts.output === null) {
    process.stdout.write(JSON.stringify(out));
    return;
  }
  fs.mkdirSync(opts.output, { recursive: true });
  fs.writeFileSync(path.join(opts.output, "analysis.json"), JSON.stringify(out));
}

/**
 * Emit the Neo4j schema contract (schema.json) — a static artifact derived from the in-repo
 * schema, independent of any analyzed project. With no -o it prints to stdout.
 */
export function emitSchema(opts: AnalysisOptions): void {
  const doc = `${JSON.stringify(buildSchemaDocument(), null, 2)}\n`;
  if (opts.output === null) {
    process.stdout.write(doc);
    return;
  }
  fs.mkdirSync(opts.output, { recursive: true });
  fs.writeFileSync(path.join(opts.output, "schema.json"), doc);
}

async function emitNeo4j(app: TSApplication, opts: AnalysisOptions): Promise<void> {
  // Second projection of the SAME v2 tree the JSON path emits. --emit neo4j forces full depth
  // (cli.ts), so `app` carries the L4 dataflow and the projected graph is the complete CPG.
  const { application } = toV2Detailed(app, opts);
  const appId = application.application.id;
  const rows = project(application, appId);

  if (opts.neo4jUri) {
    const log = new Logger(opts.verbosity);
    await boltWriter(
      rows,
      {
        uri: opts.neo4jUri,
        user: opts.neo4jUser,
        password: opts.neo4jPassword,
        database: opts.neo4jDatabase,
      },
      log,
      opts.targetFiles === null, // full run ⇒ orphan pruning is safe
    );
    return;
  }

  const dir = opts.output ?? process.cwd();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "graph.cypher"), renderCypher(rows, appId));
}

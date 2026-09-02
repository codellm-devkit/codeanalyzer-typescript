import * as fs from "node:fs";
import * as path from "node:path";
import { boltWriter, buildSchemaDocument, project, renderCypher } from "../build/neo4j";
import type { AnalysisOptions } from "../options";
import type { TSAnalysis } from "../schema";
import { Logger } from "./logging";

/**
 * The only facade-visible artifact. Two output targets:
 *  - json (default): with no -o, print compact JSON to stdout (the SDK reads stdout); with -o,
 *    write `<output>/analysis.json`.
 *  - neo4j: project the IR to a graph. With --neo4j-uri, push incrementally to a live DB over
 *    Bolt; otherwise write a self-contained `<output>/graph.cypher` snapshot.
 */
export async function emit(application: TSAnalysis, opts: AnalysisOptions): Promise<void> {
  if (opts.emit === "neo4j") {
    await emitNeo4j(application, opts);
    return;
  }
  // The envelope IS the wire (finalizeAnalysis already stripped the internal fields) — write it.
  if (opts.output === null) {
    process.stdout.write(JSON.stringify(application));
    return;
  }
  fs.mkdirSync(opts.output, { recursive: true });
  writeAnalysisJson(path.join(opts.output, "analysis.json"), application);
}

/**
 * Write the envelope WITHOUT ever holding it as one string (#112).
 *
 * `JSON.stringify(application)` materialises the entire output before a byte is written, so peak
 * memory carries the tree AND its serialisation at once, and a large enough analysis exceeds the
 * runtime's maximum string length outright: vscode at -a 4 dies with `RangeError: Out of memory`
 * in stringify after the analysis itself has completed successfully.
 *
 * The envelope's shape is fixed and its two unbounded members are `symbol_table` (keyed by module)
 * and the application-scope edge arrays, so both are streamed element by element. Each element is
 * still stringified individually — bounded by the largest single module, not by the whole repo.
 * Output is byte-identical to the previous whole-string write.
 */
function writeAnalysisJson(file: string, envelope: TSAnalysis): void {
  const fd = fs.openSync(file, "w");
  const put = (chunk: string): void => {
    fs.writeSync(fd, chunk);
  };
  try {
    const { application: app, ...head } = envelope as unknown as Record<string, unknown>;
    const root = app as Record<string, unknown>;

    // envelope head — every key except `application`
    put("{");
    for (const [k, v] of Object.entries(head)) put(`${JSON.stringify(k)}:${JSON.stringify(v)},`);
    put(`"application":{`);

    // Walk the application's keys in INSERTION ORDER so the bytes match what JSON.stringify
    // produced; only the two unbounded members stream, everything else is small.
    let firstKey = true;
    for (const [k, v] of Object.entries(root)) {
      if (v === undefined) continue;
      if (!firstKey) put(",");
      firstKey = false;
      put(`${JSON.stringify(k)}:`);
      if (k === "symbol_table" && v && typeof v === "object") {
        put("{");
        let first = true;
        for (const [key, mod] of Object.entries(v as Record<string, unknown>)) {
          if (!first) put(",");
          first = false;
          put(`${JSON.stringify(key)}:${JSON.stringify(mod)}`);
        }
        put("}");
      } else if (Array.isArray(v)) {
        put("[");
        for (let i = 0; i < v.length; i++) {
          if (i) put(",");
          put(JSON.stringify(v[i]));
        }
        put("]");
      } else {
        put(JSON.stringify(v));
      }
    }
    put("}}");
  } finally {
    fs.closeSync(fd);
  }
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

async function emitNeo4j(application: TSAnalysis, opts: AnalysisOptions): Promise<void> {
  // Second projection of the SAME v2 envelope the JSON path emits. --emit neo4j forces full depth
  // (cli.ts), so the envelope carries the L4 dataflow and the projected graph is the complete CPG.
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
      opts.eager, // --eager ⇒ purge this app's graph and rebuild; otherwise never delete
    );
    return;
  }

  const dir = opts.output ?? process.cwd();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "graph.cypher"), renderCypher(rows, appId));
}

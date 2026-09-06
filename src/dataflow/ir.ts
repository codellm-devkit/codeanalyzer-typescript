/**
 * Shard IR persistence (#112 step 4, unit 2) — what wave 2 reads.
 *
 * The two-wave design rests on one fact: the cross-shard interprocedural stitch needs NO tsc state.
 * On vscode/src at `-a 4`, 21.33 GB is already committed before the interprocedural phase starts,
 * while that phase's entire retained state is 0.48 GB (`datas` 0.34, `ddg` 0.09, `summaries` 0.05).
 * So if wave 1 writes its graph IR down, wave 2 can redo the cross-shard fixpoint over ~1 GB of
 * data instead of paying the 21 GB parse/bind/check cost again.
 *
 * Written as NDJSON, one record per line, deliberately: `JSON.stringify` on the whole IR would
 * build a single multi-hundred-megabyte string — the same emit-time wall #112 lists as ceiling 3.
 * NDJSON streams out and streams back in, and a reader can skip record kinds it does not need.
 *
 * The header pins every input that would silently corrupt a union if it differed between shards:
 * `can://` ids embed `--input` and `--app-name`, and summaries are only comparable at one
 * `k_limit`. A mismatch is an error at load, never a merge.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CallableGraphData } from "./model";
import type { CallSiteRef, FunctionSummary } from "./summaries";
import type { AnalysisOptions } from "../options";
import type { Logger } from "../utils";
import { PROGRAM_GRAPHS_SCHEMA_VERSION } from "../schema/graphs";

export const IR_FILENAME = "graphs_ir.ndjson";

/** Identity of the run that produced a shard's IR. Every field must match across shards. */
export interface IrHeader {
  kind: "header";
  ir_version: string;
  schema_version: string;
  k_limit: number;
  app_name: string;
  /** Absolute input root — `can://` file keys are relative to it, so shards must share one. */
  input: string;
  /** Programs this shard analysed (scope names, as `--program` takes them). */
  programs: string[];
}

/**
 * IR record version. Separate from PROGRAM_GRAPHS_SCHEMA_VERSION because this file now has a
 * READER and therefore a cross-run contract of its own: the wire shape of `CallableGraphData` can
 * change without the emitted program-graphs schema changing, and vice versa.
 */
export const IR_VERSION = "1.0.0";

export type IrRecord =
  | IrHeader
  | { kind: "callable"; sig: string; data: CallableGraphData }
  | { kind: "callsites"; sig: string; sites: CallSiteRef[] }
  | { kind: "summary"; sig: string; summary: FunctionSummary };

export function irPath(opts: AnalysisOptions): string {
  return path.join(opts.cacheDir ?? path.join(opts.input, ".codeanalyzer"), IR_FILENAME);
}

/**
 * Write this shard's IR. Streams record-by-record through an fd rather than joining, so peak stays
 * flat regardless of callable count.
 */
export function writeIr(
  opts: AnalysisOptions,
  programs: string[],
  datas: Map<string, CallableGraphData>,
  callSites: Map<string, CallSiteRef[]>,
  summaries: Map<string, FunctionSummary>,
  log: Logger,
): void {
  const file = irPath(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  try {
    const write = (r: IrRecord): void => {
      fs.writeSync(fd, `${JSON.stringify(r)}\n`);
    };
    write({
      kind: "header",
      ir_version: IR_VERSION,
      schema_version: PROGRAM_GRAPHS_SCHEMA_VERSION,
      k_limit: opts.graphFieldDepth,
      app_name: opts.appName ?? "",
      input: opts.input,
      programs,
    });
    // Sorted so a shard's IR is byte-reproducible across runs (the equivalence test compares files).
    for (const sig of [...datas.keys()].sort()) write({ kind: "callable", sig, data: datas.get(sig) as CallableGraphData });
    for (const sig of [...callSites.keys()].sort()) write({ kind: "callsites", sig, sites: callSites.get(sig) as CallSiteRef[] });
    for (const sig of [...summaries.keys()].sort()) write({ kind: "summary", sig, summary: summaries.get(sig) as FunctionSummary });
    log.info(`ir: wrote ${datas.size} callables to ${path.basename(file)}`);
  } finally {
    fs.closeSync(fd);
  }
}

export interface LoadedIr {
  header: IrHeader;
  datas: Map<string, CallableGraphData>;
  callSites: Map<string, CallSiteRef[]>;
  summaries: Map<string, FunctionSummary>;
}

/** Read one shard's IR. Line-by-line, so a large shard never becomes one string. */
export function readIr(file: string): LoadedIr {
  const datas = new Map<string, CallableGraphData>();
  const callSites = new Map<string, CallSiteRef[]>();
  const summaries = new Map<string, FunctionSummary>();
  let header: IrHeader | null = null;

  // Split on newlines from a single read: records are individually small, and Bun has no
  // synchronous line reader. The file is IR, not output — if it ever outgrows this, the reader
  // becomes a stream without changing the format.
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const rec = JSON.parse(line) as IrRecord;
    if (rec.kind === "header") header = rec;
    else if (rec.kind === "callable") datas.set(rec.sig, rec.data);
    else if (rec.kind === "callsites") callSites.set(rec.sig, rec.sites);
    else if (rec.kind === "summary") summaries.set(rec.sig, rec.summary);
  }
  if (!header) throw new Error(`${file}: no IR header record`);
  if (header.ir_version !== IR_VERSION) {
    throw new Error(`${file}: IR version ${header.ir_version}, expected ${IR_VERSION} — re-run wave 1`);
  }
  return { header, datas, callSites, summaries };
}

/**
 * Every shard must come from one logical run. `can://` ids embed the input root and app name, and
 * summaries only compose at a single `k_limit`, so a divergence here does not produce a partial
 * union — it produces a WRONG one, silently. Hence an error rather than a warning.
 */
export function assertCompatible(shards: LoadedIr[]): void {
  const [first, ...rest] = shards;
  if (!first) throw new Error("no shard IR to stitch");
  for (const s of rest) {
    for (const k of ["ir_version", "schema_version", "k_limit", "app_name", "input"] as const) {
      if (s.header[k] !== first.header[k]) {
        throw new Error(
          `shard mismatch on ${k}: ${JSON.stringify(first.header[k])} vs ${JSON.stringify(s.header[k])} — ` +
            `every shard must share --input, --app-name and --graph-field-depth`,
        );
      }
    }
  }
}

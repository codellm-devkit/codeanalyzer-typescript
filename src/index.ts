#!/usr/bin/env node
import { analyze, discoverPrograms } from "./core";
import { parseArgs } from "./cli";
import { emit, emitSchema } from "./utils";

async function main(): Promise<void> {
  try {
    const opts = parseArgs(process.argv.slice(2));
    // The schema contract is a static artifact — no project analysis required.
    if (opts.emit === "schema") {
      emitSchema(opts);
      return;
    }
    if (opts.listPrograms) {
      for (const name of discoverPrograms(opts)) process.stdout.write(`${name}\n`);
      return;
    }
    const result = await analyze(opts);
    await emit(result.application, opts);
  } catch (e) {
    const err = e as Error;
    process.stderr.write(`[codeanalyzer-ts] FATAL ${err.stack ?? err.message}\n`);
    process.exit(1);
  }
}

void main();

/**
 * #181 — a missing or non-directory `--input` is an error, not an empty application.
 *
 * Discovery used to swallow the `readdir` failure and return no files, so the analyzer wrote a
 * schema-valid `analysis.json` describing an empty application (its id derived from a path that
 * was never read) and exited 0. A consumer running this as a subprocess has only the exit code
 * as a cheap health signal, and "the input did not exist" must never read as "this project has
 * no analysable sources".
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InputError, analyze, discoverPrograms } from "../src/core";
import type { AnalysisOptions } from "../src/options";

const ROOT = path.resolve(import.meta.dir, "..");
const MISSING = path.join(os.tmpdir(), "cants-181-does-not-exist");
const FILE = path.join(os.tmpdir(), "cants-181-a-file.ts");
fs.writeFileSync(FILE, "export const x = 1;");

function cli(args: string[]): { code: number; stderr: string } {
  const p = Bun.spawnSync(["bun", "run", path.join(ROOT, "src/index.ts"), ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stderr: p.stderr.toString() };
}

describe("#181 input path", () => {
  test("analyze() refuses a nonexistent input with a usage error naming the path", async () => {
    const opts = { input: MISSING, appName: "x", analysisLevel: 1, noBuild: true, emit: "json" } as unknown as AnalysisOptions;
    await expect(analyze(opts)).rejects.toBeInstanceOf(InputError);
    await expect(analyze(opts)).rejects.toThrow(MISSING);
  });

  test("a file, not a directory, is refused the same way", async () => {
    const opts = { input: FILE, appName: "x", analysisLevel: 1, noBuild: true, emit: "json" } as unknown as AnalysisOptions;
    await expect(analyze(opts)).rejects.toBeInstanceOf(InputError);
  });

  test("--list-programs refuses too (it walks the same root)", () => {
    expect(() => discoverPrograms({ input: MISSING, verbosity: 0 } as unknown as AnalysisOptions)).toThrow(InputError);
  });

  test("CLI: exit 1, one-line message, no FATAL, and nothing written", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "cants-181-out-"));
    fs.rmSync(out, { recursive: true });
    const r = cli(["-i", MISSING, "-o", out]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("[codeanalyzer-ts]");
    expect(r.stderr).toContain(MISSING);
    expect(r.stderr).not.toContain("FATAL");
    expect(fs.existsSync(path.join(out, "analysis.json"))).toBe(false);
  });

  test("CLI: an empty but real directory is a real answer — exit 0, empty symbol table", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cants-181-empty-"));
    const out = path.join(empty, "out");
    const r = cli(["-i", empty, "-o", out, "-a", "1", "--no-build", "--app-name", "e"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(fs.readFileSync(path.join(out, "analysis.json"), "utf8"));
    expect(j.application.symbol_table).toEqual({});
  });
});

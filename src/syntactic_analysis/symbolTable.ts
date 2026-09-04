import * as path from "node:path";
import { Project, ts } from "ts-morph";
import { buildModule } from "./builders";
import { fileMeta, fileUnchanged, relPosix, sha256 } from "../utils";
import type { CacheData } from "../utils/cache";
import { discoverSourceFiles, resolveTargetFiles, type DiscoveredFile } from "./discovery";
import type { Materialization, ProgramSpec } from "../build";
import type { AnalysisOptions } from "../options";
import type { Node } from "ts-morph";
import type { TSModule } from "../schema";
import type { Logger } from "../utils";

/** One constructed ts-morph program plus the symbol-table keys (fileKeys) it owns. */
export interface BuiltProgram {
  project: Project;
  fileKeys: Set<string>;
  // The tsconfig this program was built from (null = default options) — the owning config for
  // every file in `fileKeys`. This is the file→program config map the L3 workers would thread.
  configPath: string | null;
  /** Stable cache key and hash of the complete TypeScript compiler program. */
  contextKey: string;
  contextHash: string;
}

export interface SymbolTableResult {
  // The ROOT program's Project — single-program consumers keep working unchanged.
  project: Project;
  symbol_table: Record<string, TSModule>;
  files: DiscoveredFile[];
  // One entry per discovered program (deepest scope first, root last).
  programs: BuiltProgram[];
  /** Context hashes persisted with cached modules and validated on the next run. */
  programContexts: Record<string, string>;
}

/** Is `file` inside `dir` (or is `dir` the file's own directory)? */
function contains(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The program that owns `absPath`: the DEEPEST program whose scope dir contains it. `programs` is
 * ordered deepest-first with the root program last, so the first containing program wins and the
 * root program is the guaranteed fallback.
 */
function ownerProgram(absPath: string, programs: ProgramSpec[]): ProgramSpec {
  for (const p of programs) if (contains(p.scopeDir, absPath)) return p;
  return programs[programs.length - 1]!; // root program is a universal ancestor; unreachable fallback
}

export function buildSymbolTable(
  opts: AnalysisOptions,
  mat: Materialization,
  cached: CacheData | null,
  log: Logger,
): SymbolTableResult {
  const root = opts.input;
  const specs = mat.programs;

  const targets = opts.targetFiles ? resolveTargetFiles(root, opts.targetFiles) : null;
  const allProjectFiles = discoverSourceFiles(root, opts.skipTests);
  // The set of files to BUILD (targets in -t mode, else all).
  const buildFiles = targets ?? allProjectFiles;

  // Assign every discovered file to exactly one program (deepest scope wins), then construct one
  // Project per program from ONLY its files — so each file resolves under the tsconfig that governs
  // it (module resolution, `paths` aliases, lib) instead of a single root program swallowing all.
  const assignment = new Map<ProgramSpec, DiscoveredFile[]>();
  for (const s of specs) assignment.set(s, []);
  for (const f of allProjectFiles) assignment.get(ownerProgram(f.absPath, specs))!.push(f);

  const projectOf = new Map<ProgramSpec, Project>();
  const contextOf = new Map<ProgramSpec, { key: string; hash: string }>();
  const programs: BuiltProgram[] = [];
  for (const s of specs) {
    const project = createProject(s.configPath);
    const files = assignment.get(s)!;
    const fileKeys = new Set<string>();
    for (const f of files) {
      fileKeys.add(f.fileKey);
      try {
        project.addSourceFileAtPath(f.absPath);
      } catch (e) {
        log.warn(`failed to load ${f.fileKey}: ${(e as Error).message}`);
      }
    }
    const contextKey = s.configPath ? relPosix(root, s.configPath) : "<default>";
    const contextHash = programContextHash(project);
    projectOf.set(s, project);
    contextOf.set(s, { key: contextKey, hash: contextHash });
    programs.push({ project, fileKeys, configPath: s.configPath, contextKey, contextHash });
    log.info(`program: ${s.configPath ? path.relative(root, s.configPath) : "default"} (${files.length} files)`);
  }

  const symbol_table: Record<string, TSModule> = {};
  let built = 0;
  let fromCache = 0;
  for (const f of buildFiles) {
    const owner = ownerProgram(f.absPath, specs);
    const context = contextOf.get(owner);
    const contextMatches = context && cached?.program_contexts?.[context.key] === context.hash;
    if (contextMatches && !opts.eager && cached?.symbol_table[f.fileKey] && fileUnchanged(f.absPath, cached.symbol_table[f.fileKey])) {
      symbol_table[f.fileKey] = cached.symbol_table[f.fileKey];
      fromCache++;
      continue;
    }
    const sf = projectOf.get(owner)!.getSourceFile(f.absPath);
    if (!sf) continue;
    const mod = buildModule(sf as unknown as Node, root);
    const meta = fileMeta(f.absPath);
    mod.content_hash = meta.content_hash;
    mod.last_modified = meta.last_modified;
    mod.file_size = meta.file_size;
    symbol_table[f.fileKey] = mod;
    built++;
  }
  log.info(`symbol table: ${built} built, ${fromCache} cached, ${Object.keys(symbol_table).length} modules`);

  // The root program is always last; its Project is the one legacy single-program consumers expect.
  const rootProject = projectOf.get(specs[specs.length - 1]!)!;
  const programContexts = Object.fromEntries(
    programs.map((program) => [program.contextKey, program.contextHash]),
  );
  return { project: rootProject, symbol_table, files: buildFiles, programs, programContexts };
}

/** Hash every source file and compiler option that TypeScript admitted to this program. */
function programContextHash(project: Project): string {
  const files = project.getProgram().compilerObject.getSourceFiles()
    .map((source) => `${source.fileName}\0${sha256(source.text)}`)
    .sort();
  return sha256(JSON.stringify({ compilerOptions: project.getCompilerOptions(), files }));
}

/** The fallback compiler options when the target has no tsconfig (shared with graph workers). */
/**
 * THE ts-morph Project constructor — every program in the analyzer comes from here.
 *
 * `allowJs` is forced on over whatever the tsconfig says. Discovered `.js` files are added to the
 * program that owns their PATH (JS source discovery, #98), regardless of that config's `include`,
 * and a JS file sitting in a program whose options exclude it has no valid checker state: resolving
 * any identifier inside it throws inside tsc instead of returning undefined. A TypeScript project's
 * tsconfig normally leaves `allowJs` unset — which means false — so this is the ordinary case, not
 * a corner one. It cost vscode its entire call graph (see schema/checker.ts). The override merges:
 * `allowJs` is the only option it changes, every other tsconfig setting survives.
 */
export function createProject(configPath: string | null): Project {
  return configPath
    ? new Project({ tsConfigFilePath: configPath, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } })
    : new Project({ compilerOptions: defaultCompilerOptions() });
}

export function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    strict: false,
    skipLibCheck: true,
    esModuleInterop: true,
  };
}

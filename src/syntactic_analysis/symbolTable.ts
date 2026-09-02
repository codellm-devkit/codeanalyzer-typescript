import * as path from "node:path";
import { Project, ts } from "ts-morph";
import { buildModule } from "./builders";
import { fileMeta, fileUnchanged } from "../utils";
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
}

export interface SymbolTableResult {
  // The root Project is absent only on a complete warm Level-1 hit; Levels 2–4 always receive it.
  project: Project | undefined;
  symbol_table: Record<string, TSModule>;
  files: DiscoveredFile[];
  // Deepest scope first and root last; empty only with the Project-free Level-1 fast path.
  programs: BuiltProgram[];
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
  cached: Record<string, TSModule> | null,
  log: Logger,
): SymbolTableResult {
  const root = opts.input;
  const specs = mat.programs;

  const targets = opts.targetFiles ? resolveTargetFiles(root, opts.targetFiles) : null;
  const allProjectFiles = discoverSourceFiles(root, opts.skipTests);
  // The set of files to BUILD (targets in -t mode, else all).
  const buildFiles = targets ?? allProjectFiles;

  const reusable = new Map<string, TSModule>();
  if (cached && !opts.eager) {
    for (const file of buildFiles) {
      const cachedModule = cached[file.fileKey];
      if (cachedModule && fileUnchanged(file.absPath, cachedModule)) {
        reusable.set(file.fileKey, cachedModule);
      }
    }
  }

  // Assign every discovered file to exactly one program (deepest scope wins), then construct one
  // Project per program from ONLY its files — so each file resolves under the tsconfig that governs
  // it (module resolution, `paths` aliases, lib) instead of a single root program swallowing all.
  const assignment = new Map<ProgramSpec, DiscoveredFile[]>();
  for (const s of specs) assignment.set(s, []);
  for (const f of allProjectFiles) assignment.get(ownerProgram(f.absPath, specs))!.push(f);

  if (
    opts.analysisLevel === 1 &&
    cached !== null &&
    !opts.eager &&
    reusable.size === buildFiles.length
  ) {
    const symbol_table: Record<string, TSModule> = {};
    for (const file of buildFiles) symbol_table[file.fileKey] = reusable.get(file.fileKey)!;
    for (const spec of specs) {
      const files = assignment.get(spec)!;
      log.info(
        `program: ${spec.configPath ? path.relative(root, spec.configPath) : "default"} (${files.length} files)`,
      );
    }
    log.info(`symbol table: 0 built, ${buildFiles.length} cached, ${buildFiles.length} modules`);
    return { project: undefined, symbol_table, files: buildFiles, programs: [] };
  }

  const projectOf = new Map<ProgramSpec, Project>();
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
    projectOf.set(s, project);
    programs.push({ project, fileKeys, configPath: s.configPath });
    log.info(`program: ${s.configPath ? path.relative(root, s.configPath) : "default"} (${files.length} files)`);
  }

  const symbol_table: Record<string, TSModule> = {};
  let built = 0;
  let fromCache = 0;
  for (const f of buildFiles) {
    const cachedModule = reusable.get(f.fileKey);
    if (cachedModule) {
      symbol_table[f.fileKey] = cachedModule;
      fromCache++;
      continue;
    }
    const sf = projectOf.get(ownerProgram(f.absPath, specs))!.getSourceFile(f.absPath);
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
  return { project: rootProject, symbol_table, files: buildFiles, programs };
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

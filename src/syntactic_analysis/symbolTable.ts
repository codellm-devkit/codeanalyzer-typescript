import { Project, ts } from "ts-morph";
import { buildModule } from "./builders";
import { fileMeta, fileUnchanged } from "../utils";
import { discoverSourceFiles, resolveTargetFiles, type DiscoveredFile } from "./discovery";
import type { Materialization } from "../build";
import type { AnalysisOptions } from "../options";
import type { Node } from "ts-morph";
import type { TSModule } from "../schema";
import type { Logger } from "../utils";

export interface SymbolTableResult {
  project: Project;
  symbol_table: Record<string, TSModule>;
  files: DiscoveredFile[];
}

export function buildSymbolTable(
  opts: AnalysisOptions,
  mat: Materialization,
  cached: Record<string, TSModule> | null,
  log: Logger,
): SymbolTableResult {
  const root = opts.input;
  const project = mat.tsConfigFilePath
    ? new Project({ tsConfigFilePath: mat.tsConfigFilePath, skipAddingFilesFromTsConfig: true })
    : new Project({ compilerOptions: defaultCompilerOptions() });

  const targets = opts.targetFiles ? resolveTargetFiles(root, opts.targetFiles) : null;
  const allProjectFiles = discoverSourceFiles(root, opts.skipTests);
  // The set of files to BUILD (targets in -t mode, else all).
  const buildFiles = targets ?? allProjectFiles;
  // Add ALL project files to the program so cross-file resolution works even in -t mode.
  for (const f of allProjectFiles) {
    try {
      project.addSourceFileAtPath(f.absPath);
    } catch (e) {
      log.warn(`failed to load ${f.fileKey}: ${(e as Error).message}`);
    }
  }

  const symbol_table: Record<string, TSModule> = {};
  let built = 0;
  let fromCache = 0;
  for (const f of buildFiles) {
    if (cached && !opts.eager && cached[f.fileKey] && fileUnchanged(f.absPath, cached[f.fileKey])) {
      symbol_table[f.fileKey] = cached[f.fileKey];
      fromCache++;
      continue;
    }
    const sf = project.getSourceFile(f.absPath);
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
  return { project, symbol_table, files: buildFiles };
}

/** The fallback compiler options when the target has no tsconfig (shared with graph workers). */
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

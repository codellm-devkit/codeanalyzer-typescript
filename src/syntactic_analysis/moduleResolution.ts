/**
 * `resolved_module` on every import / re-export binding (#182; python `resolve_imports` parity).
 *
 * A PER-RUN stamp, never a build-time fact: the answer depends on state the content-hash cache
 * cannot see — the owning tsconfig (`paths`, `baseUrl`, `moduleResolution`) and whether the target
 * file exists — so an importer that is byte-identical across runs still needs re-resolving. Every
 * module, cached or freshly built, is re-stamped here: set when the specifier resolves to a file
 * inside the project root, DELETED otherwise, so a value from an older run never survives.
 *
 * `ts.resolveModuleName` rather than ts-morph's `getModuleSpecifierSourceFile()`: the latter goes
 * through the module SYMBOL, which a side-effect-imported script with no import/export of its own
 * never has (`import "./polyfill"` would come back unresolved). The compiler's resolver answers
 * every specifier the way tsc itself does, under the importer's own program.
 */
import type { Project } from "ts-morph";
import { ts } from "ts-morph";
import { type TSModule, fileKeyOf } from "../schema";

interface Binding {
  module?: string;
  resolved_module?: string;
}

export function stampResolvedModules(
  symbol_table: Record<string, TSModule>,
  files: Array<{ absPath: string; fileKey: string }>,
  projectOf: (absPath: string) => Project,
  root: string,
): void {
  // One resolution cache per program (a repository's imports repeat the same few hundred
  // specifiers from the same few directories, and every miss is several stat calls).
  const caches = new Map<Project, ts.ModuleResolutionCache>();
  for (const f of files) {
    const mod = symbol_table[f.fileKey];
    if (!mod) continue;
    const project = projectOf(f.absPath);
    let cache = caches.get(project);
    if (!cache) {
      const host = project.getModuleResolutionHost();
      cache = ts.createModuleResolutionCache(host.getCurrentDirectory?.() ?? root, (x) => x, project.getCompilerOptions());
      caches.set(project, cache);
    }
    const stamp = (b: Binding): void => {
      const key = b.module === undefined ? undefined : resolve(b.module, f.absPath, project, cache!, root);
      if (key === undefined) delete b.resolved_module;
      else b.resolved_module = key;
    };
    for (const im of mod.imports ?? []) stamp(im);
    for (const ex of mod.exports ?? []) stamp(ex);
  }
}

/** The project-relative file key the specifier resolves to, or undefined for anything external. */
function resolve(spec: string, importer: string, project: Project, cache: ts.ModuleResolutionCache, root: string): string | undefined {
  const hit = ts.resolveModuleName(spec, importer, project.getCompilerOptions(), project.getModuleResolutionHost(), cache).resolvedModule;
  if (!hit || hit.isExternalLibraryImport) return undefined;
  const key = fileKeyOf(hit.resolvedFileName, root).fileKey;
  // Outside the root, or inside node_modules without tsc flagging it: an external, addressed by
  // the dependency layer (TS_PROVIDES / TS_UNRESOLVED_IMPORT), never a symbol-table key.
  if (key.startsWith("../") || key.startsWith("/") || /(^|\/)node_modules\//.test(key)) return undefined;
  return key;
}

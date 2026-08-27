import * as fs from "node:fs";
import * as path from "node:path";
import { relPosix } from "../utils";

const SOURCE_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
// JS sources are first-class too (the analyzer is a TS/JS analyzer; vendored .js like vscode's
// marked.js was invisible, #98). Sibling rules keep one module per prefix:
//  - a .js beside a same-prefix REAL .ts source is compiled output → the .js is skipped
//    (the compiler's own allowJs duplicate rule);
//  - a .d.ts beside a same-prefix .js is hand-written declarations FOR that source → the .d.ts
//    is skipped as a module (the checker still reads it from disk for importers' types).
const JS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".codeanalyzer",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
]);

const TEST_DIRS = new Set(["__tests__", "__test__", "test", "tests", "spec", "__mocks__"]);

/** Test-ness is judged on the path RELATIVE TO the project root, never the absolute path. */
function isTestFile(relKey: string): boolean {
  const base = path.basename(relKey);
  if (/\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(base)) return true;
  return relKey.split("/").some((p) => TEST_DIRS.has(p));
}

export interface DiscoveredFile {
  absPath: string;
  fileKey: string; // project-relative POSIX path with extension
}

/** Recursively discover TS/JS sources under root, skipping vendored and (optionally) test trees. */
export function discoverSourceFiles(root: string, skipTests: boolean): DiscoveredFile[] {
  const tsFiles: DiscoveredFile[] = [];
  const jsCandidates: DiscoveredFile[] = [];
  const realTsPrefixes = new Set<string>(); // non-.d.ts TS sources only
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (skipTests && TEST_DIRS.has(e.name)) continue;
        walk(abs);
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        const isTs = SOURCE_EXTS.has(ext);
        const isJs = JS_EXTS.has(ext);
        if (!isTs && !isJs) continue;
        const fileKey = relPosix(root, abs);
        if (skipTests && isTestFile(fileKey)) continue;
        if (isTs) {
          if (!fileKey.endsWith(".d.ts")) realTsPrefixes.add(fileKey.replace(/\.(tsx|ts|mts|cts)$/, ""));
          tsFiles.push({ absPath: abs, fileKey });
        } else {
          jsCandidates.push({ absPath: abs, fileKey });
        }
      }
    }
  };
  walk(root);
  const out: DiscoveredFile[] = [];
  const jsPrefixes = new Set<string>();
  for (const j of jsCandidates) {
    const prefix = j.fileKey.replace(/\.(jsx|js|mjs|cjs)$/, "");
    if (realTsPrefixes.has(prefix)) continue; // compiled sibling of a TS source → skip
    jsPrefixes.add(prefix);
    out.push(j);
  }
  for (const t of tsFiles) {
    if (t.fileKey.endsWith(".d.ts") && jsPrefixes.has(t.fileKey.replace(/\.d\.ts$/, ""))) continue; // decls FOR an analyzed .js
    out.push(t);
  }
  out.sort((a, b) => a.fileKey.localeCompare(b.fileKey));
  return out;
}

/** Resolve a list of CLI target files (relative or absolute) to discovered files under root. */
export function resolveTargetFiles(root: string, targets: string[]): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  for (const t of targets) {
    const abs = path.isAbsolute(t) ? t : path.resolve(root, t);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      out.push({ absPath: abs, fileKey: relPosix(root, abs) });
    }
  }
  out.sort((a, b) => a.fileKey.localeCompare(b.fileKey));
  return out;
}

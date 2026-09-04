import * as fs from "node:fs";
import * as path from "node:path";
import type { TSModule } from "../schema";
import { sha256 } from "./fs";
import { ANALYZER_VERSION } from "./version";

export interface CacheData {
  analyzer_version?: string;
  program_contexts?: Record<string, string>;
  symbol_table: Record<string, TSModule>;
}

export function cacheFilePath(cacheDir: string): string {
  return path.join(cacheDir, "analysis_cache.json");
}

export function loadCache(cacheDir: string): CacheData | null {
  try {
    const p = cacheFilePath(cacheDir);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as CacheData;
    // Invalidate the whole cache when the analyzer version changed — the per-file source hash
    // can't detect that the extraction logic itself moved on.
    if (data.analyzer_version !== ANALYZER_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveCache(cacheDir: string, data: CacheData): void {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      cacheFilePath(cacheDir),
      JSON.stringify(
        { analyzer_version: ANALYZER_VERSION, ...data },
        (key, value: unknown) => key === "callee_signature" ? undefined : value,
      ),
    );
  } catch {
    /* caching is best-effort */
  }
}

export interface FileMeta {
  content_hash: string;
  last_modified: number;
  file_size: number;
}

export function fileMeta(absPath: string): FileMeta {
  const buf = fs.readFileSync(absPath);
  const st = fs.statSync(absPath);
  return { content_hash: sha256(buf), last_modified: st.mtimeMs, file_size: st.size };
}

/** Reuse a cached Module iff (mtime, size) match, falling back to a content-hash comparison. */
export function fileUnchanged(absPath: string, cached: TSModule): boolean {
  try {
    const st = fs.statSync(absPath);
    if (cached.last_modified === st.mtimeMs && cached.file_size === st.size) return true;
    if (cached.content_hash) {
      return sha256(fs.readFileSync(absPath)) === cached.content_hash;
    }
    return false;
  } catch {
    return false;
  }
}

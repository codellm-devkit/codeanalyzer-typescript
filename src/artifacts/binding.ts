/**
 * Import→dependency binding (#101, python PR #160's `unresolved_imports`): every non-relative,
 * non-builtin import specifier root the symbol table saw, checked against the declared records.
 * A VALUE import of `x` needs the runtime package `x`; an `import type` is satisfiable by
 * `@types/x` alone (bound_to it) — the spec'd TS rule. `--resolve-installed` additionally probes
 * node_modules metadata (prov "installed-metadata"); default runs read only repo files.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { TSDependency, TSImportBinding, TSModule } from "../schema";

/** The package root of an import specifier ("express/lib/router" → "express"; scoped keeps 2). */
export function specifierRoot(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#")) return null; // relative/self
  if (spec.startsWith("node:")) return null; // builtin
  const parts = spec.split("/");
  if (spec.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  const root = parts[0] as string;
  return NODE_BUILTINS.has(root) ? null : root;
}

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "timers", "tls", "trace_events", "tty", "url",
  "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

export function bindImports(
  symbol_table: Record<string, TSModule>,
  deps: TSDependency[],
  projectRoot: string,
  resolveInstalled: boolean,
): TSImportBinding[] {
  // specifier root → was it ever imported as a VALUE (vs exclusively type-only)?
  const valueImport = new Map<string, boolean>();
  for (const mod of Object.values(symbol_table)) {
    for (const im of mod.imports) {
      const root = specifierRoot(im.module);
      if (!root) continue;
      valueImport.set(root, (valueImport.get(root) ?? false) || !im.is_type_only);
    }
  }

  const provided = new Map<string, TSDependency>();
  for (const dep of deps) for (const p of dep.provides_imports) if (!provided.has(p)) provided.set(p, dep);

  const out: TSImportBinding[] = [];
  for (const [root, isValue] of [...valueImport.entries()].sort()) {
    const direct = provided.get(root);
    if (direct && (direct.name === root || !isValue)) continue; // runtime-declared, or types satisfy a type-only import
    if (direct && direct.name.startsWith("@types/") && isValue) {
      // Only @types declared, but the import is a VALUE use — partially bound, still unresolved.
      out.push({ module: root, bound_to: direct.name, prov: ["heuristic"] });
      continue;
    }
    if (resolveInstalled) {
      const version = installedVersion(projectRoot, root);
      if (version !== null) {
        out.push({ module: root, bound_to: root, prov: ["installed-metadata"] });
        continue;
      }
    }
    out.push({ module: root, prov: [] });
  }
  return out;
}

/** Opt-in probe: node_modules/<name>/package.json version (never runs on default analyses). */
export function installedVersion(projectRoot: string, name: string): string | null {
  try {
    const p = path.join(projectRoot, "node_modules", ...name.split("/"), "package.json");
    const doc = JSON.parse(fs.readFileSync(p, "utf-8")) as { version?: unknown };
    return typeof doc.version === "string" ? doc.version : null;
  } catch {
    return null;
  }
}

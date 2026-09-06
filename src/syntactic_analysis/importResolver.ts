/**
 * Import-table resolution of a WRITTEN spelling (#151) — python's `_base_resolver` for TypeScript.
 *
 * The checker is never consulted for decorator identity: ts-morph's `Decorator.getFullName()` is
 * the expression text as typed, so `@HttpGet` stays `HttpGet` even when `import { Get as HttpGet }`
 * makes the answer trivial. What the module's import table can name, this names; what it cannot,
 * stays unresolved (absent), which is what makes the entrypoint pass's unresolved counter honest.
 *
 * Package specifiers are kept verbatim (`@nestjs/common.Get`) — that is the spelling a rule names.
 * Relative specifiers stay relative; an in-project decorator is a user rule's business.
 */
import type { TSImport } from "../schema";

/** Local binding → module-qualified prefix, from one module's imports. */
export function importTable(imports: TSImport[]): Map<string, string> {
  const t = new Map<string, string>();
  for (const imp of imports) {
    if (imp.import_kind === "default") t.set(imp.name, `${imp.module}.default`);
    else if (imp.import_kind === "namespace" && imp.alias) t.set(imp.alias, imp.module);
    else if (imp.import_kind === "named") t.set(imp.alias ?? imp.name, `${imp.module}.${imp.name}`);
  }
  return t;
}

/**
 * Resolve `written` (`Get`, `HttpGet`, `http.route`) through the table. `undefined` when the head
 * is not an imported binding — a same-file declaration, a global, or a spelling nothing can name.
 */
export function resolveWritten(table: Map<string, string>, written: string): string | undefined {
  const dot = written.indexOf(".");
  const head = dot < 0 ? written : written.slice(0, dot);
  const base = table.get(head);
  if (base === undefined) return undefined;
  return dot < 0 ? base : `${base}${written.slice(dot)}`;
}

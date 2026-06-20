/**
 * The Cypher DDL — uniqueness constraints and indexes — shared by both writers. Run BEFORE any
 * load so MERGE uses an index seek (not a label scan) and the identity invariant is enforced by
 * the database. Every statement is idempotent (`IF NOT EXISTS`).
 */
export const CONSTRAINTS: readonly string[] = [
  "CREATE CONSTRAINT symbol_sig IF NOT EXISTS FOR (s:TSSymbol) REQUIRE s.signature IS UNIQUE",
  "CREATE CONSTRAINT app_name IF NOT EXISTS FOR (a:TSApplication) REQUIRE a.name IS UNIQUE",
  "CREATE CONSTRAINT module_key IF NOT EXISTS FOR (m:TSModule) REQUIRE m.file_key IS UNIQUE",
  "CREATE CONSTRAINT package_name IF NOT EXISTS FOR (p:TSPackage) REQUIRE p.name IS UNIQUE",
  "CREATE CONSTRAINT decorator_qn IF NOT EXISTS FOR (d:TSDecorator) REQUIRE d.qualified_name IS UNIQUE",
  "CREATE CONSTRAINT callsite_id IF NOT EXISTS FOR (c:TSCallSite) REQUIRE c.id IS UNIQUE",
  "CREATE CONSTRAINT attribute_id IF NOT EXISTS FOR (a:TSAttribute) REQUIRE a.id IS UNIQUE",
  "CREATE CONSTRAINT variable_id IF NOT EXISTS FOR (v:TSVariable) REQUIRE v.id IS UNIQUE",
];

export const INDEXES: readonly string[] = [
  "CREATE INDEX callable_name IF NOT EXISTS FOR (c:TSCallable) ON (c.name)",
  "CREATE INDEX decorator_name IF NOT EXISTS FOR (d:TSDecorator) ON (d.name)",
  "CREATE FULLTEXT INDEX code_fts IF NOT EXISTS FOR (c:TSCallable) ON EACH [c.code, c.docstring]",
];

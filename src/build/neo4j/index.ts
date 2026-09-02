// Neo4j output: pure projection of the TSApplication IR to graph rows, plus the two writers
// (cypher snapshot / bolt incremental). Nothing here runs unless `--emit neo4j` is selected.
export { project } from "./project";
export { renderCypher, writeCypherFile } from "./cypher";
export { boltWriter, type BoltConfig } from "./bolt";
export { SCHEMA_VERSION, TS_PREFIX, buildSchemaDocument, NODE_LABELS, REL_TYPES, MARKER_LABELS, CONSTRAINTS, INDEXES } from "./schema";
export type { SchemaDocument } from "./schema";
export type { GraphRows, NodeRow, EdgeRow } from "./rows";

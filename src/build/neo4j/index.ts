// Neo4j output: pure projection of the TSApplication IR to graph rows, plus the two writers
// (cypher snapshot / bolt incremental). Nothing here runs unless `--emit neo4j` is selected.
export { project } from "./project";
export { renderCypher } from "./cypher";
export { boltWriter, type BoltConfig } from "./bolt";
export { SCHEMA_VERSION, buildSchemaDocument, NODE_LABELS, REL_TYPES } from "./catalog";
export type { SchemaDocument } from "./catalog";
export type { GraphRows, NodeRow, EdgeRow } from "./rows";

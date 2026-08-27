// ── constraints & indexes ──
CREATE CONSTRAINT application_id IF NOT EXISTS FOR (x:Application) REQUIRE x.id IS UNIQUE;
CREATE CONSTRAINT cannode_id IF NOT EXISTS FOR (x:CanNode) REQUIRE x.id IS UNIQUE;
CREATE INDEX callable_name IF NOT EXISTS FOR (c:TSCallable) ON (c.name);
CREATE INDEX cannode_kind IF NOT EXISTS FOR (n:CanNode) ON (n.kind);
CREATE INDEX cannode_module IF NOT EXISTS FOR (n:CanNode) ON (n._module);

// ── wipe this project's prior subgraph (external targets are shared) ──
MATCH (a:Application {id: 'can://typescript/anon-app'})
OPTIONAL MATCH (a)-[:TS_HAS_MODULE]->(m:TSModule)
OPTIONAL MATCH (m)-[:TS_DECLARES|TS_HAS_METHOD|TS_HAS_FIELD|TS_HAS_BODY_NODE*1..]->(x)
DETACH DELETE x, m, a;

// ── nodes ──
UNWIND [
  {k: 'can://typescript/anon-app', p: {id: 'can://typescript/anon-app', schema_version: '2.1.0', language: 'typescript', max_level: 4, k_limit: 3, analyzer_name: 'codeanalyzer-typescript', analyzer_version: '1.0.0'}}
] AS row
MERGE (n:Application {id: row.k})
SET n += row.p, n:TSApplication;
UNWIND [
  {k: 'can://typescript/anon-app/src/routes.ts', p: {id: 'can://typescript/anon-app/src/routes.ts', kind: 'module', name: 'src/routes.ts', is_tsx: false, is_declaration_file: false, start_line: 1, end_line: 22, _module: 'src/routes.ts'}}
] AS row
MERGE (n:CanNode {id: row.k})
SET n += row.p, n:TSModule;
UNWIND [
  {k: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>', p: {id: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>', kind: 'arrow', signature: 'src/routes.<anon@13:20>', name: '(anonymous)', return_type: 'void', cyclomatic_complexity: 1, is_static: false, is_abstract: false, is_async: false, is_generator: false, is_exported: false, is_ambient: false, is_implicit: false, start_line: 13, end_line: 15, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', p: {id: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', kind: 'arrow', signature: 'src/routes.login.<anon@2:10>', name: '(anonymous)', return_type: 'void', cyclomatic_complexity: 1, is_static: false, is_abstract: false, is_async: false, is_generator: false, is_exported: false, is_ambient: false, is_implicit: false, start_line: 2, end_line: 5, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>', p: {id: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>', kind: 'arrow', signature: 'src/routes.outer.<anon@20:10>', name: '(anonymous)', return_type: '() => number', cyclomatic_complexity: 1, is_static: false, is_abstract: false, is_async: false, is_generator: false, is_exported: false, is_ambient: false, is_implicit: false, start_line: 20, end_line: 20, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>', p: {id: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>', kind: 'arrow', signature: 'src/routes.outer.<anon@20:10>.<anon@20:16>', name: '(anonymous)', return_type: 'number', cyclomatic_complexity: 1, is_static: false, is_abstract: false, is_async: false, is_generator: false, is_exported: false, is_ambient: false, is_implicit: false, start_line: 20, end_line: 20, _module: 'src/routes.ts'}}
] AS row
MERGE (n:CanNode {id: row.k})
SET n += row.p, n:TSCallable:TSAnonymousCallable;
UNWIND [
  {k: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3', p: {id: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3', kind: 'call', start_line: 14, end_line: 14, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3/actual_in:0', p: {id: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3/actual_in:0', kind: 'actual_in', of: 'arg0', parent: '14:3', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3/actual_out', p: {id: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3/actual_out', kind: 'actual_out', of: '$ret', parent: '14:3', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@entry', p: {id: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@entry', kind: 'entry', start_line: 13, end_line: 15, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@exit', p: {id: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@exit', kind: 'exit', start_line: 13, end_line: 15, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@formal_in:0', p: {id: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@formal_in:0', kind: 'formal_in', of: 'req', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@formal_in:1', p: {id: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@formal_in:1', kind: 'formal_in', of: 'res', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@formal_out', p: {id: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@formal_out', kind: 'formal_out', of: '$ret', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login@2:3', p: {id: 'can://typescript/anon-app/src/routes.ts/login@2:3', kind: 'statement', start_line: 2, end_line: 5, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login@entry', p: {id: 'can://typescript/anon-app/src/routes.ts/login@entry', kind: 'entry', start_line: 1, end_line: 6, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login@exit', p: {id: 'can://typescript/anon-app/src/routes.ts/login@exit', kind: 'exit', start_line: 1, end_line: 6, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login@formal_out', p: {id: 'can://typescript/anon-app/src/routes.ts/login@formal_out', kind: 'formal_out', of: '$ret', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@3:5', p: {id: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@3:5', kind: 'statement', start_line: 3, end_line: 3, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5', p: {id: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5', kind: 'call', callee: 'can://typescript/anon-app/src/routes.ts/query', start_line: 4, end_line: 4, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5/actual_in:0', p: {id: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5/actual_in:0', kind: 'actual_in', of: 'arg0', parent: '4:5', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5/actual_out', p: {id: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5/actual_out', kind: 'actual_out', of: '$ret', parent: '4:5', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@entry', p: {id: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@entry', kind: 'entry', start_line: 2, end_line: 5, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@exit', p: {id: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@exit', kind: 'exit', start_line: 2, end_line: 5, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@formal_in:0', p: {id: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@formal_in:0', kind: 'formal_in', of: 'req', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@formal_in:1', p: {id: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@formal_in:1', kind: 'formal_in', of: 'res', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@formal_out', p: {id: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@formal_out', kind: 'formal_out', of: '$ret', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/named@17:21', p: {id: 'can://typescript/anon-app/src/routes.ts/named@17:21', kind: 'statement', start_line: 17, end_line: 17, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/named@entry', p: {id: 'can://typescript/anon-app/src/routes.ts/named@entry', kind: 'entry', start_line: 17, end_line: 17, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/named@exit', p: {id: 'can://typescript/anon-app/src/routes.ts/named@exit', kind: 'exit', start_line: 17, end_line: 17, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/named@formal_out', p: {id: 'can://typescript/anon-app/src/routes.ts/named@formal_out', kind: 'formal_out', of: '$ret', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer@20:3', p: {id: 'can://typescript/anon-app/src/routes.ts/outer@20:3', kind: 'statement', start_line: 20, end_line: 20, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer@entry', p: {id: 'can://typescript/anon-app/src/routes.ts/outer@entry', kind: 'entry', start_line: 19, end_line: 21, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer@exit', p: {id: 'can://typescript/anon-app/src/routes.ts/outer@exit', kind: 'exit', start_line: 19, end_line: 21, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer@formal_out', p: {id: 'can://typescript/anon-app/src/routes.ts/outer@formal_out', kind: 'formal_out', of: '$ret', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@20:16', p: {id: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@20:16', kind: 'statement', start_line: 20, end_line: 20, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@entry', p: {id: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@entry', kind: 'entry', start_line: 20, end_line: 20, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@exit', p: {id: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@exit', kind: 'exit', start_line: 20, end_line: 20, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@formal_out', p: {id: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@formal_out', kind: 'formal_out', of: '$ret', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@20:22', p: {id: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@20:22', kind: 'statement', start_line: 20, end_line: 20, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@entry', p: {id: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@entry', kind: 'entry', start_line: 20, end_line: 20, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@exit', p: {id: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@exit', kind: 'exit', start_line: 20, end_line: 20, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@formal_out', p: {id: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@formal_out', kind: 'formal_out', of: '$ret', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/query@9:3', p: {id: 'can://typescript/anon-app/src/routes.ts/query@9:3', kind: 'statement', start_line: 9, end_line: 9, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/query@entry', p: {id: 'can://typescript/anon-app/src/routes.ts/query@entry', kind: 'entry', start_line: 8, end_line: 10, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/query@exit', p: {id: 'can://typescript/anon-app/src/routes.ts/query@exit', kind: 'exit', start_line: 8, end_line: 10, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/query@formal_in:0', p: {id: 'can://typescript/anon-app/src/routes.ts/query@formal_in:0', kind: 'formal_in', of: 'sql', _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/query@formal_out', p: {id: 'can://typescript/anon-app/src/routes.ts/query@formal_out', kind: 'formal_out', of: '$ret', _module: 'src/routes.ts'}}
] AS row
MERGE (n:CanNode {id: row.k})
SET n += row.p, n:TSBodyNode;
UNWIND [
  {k: 'can://typescript/anon-app/src/routes.ts/app', p: {id: 'can://typescript/anon-app/src/routes.ts/app', kind: 'field', name: 'app', type: 'any', start_line: 12, end_line: 12, _module: 'src/routes.ts'}}
] AS row
MERGE (n:CanNode {id: row.k})
SET n += row.p, n:TSField;
UNWIND [
  {k: 'can://typescript/anon-app/src/routes.ts/login', p: {id: 'can://typescript/anon-app/src/routes.ts/login', kind: 'function', signature: 'src/routes.login', name: 'login', return_type: '(req: any, res: any) => void', cyclomatic_complexity: 1, is_static: false, is_abstract: false, is_async: false, is_generator: false, is_exported: true, is_ambient: false, is_implicit: false, start_line: 1, end_line: 6, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/named', p: {id: 'can://typescript/anon-app/src/routes.ts/named', kind: 'arrow', signature: 'src/routes.named', name: 'named', return_type: 'number', cyclomatic_complexity: 1, is_static: false, is_abstract: false, is_async: false, is_generator: false, is_exported: false, is_ambient: false, is_implicit: false, start_line: 17, end_line: 17, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/outer', p: {id: 'can://typescript/anon-app/src/routes.ts/outer', kind: 'function', signature: 'src/routes.outer', name: 'outer', return_type: '() => () => number', cyclomatic_complexity: 1, is_static: false, is_abstract: false, is_async: false, is_generator: false, is_exported: true, is_ambient: false, is_implicit: false, start_line: 19, end_line: 21, _module: 'src/routes.ts'}},
  {k: 'can://typescript/anon-app/src/routes.ts/query', p: {id: 'can://typescript/anon-app/src/routes.ts/query', kind: 'function', signature: 'src/routes.query', name: 'query', return_type: 'string', cyclomatic_complexity: 1, is_static: false, is_abstract: false, is_async: false, is_generator: false, is_exported: true, is_ambient: false, is_implicit: false, start_line: 8, end_line: 10, _module: 'src/routes.ts'}}
] AS row
MERGE (n:CanNode {id: row.k})
SET n += row.p, n:TSCallable;

// ── relationships ──
UNWIND [
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', t: 'can://typescript/anon-app/src/routes.ts/query', p: {weight: 1, prov: ['tsc']}}
] AS row
MATCH (a:CanNode {id: row.f})
MATCH (b:CanNode {id: row.t})
MERGE (a)-[r:TS_CALLS]->(b)
SET r += row.p;
UNWIND [
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@entry', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login@entry', t: 'can://typescript/anon-app/src/routes.ts/login@2:3', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@entry', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@3:5', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@entry', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/named@entry', t: 'can://typescript/anon-app/src/routes.ts/named@17:21', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer@entry', t: 'can://typescript/anon-app/src/routes.ts/outer@20:3', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@entry', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@20:16', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@entry', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@20:22', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/query@entry', t: 'can://typescript/anon-app/src/routes.ts/query@9:3', p: {}}
] AS row
MATCH (a:CanNode {id: row.f})
MATCH (b:CanNode {id: row.t})
MERGE (a)-[r:TS_CDG]->(b)
SET r += row.p;
UNWIND [
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@exit', k: 'exception', p: {kind: 'exception'}},
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@exit', k: 'fallthrough', p: {kind: 'fallthrough'}},
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@entry', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3', k: 'fallthrough', p: {kind: 'fallthrough'}},
  {f: 'can://typescript/anon-app/src/routes.ts/login@2:3', t: 'can://typescript/anon-app/src/routes.ts/login@exit', k: 'return', p: {kind: 'return'}},
  {f: 'can://typescript/anon-app/src/routes.ts/login@entry', t: 'can://typescript/anon-app/src/routes.ts/login@2:3', k: 'fallthrough', p: {kind: 'fallthrough'}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@3:5', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5', k: 'fallthrough', p: {kind: 'fallthrough'}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@exit', k: 'exception', p: {kind: 'exception'}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@exit', k: 'fallthrough', p: {kind: 'fallthrough'}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@entry', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@3:5', k: 'fallthrough', p: {kind: 'fallthrough'}},
  {f: 'can://typescript/anon-app/src/routes.ts/named@17:21', t: 'can://typescript/anon-app/src/routes.ts/named@exit', k: 'return', p: {kind: 'return'}},
  {f: 'can://typescript/anon-app/src/routes.ts/named@entry', t: 'can://typescript/anon-app/src/routes.ts/named@17:21', k: 'fallthrough', p: {kind: 'fallthrough'}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer@20:3', t: 'can://typescript/anon-app/src/routes.ts/outer@exit', k: 'return', p: {kind: 'return'}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer@entry', t: 'can://typescript/anon-app/src/routes.ts/outer@20:3', k: 'fallthrough', p: {kind: 'fallthrough'}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@20:16', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@exit', k: 'exception', p: {kind: 'exception'}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@20:16', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@exit', k: 'return', p: {kind: 'return'}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@entry', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@20:16', k: 'fallthrough', p: {kind: 'fallthrough'}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@20:22', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@exit', k: 'exception', p: {kind: 'exception'}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@20:22', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@exit', k: 'return', p: {kind: 'return'}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@entry', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@20:22', k: 'fallthrough', p: {kind: 'fallthrough'}},
  {f: 'can://typescript/anon-app/src/routes.ts/query@9:3', t: 'can://typescript/anon-app/src/routes.ts/query@exit', k: 'return', p: {kind: 'return'}},
  {f: 'can://typescript/anon-app/src/routes.ts/query@entry', t: 'can://typescript/anon-app/src/routes.ts/query@9:3', k: 'fallthrough', p: {kind: 'fallthrough'}}
] AS row
MATCH (a:CanNode {id: row.f})
MATCH (b:CanNode {id: row.t})
MERGE (a)-[r:TS_CFG_NEXT {_k: row.k}]->(b)
SET r += row.p;
UNWIND [
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@entry', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3', k: 'req.query.probe|reaching-defs', p: {var: 'req.query.probe', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@entry', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3', k: 'res.send|reaching-defs', p: {var: 'res.send', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/login@2:3', t: 'can://typescript/anon-app/src/routes.ts/login@formal_out', k: 'return|reaching-defs', p: {var: 'return', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@3:5', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5', k: 'email|reaching-defs', p: {var: 'email', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@entry', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@3:5', k: 'req.body.email|reaching-defs', p: {var: 'req.body.email', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/named@17:21', t: 'can://typescript/anon-app/src/routes.ts/named@formal_out', k: 'return|reaching-defs', p: {var: 'return', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer@20:3', t: 'can://typescript/anon-app/src/routes.ts/outer@formal_out', k: 'return|reaching-defs', p: {var: 'return', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer@entry', t: 'can://typescript/anon-app/src/routes.ts/outer@20:3', k: 'src/routes.named|reaching-defs', p: {var: 'src/routes.named', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@20:16', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@formal_out', k: 'return|reaching-defs', p: {var: 'return', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@entry', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@20:16', k: 'src/routes.named|reaching-defs', p: {var: 'src/routes.named', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@20:22', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@formal_out', k: 'return|reaching-defs', p: {var: 'return', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@entry', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@20:22', k: 'src/routes.named|reaching-defs', p: {var: 'src/routes.named', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/query@9:3', t: 'can://typescript/anon-app/src/routes.ts/query@formal_out', k: 'return|reaching-defs', p: {var: 'return', prov: ['reaching-defs']}},
  {f: 'can://typescript/anon-app/src/routes.ts/query@entry', t: 'can://typescript/anon-app/src/routes.ts/query@9:3', k: 'sql|reaching-defs', p: {var: 'sql', prov: ['reaching-defs']}}
] AS row
MATCH (a:CanNode {id: row.f})
MATCH (b:CanNode {id: row.t})
MERGE (a)-[r:TS_DDG {_k: row.k}]->(b)
SET r += row.p;
UNWIND [
  {f: 'can://typescript/anon-app/src/routes.ts/login', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts', t: 'can://typescript/anon-app/src/routes.ts/login', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts', t: 'can://typescript/anon-app/src/routes.ts/named', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts', t: 'can://typescript/anon-app/src/routes.ts/outer', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts', t: 'can://typescript/anon-app/src/routes.ts/query', p: {}}
] AS row
MATCH (a:CanNode {id: row.f})
MATCH (b:CanNode {id: row.t})
MERGE (a)-[r:TS_DECLARES]->(b)
SET r += row.p;
UNWIND [
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3/actual_in:0', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3/actual_out', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@entry', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@exit', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@formal_in:0', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@formal_in:1', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@formal_out', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@3:5', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5/actual_in:0', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5/actual_out', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@entry', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@exit', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@formal_in:0', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@formal_in:1', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@formal_out', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login', t: 'can://typescript/anon-app/src/routes.ts/login@2:3', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login', t: 'can://typescript/anon-app/src/routes.ts/login@entry', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login', t: 'can://typescript/anon-app/src/routes.ts/login@exit', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login', t: 'can://typescript/anon-app/src/routes.ts/login@formal_out', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/named', t: 'can://typescript/anon-app/src/routes.ts/named@17:21', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/named', t: 'can://typescript/anon-app/src/routes.ts/named@entry', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/named', t: 'can://typescript/anon-app/src/routes.ts/named@exit', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/named', t: 'can://typescript/anon-app/src/routes.ts/named@formal_out', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@20:22', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@entry', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@exit', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>/<anon@20:16>@formal_out', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@20:16', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@entry', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@exit', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>', t: 'can://typescript/anon-app/src/routes.ts/outer/<anon@20:10>@formal_out', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer', t: 'can://typescript/anon-app/src/routes.ts/outer@20:3', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer', t: 'can://typescript/anon-app/src/routes.ts/outer@entry', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer', t: 'can://typescript/anon-app/src/routes.ts/outer@exit', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/outer', t: 'can://typescript/anon-app/src/routes.ts/outer@formal_out', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/query', t: 'can://typescript/anon-app/src/routes.ts/query@9:3', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/query', t: 'can://typescript/anon-app/src/routes.ts/query@entry', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/query', t: 'can://typescript/anon-app/src/routes.ts/query@exit', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/query', t: 'can://typescript/anon-app/src/routes.ts/query@formal_in:0', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/query', t: 'can://typescript/anon-app/src/routes.ts/query@formal_out', p: {}}
] AS row
MATCH (a:CanNode {id: row.f})
MATCH (b:CanNode {id: row.t})
MERGE (a)-[r:TS_HAS_BODY_NODE]->(b)
SET r += row.p;
UNWIND [
  {f: 'can://typescript/anon-app/src/routes.ts', t: 'can://typescript/anon-app/src/routes.ts/app', p: {}}
] AS row
MATCH (a:CanNode {id: row.f})
MATCH (b:CanNode {id: row.t})
MERGE (a)-[r:TS_HAS_FIELD]->(b)
SET r += row.p;
UNWIND [
  {f: 'can://typescript/anon-app', t: 'can://typescript/anon-app/src/routes.ts', p: {}}
] AS row
MATCH (a:Application {id: row.f})
MATCH (b:CanNode {id: row.t})
MERGE (a)-[r:TS_HAS_MODULE]->(b)
SET r += row.p;
UNWIND [
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5/actual_in:0', t: 'can://typescript/anon-app/src/routes.ts/query@formal_in:0', p: {}}
] AS row
MATCH (a:CanNode {id: row.f})
MATCH (b:CanNode {id: row.t})
MERGE (a)-[r:TS_PARAM_IN]->(b)
SET r += row.p;
UNWIND [
  {f: 'can://typescript/anon-app/src/routes.ts/query@formal_out', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5/actual_out', p: {}}
] AS row
MATCH (a:CanNode {id: row.f})
MATCH (b:CanNode {id: row.t})
MERGE (a)-[r:TS_PARAM_OUT]->(b)
SET r += row.p;
UNWIND [
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5', t: 'can://typescript/anon-app/src/routes.ts/query', p: {}}
] AS row
MATCH (a:CanNode {id: row.f})
MATCH (b:CanNode {id: row.t})
MERGE (a)-[r:TS_RESOLVES_TO]->(b)
SET r += row.p;
UNWIND [
  {f: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3/actual_in:0', t: 'can://typescript/anon-app/src/routes.ts/<anon@13:20>@14:3/actual_out', p: {}},
  {f: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5/actual_in:0', t: 'can://typescript/anon-app/src/routes.ts/login/<anon@2:10>@4:5/actual_out', p: {}}
] AS row
MATCH (a:CanNode {id: row.f})
MATCH (b:CanNode {id: row.t})
MERGE (a)-[r:TS_SUMMARY]->(b)
SET r += row.p;

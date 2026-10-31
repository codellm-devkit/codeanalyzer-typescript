import { expect, test } from 'bun:test';
import fixture from './fixtures/identity/namespaces.json';
import { applicationIdOf, moduleIdOf, artifactIdOf } from '../src/schema/ids';
for (const row of fixture.roots) test(`root ${JSON.stringify(row)}`, () => expect(applicationIdOf(row.application_name, row.namespace ?? undefined)).toBe(row.expected_root));
for (const row of fixture.invalid) test(`invalid ${row.reason}`, () => {
 expect(() => applicationIdOf(row.value)).toThrow();
 expect(() => applicationIdOf('app', row.value)).toThrow();
});
for (const row of fixture.modules.filter(r => ['typescript','javascript'].includes(r.language))) test(row.expected_uri, () => expect(moduleIdOf(row.application_name,row.file_key,row.namespace ?? undefined)).toBe(row.expected_uri));
test('artifact scope', () => expect(artifactIdOf('a%b','package.json','team')).toBe('can://team/a%25b/artifact/package.json'));

import { analyze } from '../src/core';
import { finalizeAnalysis } from '../src/schema/emit';
import { project } from '../src/build/neo4j/project';
import { loadCache } from '../src/utils/cache';
import type { AnalysisOptions } from '../src/options';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cants-namespace-'));
const options = {
 input: path.join(import.meta.dir,'fixtures/artifacts-app'), appName: 'a%b', namespace: 'first',
 analysisLevel: 2, graphs: ['cfg','dfg','pdg','sdg'], graphFieldDepth: 3, jobs: 1,
 skipTests: true, eager: true, noBuild: true, phantoms: true, cacheDir, verbosity: 0,
} as AnalysisOptions;
test('repeat finalization restamps every reference and preserves input-relative keys', async () => {
 const first = await analyze(options);
 expect(first.application.identity_version).toBe(2);
 const second = finalizeAnalysis(first.internal,null,{...options,namespace:'second'}).application;
 expect(second.application.application_name).toBe('a%b');
 expect(second.application.identity_namespace).toBe('second');
 expect(second.application.identity_version).toBe(2);
 expect(Object.keys(second.application.symbol_table)).toEqual(Object.keys(first.application.application.symbol_table));
 expect(JSON.stringify(second)).not.toContain('can://first/');
 expect(second.application.dependencies.length).toBeGreaterThan(0);
 for (const dependency of second.application.dependencies) expect(dependency.declared_in).toStartWith('can://second/a%25b/artifact/');
 expect(Object.keys(second.application.external_symbols ?? {}).length).toBeGreaterThan(0);
 for (const mod of Object.values(second.application.symbol_table)) expect(mod.id).toStartWith('can://second/a%25b/');
 expect(project(second).nodes.find(n=>n.labels.includes('TSApplication'))?.props.identity_namespace).toBe('second');
 expect(loadCache(cacheDir, 'can://first/a%25b')).not.toBeNull();
 expect(loadCache(cacheDir, 'can://second/a%25b')).toBeNull();
 for (const marker of [undefined,1,'2',2.5]) {
  const stale = structuredClone(second);
  (stale as any).identity_version=marker;
  expect(()=>project(stale)).toThrow();
 }
 const mismatch = structuredClone(second);
 mismatch.application.identity_namespace='first';
 expect(()=>project(mismatch)).toThrow();
});
test('explicit empty namespace fails before analysis', async () => {
 await expect(analyze({...options,namespace:''})).rejects.toThrow();
});
test('cache rejects legacy and noninteger markers without rewriting the input', () => {
 const file = path.join(cacheDir, 'analysis_cache.json');
 const original = fs.readFileSync(file,'utf8');
 try {
  for (const marker of [undefined, 1, '2', 2.5]) {
   const data = JSON.parse(original);
   data.identity_version = marker;
   const bytes = JSON.stringify(data);
   fs.writeFileSync(file,bytes);
   expect(loadCache(cacheDir,'can://first/a%25b')).toBeNull();
   expect(fs.readFileSync(file,'utf8')).toBe(bytes);
  }
 } finally { fs.writeFileSync(file,original); }
});
test('application metadata is required even for the default namespace', async () => {
 const wire = (await analyze({...options,appName:'app',namespace:undefined})).application;
 delete (wire.application as any).identity_namespace;
 expect(()=>project(wire)).toThrow();
});

for (const namespaceArgs of [[], ['--namespace', 'team']]) {
 test(`CLI rejects explicit empty application name ${namespaceArgs.join(' ')}`, () => {
  const input = fs.mkdtempSync(path.join(os.tmpdir(), 'cants-empty-name-'));
  const output = path.join(input, 'out');
  try {
   const result = Bun.spawnSync(['bun', 'run', path.join(import.meta.dir, '../src/index.ts'),
    '--input', input, '--output', output, '--no-build', '--app-name', '', ...namespaceArgs],
    { stdout: 'pipe', stderr: 'pipe' });
   expect(result.exitCode).not.toBe(0);
   expect(result.stderr.toString()).toContain('Invalid application identity segment');
   expect(fs.existsSync(path.join(output, 'analysis.json'))).toBe(false);
  } finally { fs.rmSync(input, {recursive:true,force:true}); }
 });
 test(`CLI omitted application name uses input basename ${namespaceArgs.join(' ')}`, () => {
  const input = fs.mkdtempSync(path.join(os.tmpdir(), 'cants-default-name-'));
  const output = path.join(input, 'out');
  try {
   const result = Bun.spawnSync(['bun', 'run', path.join(import.meta.dir, '../src/index.ts'),
    '--input', input, '--output', output, '--no-build', ...namespaceArgs],
    { stdout: 'pipe', stderr: 'pipe' });
   expect(result.exitCode).toBe(0);
   const wire = JSON.parse(fs.readFileSync(path.join(output,'analysis.json'),'utf8'));
   const name = path.basename(input);
   expect(wire.application.application_name).toBe(name);
   expect(wire.application.identity_namespace).toBe(namespaceArgs.length ? 'team' : name);
   expect(wire.application.id).toBe(applicationIdOf(name, namespaceArgs.length ? 'team' : undefined));
  } finally { fs.rmSync(input, {recursive:true,force:true}); }
 });
}

test('Neo4j projection retains relative JS and TS module keys under an encoded owner', async () => {
 const input = fs.mkdtempSync(path.join(os.tmpdir(), 'cants-graph-module-keys-'));
 try {
  fs.mkdirSync(path.join(input, 'nested'));
  fs.writeFileSync(path.join(input, 'server.js'), 'function serve() { return 1; }\nserve();\n');
  fs.writeFileSync(path.join(input, 'nested/client.ts'), 'export function client() { return 2; }\n');
  const result = await analyze({...options, input, appName:'a%b', namespace:'team space', cacheDir:path.join(input, '.cache')});
  const rows = project(result.application);
  const modules = rows.nodes.filter(node => node.labels.includes('TSModule'));
  expect(modules.map(node => node.props.name).sort()).toEqual(['nested/client.ts', 'server.js']);
  expect(modules.map(node => node.module).sort()).toEqual(['nested/client.ts', 'server.js']);
  expect(modules.map(node => node.props.id).sort()).toEqual([
   'can://team%20space/a%25b/javascript/server.js',
   'can://team%20space/a%25b/typescript/nested/client.ts',
  ]);
 } finally { fs.rmSync(input, {recursive:true,force:true}); }
});

test('projected classes stay in their module during incremental reconciliation', async () => {
 const input = fs.mkdtempSync(path.join(os.tmpdir(), 'cants-graph-class-owner-'));
 try {
  fs.writeFileSync(path.join(input, 'server.js'), 'class Server { constructor() {} ping() { return 1; } }\n');
  const result = await analyze({...options, input, appName:'svc', namespace:'team', cacheDir:path.join(input, '.cache')});
  const rows = project(result.application);
  const declaration = rows.nodes.find(node => node.value === 'can://team/svc/javascript/server.js/Server');
  expect(declaration?.labels).toContain('TSClass');
  expect(declaration?.module).toBe('server.js');
 } finally { fs.rmSync(input, {recursive:true,force:true}); }
});

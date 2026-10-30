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

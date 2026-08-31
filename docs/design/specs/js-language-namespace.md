# Per-module language namespace in `can://` ids

- **Status:** accepted, implementation pending
- **Scope:** `codeanalyzer-typescript`; schema v2 **id-shape change** (breaking for JS modules)
- **Tracking:** see the work item filed alongside this spec

## Problem

`src/schema/ids.ts:11` hardcodes `const LANGUAGE = "typescript"`, and every code id descends from it:

```
applicationIdOf(app)            -> can://typescript/<app>
moduleIdOf(appId, fileKey)      -> <appId>/<fileKey>
idFromSig(moduleId, prefix, sig)-> <moduleId>/<tail>
```

A JavaScript file therefore emits `can://typescript/<app>/lib/foo.js/fn`. The first `can://`
segment is defined as a language namespace, so a `.js` module is currently labelled as TypeScript.
The analyzer handles both languages — JS discovery landed in #98 — and nothing in the id records
which one a module actually is.

Measured: on `nodejs/node/lib` (406 modules, pure JavaScript) every id reads `can://typescript/…`.

This also sits against the repository-artifact layer, which deliberately went language-NEUTRAL
(`can://artifact/<app>/<path>`) so sibling analyzers over one repository mint identical ids for the
same file. Code nodes make the opposite choice and encode a language that may be wrong.

## Contract-impact triage

| Question | Answer |
| --- | --- |
| Schema v2 output | **id shape changes** for `.js`/`.jsx`/`.mjs`/`.cjs` modules and every descendant id |
| Levels / monotonicity | unaffected — ids change, structure does not |
| Repos | `codeanalyzer-typescript`; consumers of JS ids (Neo4j stores, caches, saved queries). No python change: python is single-language and has no analogue |
| schema_version | unchanged by standing decision — the contract re-baselines once every analyzer's schema is stable, not per release |
| Shared vocabulary | adds `javascript` as a language namespace alongside `typescript`; no new prov token, no new node or edge kind |

## Decision

**Per-module language in the id. The application anchor stays `can://typescript/<app>`.**

```
can://typescript/<app>                      :Application anchor (unchanged)
can://typescript/<app>/src/bar.ts/fn        TypeScript module and descendants
can://javascript/<app>/lib/foo.js/fn        JavaScript module and descendants
```

Extension mapping:

| Extension | Namespace |
| --- | --- |
| `.ts` `.tsx` `.mts` `.cts` `.d.ts` | `typescript` |
| `.js` `.jsx` `.mjs` `.cjs` | `javascript` |

### Accepted inconsistency

The application id keeps saying `typescript` while owning `javascript` children. This was chosen
knowingly over the two alternatives:

- A **neutral application anchor** (`can://app/<app>`, mirroring the artifact layer) is the more
  coherent end state, but changes *every* id in every projection rather than only JS ones.
- **Two application anchors** would break the single `:Application` invariant that carries analyzer
  identity (issue #43).

A mixed repository has no single language, so any single-anchor scheme must either name one
language or name none. Naming the analyzer's own language is the smaller break today; moving to a
neutral anchor stays open as a follow-up.

## Consequences

- **Breaking for JS ids.** Neo4j `MERGE` keys on id, so a re-projection creates new nodes for JS
  modules rather than updating existing ones; a store analyzed with an earlier version needs a
  rebuild. Saved Cypher and any persisted id references to JS nodes must be updated.
- **`modulePrefixOf` collision risk is unchanged.** It strips `.ts` and `.js` alike, so `a.ts` and
  `a.js` still share a module prefix. That collision is prevented upstream by discovery's sibling
  rule (a `.js` beside a real same-prefix `.ts` is treated as compiled output and skipped), not by
  the id grammar. Splitting the namespace does not fix it and does not worsen it.
- **The cache is unaffected.** Ids are per-run (`assignIds` stamps them fresh because they embed
  `--app-name`); the cached tree is id-free.
- **One construction site.** `assignIds.ts:54` is the only caller of `moduleIdOf`, so the change is
  contained: `moduleIdOf` takes the app NAME and the file key and derives the namespace itself.

## Definition of done

- A `.js` module and its callables emit `can://javascript/…`; a `.ts` module emits
  `can://typescript/…`; the `:Application` id is unchanged.
- The `.d.ts` case is asserted explicitly (it is `typescript`, and `.d.ts` must not be read as a
  `.ts` suffix on a `.d` file).
- Neo4j projection and JSON agree, and the conformance and count-parity gates stay green.
- A fixture with both a `.ts` and a `.js` module asserts both namespaces in one run.

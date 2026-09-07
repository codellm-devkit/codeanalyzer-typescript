# Declaration merging: one id per facet

Tracking: codeanalyzer-typescript #177. Ships in 1.5.0. Neo4j contract unchanged at 2.0.0; ids
change ONLY where two declarations of one name shared an id before (a bug), never elsewhere.

## Problem

TypeScript lets one name carry several declaration facets in one scope — a value and a type
(`const TableOption = () => …` + `interface TableOption`), a type and a type (`class C` +
`interface C`, `enum E` + `namespace E`), a value and a namespace (`function f` + `namespace f`).
The analyzer minted one `can://` id per *signature*, and every facet of a name has the same
signature, so:

- `--emit neo4j` `MERGE`d the facets onto one node carrying both labels and the last writer's
  `kind` (measured on superset-frontend: `TSCallable`+`TSInterface` with `kind: arrow`, …);
- in `analysis.json`, a value/type pair survived (different maps, same id) but a type/type pair
  did not — `types{}` is keyed by name and "the later kind wins", so `class C` + `interface C`
  dropped the class from the output entirely.

Python and Java have no equivalent (a later `def` rebinds; Java forbids it), so the shape is
coined here.

## Decisions

| # | Concept | Decision | Rationale |
|---|---|---|---|
| D1 | **Which facet keeps the bare id** | The VALUE facet (callable or field) always; a type whose id is already taken by a value in the same scope becomes `<id>#type`. | Callables anchor the most: call edges, body-node ids `<callable>@line:col`, `@formal_in:N` vertices, `parameters[i].id`. Renaming a type touches `extends_ids`/`implements_ids` and decorator targets only, and those resolve through the analyzer's own map. |
| D2 | **Type/type merging** | The first type facet (builder order: class → interface → enum → type alias → namespace) keeps the bare id and the bare `types{}` key; each later facet is keyed `Name#<kind>` in `types{}` and gets id `<id>#<kind>` (`#interface`, `#enum`, `#type_alias`, `#namespace`). | Both facets must survive in JSON — the old "later wins" silently dropped one. The kind suffix is self-describing; `#type` would not distinguish two types. |
| D3 | **Only on collision** | An id is suffixed only when the bare id is already minted in this run. A project without merging is byte-identical before and after. | Every consumer's stored ids stay valid; adding a colliding facet later changes one type's id, which is the same instability class as any rename. |
| D4 | **Signatures unchanged** | `signature` stays the dotted name on every facet. `idBySig` keeps its value-facet meaning (call-graph re-identification, callee backfill, homing); heritage resolves `extends`/`implements` names through a type-facet map that prefers the type's id. The L1 id-uniqueness gate does not count a facet split as a collision. | The signature is what the resolver computes from the AST (`new X()` → `X.constructor`); changing it would break call resolution for every merged class. |
| D5 | **Neo4j** | Nothing to change: distinct ids are distinct nodes; `TS_DECLARES` from the scope points at each facet; `kind` and labels agree on every node. | The bug was the shared id, not the projection. |

## Definition of done

- A fixture with value+interface, type-alias+arrow, type-alias+const, class+interface,
  function+namespace: every facet present in `analysis.json` with a distinct id; `types{}` carries
  both facets of a type/type merge; `implements` a merged interface resolves to the `#type` facet,
  `extends` a merged class to the bare class; no L1 collision reported; body-node ids under the
  value facet unchanged.
- The graph projection of that fixture has no node with two `TS*` kind labels, and every node's
  `kind` matches its label.
- `bun test` green; ASCII/non-merging fixtures byte-identical (`-j` determinism gate).

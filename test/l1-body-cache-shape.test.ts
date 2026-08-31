import { describe, expect, test } from "bun:test";
import { populateL1Body } from "../src/schema/l1Body";
import type { AnalysisInternal, TSCallable, TSModule } from "../src/schema";

describe("l1Body tolerates a stale-cache callable (#101 fix round 1)", () => {
  test("callable missing config_accesses (call_sites present) does not throw", () => {
    // Simulates a TSCallable deserialized from a .codeanalyzer cache written before Task 7 added
    // `config_accesses` — loadCache only invalidates on analyzer_version change, not shape, so a
    // same-version warm cache can hand resetCallable an object narrower than today's TSCallable
    // contract. `call_sites` present, `config_accesses` deliberately OMITTED; `as unknown as`
    // documents this as an intentional stand-in for stale cached data, not an oversight.
    const stale = {
      body: {},
      call_sites: [
        {
          start_line: 5, start_column: 3, end_line: 5, end_column: 10, bytes: [40, 47],
          method_name: "foo", argument_types: [], type_arguments: [],
          is_constructor_call: false, is_optional_chain: false,
        },
      ],
    } as unknown as TSCallable;
    const mod = { functions: { stale }, types: {} } as unknown as TSModule;
    const app = { symbol_table: { "x.ts": mod } } as unknown as AnalysisInternal;

    expect(() => populateL1Body(app)).not.toThrow();

    const kinds = Object.values(stale.body).map((n) => n.kind);
    expect(kinds).toEqual(["call"]); // call_sites still processed normally
    expect(kinds).not.toContain("config_access"); // nothing to materialize; no crash either
  });
});

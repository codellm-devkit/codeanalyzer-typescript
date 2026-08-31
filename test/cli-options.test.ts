import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli";
import { DEFAULT_ARTIFACT_TEXT_MAX_BYTES } from "../src/options";

const cap = (...extra: string[]): number =>
  parseArgs(["--input", ".", ...extra]).artifactTextMaxBytes;

describe("--artifact-text-max-bytes", () => {
  test("defaults when absent", () => {
    expect(cap()).toBe(DEFAULT_ARTIFACT_TEXT_MAX_BYTES);
  });

  // A bad value must not silently disable truncation: NaN loses every `> cap`
  // comparison, and Number("") is 0, which would empty every artifact's source.
  test.each([["abc"], [""], ["  "], ["-1"]])("falls back on %p", (bad) => {
    expect(cap("--artifact-text-max-bytes", bad)).toBe(DEFAULT_ARTIFACT_TEXT_MAX_BYTES);
  });

  test("honors a valid value, 0 included", () => {
    expect(cap("--artifact-text-max-bytes", "4096")).toBe(4096);
    expect(cap("--artifact-text-max-bytes", "0")).toBe(0);
  });
});

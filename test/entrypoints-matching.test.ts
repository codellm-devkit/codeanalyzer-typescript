import { describe, expect, test } from "bun:test";
import { PatternError, compilePattern, matchPattern, validatePattern } from "../src/entrypoints/matching";

describe("rule pattern engine", () => {
  test("literal, alternation, star", () => {
    expect(matchPattern("@nestjs/common.Get", "@nestjs/common.Get")).toBe(true);
    expect(matchPattern("@nestjs/common.{Get,Post}", "@nestjs/common.Post")).toBe(true);
    expect(matchPattern("@nestjs/common.{Get,Post}", "@nestjs/common.Put")).toBe(false);
    expect(matchPattern("rest.viewsets.*", "rest.viewsets.ModelViewSet")).toBe(true);
    expect(matchPattern("rest.viewsets.*", "rest.viewsets.a.b")).toBe(false); // one segment only
    expect(matchPattern("{route,*.route,*.*.route}", "http.route")).toBe(true);
    expect(matchPattern("{route,*.route,*.*.route}", "a.b.c.route")).toBe(false);
    expect(matchPattern("{*,*.*}.{get,post}", "router.post")).toBe(true);
    expect(matchPattern("{*,*.*}.{get,post}", "app.v1.get")).toBe(true);
    expect(matchPattern("{*,*.*}.{get,post}", "get")).toBe(false); // needs a receiver
  });
  test("anchored and literal-safe", () => {
    expect(matchPattern("a.b", "xa.b")).toBe(false);
    expect(matchPattern("a.b", "a.bx")).toBe(false);
    expect(matchPattern("a+b.c", "a+b.c")).toBe(true); // regex metachar escaped
  });
  test("undefined never matches", () => {
    expect(matchPattern("*", undefined)).toBe(false);
  });
  test("validatePattern rejects an unclosed brace and an empty pattern", () => {
    expect(() => validatePattern("{a,b")).toThrow(PatternError);
    expect(() => validatePattern("")).toThrow(PatternError);
    expect(() => validatePattern("a.{b,*.c}")).not.toThrow();
  });
  test("compilePattern is cached", () => {
    expect(compilePattern("a.*")).toBe(compilePattern("a.*"));
  });
});

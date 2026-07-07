/** Interprocedural chains: a → b → c value flow, cross-file flow, mutual recursion. */
import { increment } from "./util";

export function c(z: number): number {
  return z + 1; // the parameter flows to the return value
}

export function b(y: number): number {
  const fromC = c(y);
  return fromC;
}

export function a(x: number): number {
  const fromB = b(x); // SUMMARY edge here: arg0 flows through b (and c) to the result
  return fromB;
}

export function viaOtherFile(x: number): number {
  return increment(x); // cross-module CALL / PARAM_IN / PARAM_OUT edges
}

export function isEven(n: number): boolean {
  if (n === 0) return true;
  return isOdd(n - 1); // mutual recursion: {isEven, isOdd} form an SCC
}

export function isOdd(n: number): boolean {
  if (n === 0) return false;
  return isEven(n - 1);
}

export function readHost(): string | undefined {
  return process.env.PAYMENT_HOST;
}
export function readFlag(): string | undefined {
  return process.env["FEATURE_FLAG"];
}
export function readDestructured(): string | undefined {
  const { NODE_OPTIONS } = process.env;
  return NODE_OPTIONS;
}
export function readVia(name: string): string | undefined {
  return process.env[name];
}
// The lone internal caller (#101 unit C3): gives the interproc tier a resolved call site with a
// literal argument, so readVia's parameter closes on "PAYMENT_HOST" at -a 4 (never at -a 3).
export function readViaResolved(): string | undefined {
  return readVia("PAYMENT_HOST");
}
export function readIndirect(): string | undefined {
  const key = "PAYMENT_HOST";
  return process.env[key];
}
// Two callers disagreeing on the literal (#101 unit C3): the interproc tier must NOT widen —
// "every resolved internal call site passes the same string literal" fails here on purpose.
export function readAmbiguous(name: string): string | undefined {
  return process.env[name];
}
export function callAmbiguousA(): string | undefined {
  return readAmbiguous("PAYMENT_HOST");
}
export function callAmbiguousB(): string | undefined {
  return readAmbiguous("FEATURE_FLAG");
}
// A reassigned local (#101 unit C3): isReassigned must block the intra tier even though the
// initializer alone is a single literal.
export function readReassigned(): string | undefined {
  let key = "PAYMENT_HOST";
  if (process.env.NODE_ENV === "test") key = "FEATURE_FLAG";
  return process.env[key];
}
// Destructuring reassignment (#101 unit C3 fix round 1): `({ key } = ...)` rebinds `key` just as
// much as `key = ...` does. isReassigned must catch this even though the tracked identifier never
// appears as the WHOLE left side of an assignment, only nested inside one.
export function readDestructuredKey(): string | undefined {
  let key = "PAYMENT_HOST";
  ({ key } = { key: "FEATURE_FLAG" });
  return process.env[key];
}
export function readUndeclared(): string | undefined {
  return process.env.NOT_DECLARED_ANYWHERE;
}
export function readList(): string[] {
  return process.env.LIST.split(",");
}
export class Client {
  private readonly host = process.env.PAYMENT_HOST;
  url(): string | undefined {
    return this.host;
  }
}
import nconf from "nconf";
export function readViaLibrary(): string | undefined {
  return nconf.get("PAYMENT_HOST");
}
export function readTemplateInterpolated(x: string): string | undefined {
  return nconf.get(`PAYMENT_${x}`);
}
export function readTemplateLiteral(): string | undefined {
  return nconf.get(`PAYMENT_HOST`);
}
export function readBuildId(): string | undefined {
  return process.env.BUILD_ID;
}

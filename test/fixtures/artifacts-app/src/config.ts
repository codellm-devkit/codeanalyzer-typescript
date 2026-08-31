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
export function readIndirect(): string | undefined {
  const key = "PAYMENT_HOST";
  return process.env[key];
}
export function readUndeclared(): string | undefined {
  return process.env.NOT_DECLARED_ANYWHERE;
}

export function greet(name: string): string {
  return `hello ${name}`;
}

export function run(): string {
  return greet("world");
}

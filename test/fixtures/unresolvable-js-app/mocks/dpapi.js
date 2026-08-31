// Deliberately OUTSIDE tsconfig's `include`, so it is discovered as source but lands in a program
// with no default lib. Resolving the global `Error` here makes the TypeScript checker throw
// rather than return undefined — the vscode crash this fixture pins down.
class defaultDpapi {
	protectData() {
		throw new Error('Dpapi bindings unavailable');
	}
	unprotectData() {
		throw new Error('Dpapi bindings unavailable');
	}
}
const Dpapi = new defaultDpapi();
export { Dpapi };

/**
 * Per-file builders: turn a ts-morph SourceFile into a canonical TSModule — NATIVELY in the
 * schema-v2 shape (types{}/functions{}/fields{} buckets, member-keyed maps, span-only containers,
 * omit-instead-of-null leaves). Mirrors the role of python's module builder. ts-morph nodes are
 * accessed via dynamic getters (cast to `any`) for brevity and resilience across node kinds; the
 * *returned* objects are strictly typed to the schema, which is what the output contract cares
 * about.
 *
 * Builders do NOT stamp `can://` ids (ids embed the per-invocation app name; the cached tree must
 * stay app-name-free — assignIds.ts stamps them per run) and do NOT build `body{}` (the l1Body
 * pass derives it per run from the INTERNAL `call_sites`).
 */
import { Node, SyntaxKind } from "ts-morph";
import {
  type TSCallable,
  type TSCallableKind,
  type TSCallsite,
  type TSComment,
  type TSDecorator,
  type TSExport,
  type TSField,
  type TSImport,
  type TSModule,
  type TSOverloadSignature,
  type TSSpan,
  type TSType,
  type TSTypeParameter,
  constructorSignatureOf,
  fileKeyOf,
} from "../schema";
import { computeSignatureForDecl } from "../schema";
import { memberKey } from "../schema/ids";

// ----------------------------------------------------------------------------------------------
// dynamic-getter helpers
// ----------------------------------------------------------------------------------------------

function boolOf(node: unknown, name: string): boolean {
  const n = node as Record<string, unknown>;
  return typeof n[name] === "function" ? !!(n[name] as () => unknown).call(n) : false;
}

/**
 * True only for a redundant overload *signature* — one that has a sibling implementation we'll
 * capture instead. Bodiless declarations with NO implementation (abstract methods, ambient
 * `declare` functions, methods on `declare`d classes) are NOT redundant and must be kept.
 */
function isRedundantOverload(node: Node): boolean {
  const n = node as unknown as { isOverload?: () => boolean; getImplementation?: () => unknown };
  if (typeof n.isOverload !== "function" || !n.isOverload()) return false;
  return typeof n.getImplementation === "function" ? n.getImplementation() !== undefined : false;
}

function clamp(s: string | undefined | null, max = 400): string | undefined {
  if (s == null) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

function inferredType(valueNode: Node): string | undefined {
  try {
    const t = (valueNode as unknown as { getType?: () => { getText: (n?: Node) => string } }).getType?.();
    if (!t) return undefined;
    return clamp(t.getText(valueNode));
  } catch {
    return undefined;
  }
}

function returnTypeText(fnNode: Node): string | undefined {
  const n = fnNode as unknown as {
    getReturnTypeNode?: () => { getText: () => string } | undefined;
    getReturnType?: () => { getText: (n?: Node) => string };
  };
  const tn = n.getReturnTypeNode?.();
  if (tn) return tn.getText();
  try {
    const rt = n.getReturnType?.();
    if (rt) return clamp(rt.getText(fnNode));
  } catch {
    /* unresolved */
  }
  return undefined;
}

function span(node: Node): { start_line: number; end_line: number; start_column: number; end_column: number } {
  const sf = node.getSourceFile();
  const s = sf.getLineAndColumnAtPos(node.getStart());
  const e = sf.getLineAndColumnAtPos(node.getEnd());
  return { start_line: s.line, end_line: e.line, start_column: s.column, end_column: e.column };
}

/**
 * schema-v2 precise span: [line, column] endpoints + char offsets into the module source.
 * `bytes = [getStart(), getEnd()]` are exactly the offsets `Node.getText()` slices, so
 * `module.source.slice(bytes[0], bytes[1])` reproduces the node's text.
 */
function richSpan(node: Node): TSSpan {
  const sf = node.getSourceFile();
  const s = node.getStart();
  const e = node.getEnd();
  const sl = sf.getLineAndColumnAtPos(s);
  const el = sf.getLineAndColumnAtPos(e);
  return { start: [sl.line, sl.column], end: [el.line, el.column], bytes: [s, e] };
}

function accessibilityOf(node: Node): string | undefined {
  const mods = (node as unknown as { getModifiers?: () => Node[] }).getModifiers?.() ?? [];
  for (const m of mods) {
    const k = m.getKind();
    if (k === SyntaxKind.PrivateKeyword) return "private";
    if (k === SyntaxKind.ProtectedKeyword) return "protected";
    if (k === SyntaxKind.PublicKeyword) return "public";
  }
  return undefined;
}

function isExportedDecl(node: Node): boolean {
  if (Node.isVariableDeclaration(node)) {
    const vs = (node as unknown as { getVariableStatement?: () => { isExported?: () => boolean } | undefined }).getVariableStatement?.();
    return vs?.isExported?.() ?? false;
  }
  return boolOf(node, "isExported");
}

function isAmbientDecl(node: Node): boolean {
  if (node.getSourceFile().isDeclarationFile()) return true;
  if (boolOf(node, "hasDeclareKeyword")) return true;
  if (Node.isVariableDeclaration(node)) {
    const vs = (node as unknown as { getVariableStatement?: () => Node | undefined }).getVariableStatement?.();
    if (vs && boolOf(vs, "hasDeclareKeyword")) return true;
  }
  for (const a of node.getAncestors()) {
    if (Node.isModuleDeclaration(a) && boolOf(a, "hasDeclareKeyword")) return true;
  }
  return false;
}

function jsDocsOf(node: Node): TSComment[] {
  const jds = (node as unknown as { getJsDocs?: () => Node[] }).getJsDocs?.();
  if (!jds || !jds.length) return [];
  return jds.map((d) => {
    const dd = d as unknown as { getInnerText?: () => string; getDescription?: () => string; getText: () => string };
    const content = (dd.getInnerText?.() ?? dd.getDescription?.() ?? dd.getText() ?? "").toString().trim();
    return { content, is_docstring: true, ...span(d) };
  });
}

function decoratorsOf(node: Node): TSDecorator[] {
  const ds = (node as unknown as { getDecorators?: () => Node[] }).getDecorators?.();
  if (!ds || !ds.length) return [];
  return ds.map((d) => {
    const dec = d as unknown as {
      getName: () => string;
      getFullName: () => string;
      isDecoratorFactory: () => boolean;
      getArguments: () => Node[];
    };
    const positional: string[] = [];
    const keyword: Record<string, string> = {};
    if (dec.isDecoratorFactory()) {
      for (const arg of dec.getArguments()) {
        if (Node.isObjectLiteralExpression(arg)) {
          for (const prop of arg.getProperties()) {
            if (Node.isPropertyAssignment(prop)) {
              keyword[prop.getName()] = prop.getInitializer()?.getText() ?? "";
            } else if (Node.isShorthandPropertyAssignment(prop)) {
              keyword[prop.getName()] = prop.getName();
            } else {
              keyword[prop.getText()] = prop.getText();
            }
          }
        } else {
          positional.push(arg.getText());
        }
      }
    }
    const qualified = dec.getFullName();
    return {
      name: dec.getName(),
      ...(qualified != null ? { qualified_name: qualified } : {}),
      positional_arguments: positional,
      keyword_arguments: keyword,
      ...span(d),
    };
  });
}

function typeParamsOf(node: Node): TSTypeParameter[] {
  const tps = (node as unknown as { getTypeParameters?: () => Node[] }).getTypeParameters?.();
  if (!tps || !tps.length) return [];
  return tps.map((tp) => {
    const t = tp as unknown as {
      getName: () => string;
      getConstraint?: () => { getText: () => string } | undefined;
      getDefault?: () => { getText: () => string } | undefined;
    };
    const constraint = t.getConstraint?.()?.getText();
    const dflt = t.getDefault?.()?.getText();
    return {
      name: t.getName(),
      ...(constraint != null ? { constraint } : {}),
      ...(dflt != null ? { default: dflt } : {}),
    };
  });
}

// ----------------------------------------------------------------------------------------------
// leaf builders
// ----------------------------------------------------------------------------------------------

function buildParam(param: Node): import("../schema").TSCallableParameter {
  const p = param as unknown as {
    getName: () => string;
    getTypeNode?: () => { getText: () => string } | undefined;
    getInitializer?: () => { getText: () => string } | undefined;
  };
  const type = p.getTypeNode?.()?.getText() ?? inferredType(param);
  const dflt = p.getInitializer?.()?.getText();
  const accessibility = accessibilityOf(param);
  return {
    name: p.getName(),
    ...(type != null ? { type } : {}),
    ...(dflt != null ? { default_value: dflt } : {}),
    is_optional: boolOf(param, "isOptional"),
    is_rest: boolOf(param, "isRestParameter"),
    is_readonly: boolOf(param, "isReadonly"),
    ...(accessibility != null ? { accessibility } : {}),
    decorators: decoratorsOf(param),
    ...span(param),
  };
}

/** A module/namespace `const`/`let`/`var` binding as a `field` node. */
function buildVariableField(vd: Node, scope: "module" | "namespace"): TSField {
  const v = vd as unknown as {
    getName: () => string;
    getTypeNode?: () => { getText: () => string } | undefined;
    getInitializer?: () => { getText: () => string } | undefined;
    getVariableStatement?: () => { isExported?: () => boolean; getDeclarationKind?: () => string } | undefined;
  };
  const vs = v.getVariableStatement?.();
  const kindRaw = String(vs?.getDeclarationKind?.() ?? "");
  const declaration_kind: TSField["declaration_kind"] = kindRaw.includes("const")
    ? "const"
    : kindRaw.includes("let")
      ? "let"
      : kindRaw.includes("var")
        ? "var"
        : kindRaw.includes("using")
          ? "using"
          : "unknown";
  const type = v.getTypeNode?.()?.getText() ?? inferredType(vd);
  const initializer = v.getInitializer?.()?.getText();
  return {
    id: "",
    kind: "field",
    span: richSpan(vd),
    name: v.getName(),
    ...(type != null ? { type } : {}),
    ...(initializer != null ? { initializer } : {}),
    scope,
    declaration_kind,
    is_readonly: declaration_kind === "const",
    is_exported: vs?.isExported?.() ?? false,
  };
}

/** A class property / interface property as a `field` node. */
function buildAttributeField(prop: Node): TSField {
  const p = prop as unknown as {
    getName: () => string;
    getTypeNode?: () => { getText: () => string } | undefined;
    getInitializer?: () => { getText: () => string } | undefined;
  };
  const type = p.getTypeNode?.()?.getText() ?? inferredType(prop);
  const initializer = p.getInitializer?.()?.getText();
  const accessibility = accessibilityOf(prop);
  return {
    id: "",
    kind: "field",
    span: richSpan(prop),
    name: p.getName(),
    ...(type != null ? { type } : {}),
    comments: jsDocsOf(prop),
    decorators: decoratorsOf(prop),
    ...(initializer != null ? { initializer } : {}),
    ...(accessibility != null ? { accessibility } : {}),
    is_static: boolOf(prop, "isStatic"),
    is_readonly: boolOf(prop, "isReadonly"),
    is_optional: boolOf(prop, "hasQuestionToken"),
    is_abstract: boolOf(prop, "isAbstract"),
  };
}

function buildCallsite(call: Node): TSCallsite {
  const isNew = Node.isNewExpression(call);
  // A tagged template (`inline\`url(...)\``) is a call whose callee is the tag.
  const expr = Node.isTaggedTemplateExpression(call)
    ? call.getTag()
    : (call as unknown as { getExpression: () => Node }).getExpression();
  let method_name = expr.getText();
  let receiver_expr: string | undefined;
  let receiver_type: string | undefined;
  let is_optional_chain = false;
  if (Node.isPropertyAccessExpression(expr)) {
    method_name = expr.getName();
    receiver_expr = expr.getExpression().getText();
    receiver_type = inferredType(expr.getExpression());
    is_optional_chain = boolOf(expr, "hasQuestionDotToken");
  }
  const args = (call as unknown as { getArguments?: () => Node[] }).getArguments?.() ?? []; // tagged templates have none
  const argument_types = args.map((a) => inferredType(a) ?? "unknown");
  const typeArgs = (call as unknown as { getTypeArguments?: () => Node[] }).getTypeArguments?.() ?? [];
  const type_arguments = typeArgs.map((t) => t.getText());
  const return_type = inferredType(call);
  return {
    method_name,
    ...(receiver_expr != null ? { receiver_expr } : {}),
    ...(receiver_type != null ? { receiver_type } : {}),
    argument_types,
    type_arguments,
    ...(return_type != null ? { return_type } : {}),
    is_constructor_call: isNew,
    is_optional_chain,
    ...span(call),
    bytes: [call.getStart(), call.getEnd()],
  };
}

// ----------------------------------------------------------------------------------------------
// body walking (own-scope attribution)
// ----------------------------------------------------------------------------------------------

type Boundary = "callable" | "class" | "skip" | null;

function namedBoundary(node: Node): Boundary {
  if (Node.isFunctionDeclaration(node)) return "callable";
  // Unnamed arrows / function expressions are callables in their own right (they carry a
  // positional signature), so their contents must not be attributed to the enclosing callable.
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return "callable";
  if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) return "class";
  if (Node.isModuleDeclaration(node)) return "skip";
  if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return "callable";
  }
  return null;
}

interface BodyHandlers {
  onCall: (n: Node) => void;
  onNestedCallable: (n: Node) => void;
  onNestedClass: (n: Node) => void;
}

function walkBody(body: Node, h: BodyHandlers): void {
  const visit = (node: Node): void => {
    const b = namedBoundary(node);
    if (b === "callable") {
      h.onNestedCallable(node);
      return;
    }
    if (b === "class") {
      h.onNestedClass(node);
      return;
    }
    if (b === "skip") return;
    if (Node.isCallExpression(node) || Node.isNewExpression(node) || Node.isTaggedTemplateExpression(node)) h.onCall(node);
    node.forEachChild(visit);
  };
  // Visit the body NODE itself, not only its children: a concise arrow body can *be* a callable
  // (`() => () => x`) — the boundary handler claims it — or *be* the call (`u => u.describe()`),
  // which a children-only walk would silently skip (the call-site gap Jelly used to paper over).
  visit(body);
}

function computeCC(body: Node): number {
  let count = 0;
  const visit = (n: Node): void => {
    if (namedBoundary(n) !== null) return; // don't count inside nested callables/classes
    switch (n.getKind()) {
      case SyntaxKind.IfStatement:
      case SyntaxKind.ConditionalExpression:
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.CaseClause:
      case SyntaxKind.CatchClause:
        count++;
        break;
      case SyntaxKind.BinaryExpression: {
        const op = (n as unknown as { getOperatorToken: () => Node }).getOperatorToken().getKind();
        if (
          op === SyntaxKind.AmpersandAmpersandToken ||
          op === SyntaxKind.BarBarToken ||
          op === SyntaxKind.QuestionQuestionToken
        )
          count++;
        break;
      }
    }
    n.forEachChild(visit);
  };
  body.forEachChild(visit);
  return count + 1;
}

// ----------------------------------------------------------------------------------------------
// callable builder
// ----------------------------------------------------------------------------------------------

function overloadsOf(fnNode: Node): TSOverloadSignature[] {
  const ovs = (fnNode as unknown as { getOverloads?: () => Node[] }).getOverloads?.();
  if (!ovs || !ovs.length) return [];
  return ovs.map((o) => {
    const return_type = returnTypeText(o);
    return {
      parameters: ((o as unknown as { getParameters?: () => Node[] }).getParameters?.() ?? []).map(buildParam),
      ...(return_type != null ? { return_type } : {}),
      type_parameters: typeParamsOf(o),
      start_line: o.getStartLineNumber(true),
      end_line: o.getEndLineNumber(),
    };
  });
}

/**
 * Build a callable from a node `walkBody` reported as a nested boundary. The three shapes are a
 * named `function` declaration, a `const f = () => …` (signed by its VariableDeclaration but bodied
 * by the initializer), and a bare unnamed arrow / function expression (signed and bodied by itself).
 */
function buildNestedCallable(n: Node, root: string): { sig: string; callable: TSCallable } | null {
  if (Node.isVariableDeclaration(n)) {
    const init = n.getInitializer();
    if (!init) return null;
    const k: TSCallableKind = Node.isArrowFunction(init) ? "arrow" : "function_expression";
    return buildCallable(n, init, k, root);
  }
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) {
    return buildCallable(n, n, Node.isArrowFunction(n) ? "arrow" : "function_expression", root);
  }
  return buildCallable(n, n, "function", root);
}

export function buildCallable(
  sigNode: Node,
  fnNode: Node,
  kind: TSCallableKind,
  root: string,
): { sig: string; callable: TSCallable } | null {
  const sig = computeSignatureForDecl(sigNode, root);
  if (!sig) return null;

  const call_sites: TSCallsite[] = [];
  const callables: Record<string, TSCallable> = {};
  const types: Record<string, TSType> = {};

  const body = (fnNode as unknown as { getBody?: () => Node | undefined }).getBody?.();
  if (body) {
    walkBody(body, {
      onCall: (n) => call_sites.push(buildCallsite(n)),
      onNestedCallable: (n) => {
        const r = buildNestedCallable(n, root);
        if (r) callables[memberKey(r.sig, r.callable.accessor_kind)] = r.callable;
      },
      onNestedClass: (n) => {
        const r = buildClass(n, root);
        types[memberKey(r.sig)] = r.cls;
      },
    });
  }

  const nameNode = sigNode as unknown as { getName?: () => string | undefined };
  const name =
    Node.isConstructorDeclaration(fnNode) ? "constructor" : (nameNode.getName?.() ?? "(anonymous)");
  const return_type = kind === "constructor" || kind === "setter" ? undefined : returnTypeText(fnNode);
  const accessibility = accessibilityOf(fnNode);
  const accessor_kind = kind === "getter" ? "getter" : kind === "setter" ? "setter" : undefined;

  const callable: TSCallable = {
    id: "",
    kind,
    span: richSpan(sigNode),
    name,
    signature: sig,
    comments: jsDocsOf(sigNode),
    decorators: decoratorsOf(fnNode),
    parameters: ((fnNode as unknown as { getParameters?: () => Node[] }).getParameters?.() ?? []).map(buildParam),
    type_parameters: typeParamsOf(fnNode),
    ...(return_type != null ? { return_type } : {}),
    cyclomatic_complexity: body ? computeCC(body) : 0,
    ...(accessibility != null ? { accessibility } : {}),
    is_static: boolOf(fnNode, "isStatic"),
    is_abstract: boolOf(fnNode, "isAbstract"),
    is_async: boolOf(fnNode, "isAsync"),
    is_generator: boolOf(fnNode, "isGenerator"),
    is_optional: boolOf(fnNode, "hasQuestionToken"),
    is_readonly: false,
    is_exported: isExportedDecl(sigNode),
    is_ambient: isAmbientDecl(sigNode),
    is_implicit: false,
    ...(accessor_kind != null ? { accessor_kind } : {}),
    overload_signatures: overloadsOf(fnNode),
    body: {},
    abs_path: sigNode.getSourceFile().getFilePath(),
    call_sites,
  };
  if (Object.keys(callables).length) callable.callables = callables;
  if (Object.keys(types).length) callable.types = types;
  return { sig, callable };
}

function implicitConstructor(classSig: string, filePath: string): { sig: string; callable: TSCallable } {
  const sig = constructorSignatureOf(classSig);
  return {
    sig,
    callable: {
      id: "",
      kind: "constructor",
      span: { start: [0, 0], end: [0, 0], bytes: [0, 0] }, // synthetic: no source
      name: "constructor",
      signature: sig,
      comments: [],
      decorators: [],
      parameters: [],
      type_parameters: [],
      cyclomatic_complexity: 0,
      is_static: false,
      is_abstract: false,
      is_async: false,
      is_generator: false,
      is_optional: false,
      is_readonly: false,
      is_exported: false,
      is_ambient: false,
      is_implicit: true,
      overload_signatures: [],
      body: {},
      abs_path: filePath,
      call_sites: [],
    },
  };
}

// ----------------------------------------------------------------------------------------------
// heritage resolution
// ----------------------------------------------------------------------------------------------

function resolveHeritage(expr: Node, root: string): string {
  try {
    const inner = (expr as unknown as { getExpression?: () => Node }).getExpression?.() ?? expr;
    let sym = (inner as unknown as { getSymbol?: () => { getAliasedSymbol?: () => unknown; getDeclarations?: () => Node[] } | undefined }).getSymbol?.();
    if (sym) {
      const aliased = (sym as { getAliasedSymbol?: () => typeof sym }).getAliasedSymbol?.();
      if (aliased) sym = aliased;
      const d = sym?.getDeclarations?.()?.[0];
      if (
        d &&
        (Node.isClassDeclaration(d) ||
          Node.isInterfaceDeclaration(d) ||
          Node.isEnumDeclaration(d) ||
          Node.isClassExpression(d))
      ) {
        const s = computeSignatureForDecl(d, root);
        if (s) return s;
      }
    }
    return inner.getText();
  } catch {
    return expr.getText();
  }
}

// ----------------------------------------------------------------------------------------------
// type-kind builders
// ----------------------------------------------------------------------------------------------

export function buildClass(cls: Node, root: string): { sig: string; cls: TSType } {
  const sig = computeSignatureForDecl(cls, root) ?? `${fileKeyOf(cls.getSourceFile().getFilePath(), root).modulePrefix}.(anonymous)`;
  const filePath = cls.getSourceFile().getFilePath();
  const c = cls as unknown as {
    getName?: () => string | undefined;
    getMethods: () => Node[];
    getConstructors: () => Node[];
    getGetAccessors: () => Node[];
    getSetAccessors: () => Node[];
    getProperties: () => Node[];
    getExtends?: () => Node | undefined;
    getImplements?: () => Node[];
  };

  const callables: Record<string, TSCallable> = {};
  for (const m of c.getMethods()) {
    if (isRedundantOverload(m)) continue;
    const r = buildCallable(m, m, "method", root);
    if (r) callables[memberKey(r.sig)] = r.callable;
  }
  const ctors = c.getConstructors();
  if (ctors.length === 0) {
    const imp = implicitConstructor(sig, filePath);
    callables[memberKey(imp.sig)] = imp.callable;
  } else {
    for (const ctor of ctors) {
      if (isRedundantOverload(ctor)) continue;
      const r = buildCallable(ctor, ctor, "constructor", root);
      if (r) callables[memberKey(r.sig)] = r.callable;
    }
  }
  for (const g of c.getGetAccessors()) {
    const r = buildCallable(g, g, "getter", root);
    if (r) callables[memberKey(r.sig, "getter")] = r.callable;
  }
  for (const s of c.getSetAccessors()) {
    const r = buildCallable(s, s, "setter", root);
    if (r) callables[memberKey(r.sig, "setter")] = r.callable;
  }

  const fields: Record<string, TSField> = {};
  for (const p of c.getProperties()) {
    fields[(p as unknown as { getName: () => string }).getName()] = buildAttributeField(p);
  }
  // parameter properties (constructor(private x: T)) are class fields too — spanless on the wire.
  for (const ctor of ctors) {
    for (const p of (ctor as unknown as { getParameters: () => Node[] }).getParameters()) {
      const acc = accessibilityOf(p);
      if (acc || boolOf(p, "isReadonly")) {
        const pn = p as unknown as { getName: () => string; getTypeNode?: () => { getText: () => string } | undefined };
        const type = pn.getTypeNode?.()?.getText() ?? inferredType(p);
        fields[pn.getName()] = {
          id: "",
          kind: "field",
          name: pn.getName(),
          ...(type != null ? { type } : {}),
          comments: [],
          decorators: decoratorsOf(p),
          ...(acc != null ? { accessibility: acc } : {}),
          is_static: false,
          is_readonly: boolOf(p, "isReadonly"),
          is_optional: boolOf(p, "isOptional"),
          is_abstract: false,
        };
      }
    }
  }

  const base_classes: string[] = [];
  const implements_types: string[] = [];
  const ext = c.getExtends?.();
  if (ext) base_classes.push(resolveHeritage(ext, root));
  for (const im of c.getImplements?.() ?? []) {
    const s = resolveHeritage(im, root);
    base_classes.push(s);
    implements_types.push(s);
  }

  return {
    sig,
    cls: {
      id: "",
      kind: "class",
      span: richSpan(cls),
      name: c.getName?.() ?? "(anonymous)",
      signature: sig,
      comments: jsDocsOf(cls),
      decorators: decoratorsOf(cls),
      base_classes,
      implements_types,
      type_parameters: typeParamsOf(cls),
      callables,
      fields,
      is_abstract: boolOf(cls, "isAbstract"),
      is_exported: isExportedDecl(cls),
      is_ambient: isAmbientDecl(cls),
    },
  };
}

export function buildInterface(intf: Node, root: string): { sig: string; intf: TSType } {
  const sig = computeSignatureForDecl(intf, root) ?? `${fileKeyOf(intf.getSourceFile().getFilePath(), root).modulePrefix}.(anonymous)`;
  const i = intf as unknown as {
    getName: () => string;
    getMethods: () => Node[];
    getProperties: () => Node[];
    getExtends?: () => Node[];
    getCallSignatures?: () => Node[];
    getConstructSignatures?: () => Node[];
    getIndexSignatures?: () => Node[];
  };
  const callables: Record<string, TSCallable> = {};
  for (const m of i.getMethods()) {
    const r = buildCallable(m, m, "method", root);
    if (r) callables[memberKey(r.sig)] = r.callable;
  }
  const fields: Record<string, TSField> = {};
  for (const p of i.getProperties()) {
    fields[(p as unknown as { getName: () => string }).getName()] = buildAttributeField(p);
  }
  const base_classes = (i.getExtends?.() ?? []).map((e) => resolveHeritage(e, root));
  const call_signatures = [
    ...(i.getCallSignatures?.() ?? []),
    ...(i.getConstructSignatures?.() ?? []),
  ].map((s) => s.getText());
  const index_signatures = (i.getIndexSignatures?.() ?? []).map((s) => s.getText());
  return {
    sig,
    intf: {
      id: "",
      kind: "interface",
      span: richSpan(intf),
      name: i.getName(),
      signature: sig,
      comments: jsDocsOf(intf),
      base_classes,
      type_parameters: typeParamsOf(intf),
      callables,
      fields,
      call_signatures,
      index_signatures,
      is_exported: isExportedDecl(intf),
      is_ambient: isAmbientDecl(intf),
    },
  };
}

export function buildEnum(en: Node, root: string): { sig: string; en: TSType } {
  const sig = computeSignatureForDecl(en, root) ?? `${fileKeyOf(en.getSourceFile().getFilePath(), root).modulePrefix}.(anonymous)`;
  const e = en as unknown as { getName: () => string; getMembers: () => Node[]; isConstEnum?: () => boolean };
  const fields: Record<string, TSField> = {};
  for (const m of e.getMembers()) {
    const mm = m as unknown as {
      getName: () => string;
      getValue?: () => string | number | undefined;
      getInitializer?: () => { getText: () => string } | undefined;
    };
    const v = mm.getValue?.();
    const value = v !== undefined && v !== null ? String(v) : mm.getInitializer?.()?.getText();
    fields[mm.getName()] = {
      id: "",
      kind: "field",
      span: richSpan(m),
      name: mm.getName(),
      ...(value != null ? { value } : {}),
    };
  }
  return {
    sig,
    en: {
      id: "",
      kind: "enum",
      span: richSpan(en),
      name: e.getName(),
      signature: sig,
      comments: jsDocsOf(en),
      fields,
      is_const: e.isConstEnum?.() ?? false,
      is_exported: isExportedDecl(en),
      is_ambient: isAmbientDecl(en),
    },
  };
}

export function buildTypeAlias(ta: Node, root: string): { sig: string; ta: TSType } {
  const sig = computeSignatureForDecl(ta, root) ?? `${fileKeyOf(ta.getSourceFile().getFilePath(), root).modulePrefix}.(anonymous)`;
  const t = ta as unknown as { getName: () => string; getTypeNode?: () => { getText: () => string } | undefined };
  return {
    sig,
    ta: {
      id: "",
      kind: "type_alias",
      span: richSpan(ta),
      name: t.getName(),
      signature: sig,
      comments: jsDocsOf(ta),
      aliased_type: t.getTypeNode?.()?.getText() ?? "",
      type_parameters: typeParamsOf(ta),
      is_exported: isExportedDecl(ta),
      is_ambient: isAmbientDecl(ta),
    },
  };
}

// ----------------------------------------------------------------------------------------------
// statemented container (Module + Namespace share this)
// ----------------------------------------------------------------------------------------------

interface ScopeBuckets {
  types: Record<string, TSType>;
  functions: Record<string, TSCallable>;
  fields: Record<string, TSField>;
}

function buildStatemented(container: Node, root: string, varScope: "module" | "namespace"): ScopeBuckets {
  const c = container as unknown as {
    getClasses: () => Node[];
    getInterfaces: () => Node[];
    getEnums: () => Node[];
    getTypeAliases: () => Node[];
    getFunctions: () => Node[];
    getModules: () => Node[];
    getVariableStatements: () => Node[];
  };
  // One types{} map. Fill order (classes → interfaces → enums → aliases → namespaces) is the
  // canonical precedence: on a member-key collision (e.g. class/interface declaration merging)
  // the later kind wins, exactly as the historical per-kind bucket merge did.
  const types: Record<string, TSType> = {};
  for (const cl of c.getClasses()) {
    const r = buildClass(cl, root);
    types[memberKey(r.sig)] = r.cls;
  }
  for (const it of c.getInterfaces()) {
    const r = buildInterface(it, root);
    types[memberKey(r.sig)] = r.intf;
  }
  for (const en of c.getEnums()) {
    const r = buildEnum(en, root);
    types[memberKey(r.sig)] = r.en;
  }
  for (const ta of c.getTypeAliases()) {
    const r = buildTypeAlias(ta, root);
    types[memberKey(r.sig)] = r.ta;
  }
  const functions: Record<string, TSCallable> = {};
  for (const fn of c.getFunctions()) {
    if (isRedundantOverload(fn)) continue;
    const r = buildCallable(fn, fn, "function", root);
    if (r) functions[memberKey(r.sig, r.callable.accessor_kind)] = r.callable;
  }
  const fields: Record<string, TSField> = {};
  for (const vs of c.getVariableStatements()) {
    for (const vd of (vs as unknown as { getDeclarations: () => Node[] }).getDeclarations()) {
      const init = (vd as unknown as { getInitializer?: () => Node | undefined }).getInitializer?.();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        const k: TSCallableKind = Node.isArrowFunction(init) ? "arrow" : "function_expression";
        const r = buildCallable(vd, init, k, root);
        if (r) functions[memberKey(r.sig)] = r.callable;
      } else {
        const f = buildVariableField(vd, varScope);
        fields[f.name] = f;
      }
    }
  }
  // Bare anonymous callables in top-level expression statements — `app.get('/x', (req, res) => …)`
  // is the dominant Express idiom and is reachable through neither getFunctions() nor
  // getVariableStatements(), which see declarations only. walkBody stops at every boundary the
  // loops above already claimed, so nothing is collected twice.
  walkBody(container, {
    onCall: () => {},
    onNestedCallable: (n) => {
      if (!Node.isArrowFunction(n) && !Node.isFunctionExpression(n)) return; // already bucketed
      const r = buildCallable(n, n, Node.isArrowFunction(n) ? "arrow" : "function_expression", root);
      if (r) functions[memberKey(r.sig)] = r.callable;
    },
    onNestedClass: () => {},
  });
  for (const ns of c.getModules()) {
    const r = buildNamespace(ns, root);
    types[memberKey(r.sig)] = r.ns;
  }
  return { types, functions, fields };
}

/** Gap A: a namespace is a nested *scope* — same buckets as a module (types/functions/fields). */
export function buildNamespace(ns: Node, root: string): { sig: string; ns: TSType } {
  const sig = computeSignatureForDecl(ns, root) ?? `${fileKeyOf(ns.getSourceFile().getFilePath(), root).modulePrefix}.(anonymous)`;
  const buckets = buildStatemented(ns, root, "namespace");
  return {
    sig,
    ns: {
      id: "",
      kind: "namespace",
      span: richSpan(ns),
      name: (ns as unknown as { getName: () => string }).getName(),
      signature: sig,
      comments: jsDocsOf(ns),
      ...buckets,
      is_exported: isExportedDecl(ns),
      is_ambient: isAmbientDecl(ns),
    },
  };
}

// ----------------------------------------------------------------------------------------------
// imports / exports / comments
// ----------------------------------------------------------------------------------------------

function buildImports(sf: Node): TSImport[] {
  const out: TSImport[] = [];
  const decls = (sf as unknown as { getImportDeclarations: () => Node[] }).getImportDeclarations();
  for (const imp of decls) {
    const i = imp as unknown as {
      getModuleSpecifierValue: () => string;
      isTypeOnly: () => boolean;
      getDefaultImport?: () => { getText: () => string } | undefined;
      getNamespaceImport?: () => { getText: () => string } | undefined;
      getNamedImports?: () => Node[];
    };
    const module = i.getModuleSpecifierValue();
    const typeOnly = i.isTypeOnly();
    const s = span(imp);
    const def = i.getDefaultImport?.();
    const ns = i.getNamespaceImport?.();
    const named = i.getNamedImports?.() ?? [];
    if (def) out.push({ module, name: def.getText(), is_type_only: typeOnly, import_kind: "default", ...s });
    if (ns) out.push({ module, name: "*", alias: ns.getText(), is_type_only: typeOnly, import_kind: "namespace", ...s });
    for (const ni of named) {
      const n = ni as unknown as { getName: () => string; getAliasNode?: () => { getText: () => string } | undefined; isTypeOnly?: () => boolean };
      const alias = n.getAliasNode?.()?.getText();
      out.push({
        module,
        name: n.getName(),
        ...(alias != null ? { alias } : {}),
        is_type_only: typeOnly || (n.isTypeOnly?.() ?? false),
        import_kind: "named",
        ...s,
      });
    }
    if (!def && !ns && named.length === 0) {
      out.push({ module, name: "", is_type_only: typeOnly, import_kind: "side_effect", ...s });
    }
  }
  return out;
}

function buildExports(sf: Node): TSExport[] {
  const out: TSExport[] = [];
  const decls = (sf as unknown as { getExportDeclarations: () => Node[] }).getExportDeclarations();
  for (const exp of decls) {
    const e = exp as unknown as {
      getModuleSpecifierValue?: () => string | undefined;
      isTypeOnly: () => boolean;
      getNamespaceExport?: () => { getNameNode?: () => { getText: () => string } } | undefined;
      getNamedExports?: () => Node[];
    };
    const module = e.getModuleSpecifierValue?.();
    const typeOnly = e.isTypeOnly();
    const s = span(exp);
    const nsExp = e.getNamespaceExport?.();
    const named = e.getNamedExports?.() ?? [];
    if (nsExp) {
      const alias = nsExp.getNameNode?.()?.getText();
      out.push({
        ...(module != null ? { module } : {}),
        name: "*",
        ...(alias != null ? { alias } : {}),
        is_type_only: typeOnly,
        export_kind: module ? "re_export" : "namespace",
        ...s,
      });
    }
    for (const ne of named) {
      const n = ne as unknown as { getName: () => string; getAliasNode?: () => { getText: () => string } | undefined };
      const alias = n.getAliasNode?.()?.getText();
      out.push({
        ...(module != null ? { module } : {}),
        name: n.getName(),
        ...(alias != null ? { alias } : {}),
        is_type_only: typeOnly,
        export_kind: module ? "re_export" : "named",
        ...s,
      });
    }
    if (!nsExp && named.length === 0 && module) {
      // `export * from "m"` with no namespace binding
      out.push({ module, name: "*", is_type_only: typeOnly, export_kind: "re_export", ...s });
    }
  }
  return out;
}

function collectComments(sf: Node): TSComment[] {
  const out: TSComment[] = [];
  const seen = new Set<number>();
  const sfc = sf as unknown as {
    getStatementsWithComments?: () => Node[];
    getStatements?: () => Node[];
    getLineAndColumnAtPos: (pos: number) => { line: number; column: number };
  };
  const statements = sfc.getStatementsWithComments?.() ?? sfc.getStatements?.() ?? [];
  for (const stmt of statements) {
    const ranges = (stmt as unknown as { getLeadingCommentRanges?: () => Node[] }).getLeadingCommentRanges?.() ?? [];
    for (const cr of ranges) {
      const r = cr as unknown as { getPos: () => number; getEnd: () => number; getText: () => string };
      const pos = r.getPos();
      if (seen.has(pos)) continue;
      seen.add(pos);
      const text = r.getText();
      const startLc = sfc.getLineAndColumnAtPos(r.getPos());
      const endLc = sfc.getLineAndColumnAtPos(r.getEnd());
      out.push({
        content: text,
        is_docstring: text.startsWith("/**"),
        start_line: startLc.line,
        end_line: endLc.line,
        start_column: startLc.column,
        end_column: endLc.column,
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------------------------
// module builder (entry point)
// ----------------------------------------------------------------------------------------------

export function buildModule(sf: Node, root: string): TSModule {
  const filePath = sf.getSourceFile().getFilePath();
  const buckets = buildStatemented(sf, root, "module");
  // schema-v2: retain the whole file text once on the module; every node's text slices off it.
  const source = (sf as unknown as { getFullText: () => string }).getFullText();
  const endLc = sf.getSourceFile().getLineAndColumnAtPos(source.length);
  return {
    id: "",
    kind: "module",
    span: { start: [1, 1], end: [endLc.line, endLc.column], bytes: [0, source.length] },
    source,
    imports: buildImports(sf),
    exports: buildExports(sf),
    comments: collectComments(sf),
    ...buckets,
    is_tsx: filePath.endsWith(".tsx"),
    is_declaration_file: (sf as unknown as { isDeclarationFile: () => boolean }).isDeclarationFile(),
  };
}

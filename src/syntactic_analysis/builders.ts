/**
 * Per-file builders: turn a ts-morph SourceFile into a canonical TSModule. Mirrors the role of
 * Python's `build_pymodule_from_file`. ts-morph nodes are accessed via dynamic getters (cast to
 * `any`) for brevity and resilience across node kinds; the *returned* objects are strictly typed
 * to the schema, which is what the output contract cares about.
 */
import { Node, SyntaxKind } from "ts-morph";
import {
  type TSCallable,
  type TSCallableKind,
  type TSCallsite,
  type TSClass,
  type TSClassAttribute,
  type TSComment,
  type TSDecorator,
  type TSEnum,
  type TSExport,
  type TSImport,
  type TSInterface,
  type TSModule,
  type TSNamespace,
  type TSOverloadSignature,
  type TSTypeAlias,
  type TSTypeParameter,
  type TSVariableDeclaration,
  constructorSignatureOf,
  fileKeyOf,
} from "../schema";
import { computeSignatureForDecl } from "../schema";

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

function clamp(s: string | undefined | null, max = 400): string | null {
  if (s == null) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function inferredType(valueNode: Node): string | null {
  try {
    const t = (valueNode as unknown as { getType?: () => { getText: (n?: Node) => string } }).getType?.();
    if (!t) return null;
    return clamp(t.getText(valueNode));
  } catch {
    return null;
  }
}

function returnTypeText(fnNode: Node): string | null {
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
  return null;
}

function span(node: Node): { start_line: number; end_line: number; start_column: number; end_column: number } {
  const sf = node.getSourceFile();
  const s = sf.getLineAndColumnAtPos(node.getStart());
  const e = sf.getLineAndColumnAtPos(node.getEnd());
  return { start_line: s.line, end_line: e.line, start_column: s.column, end_column: e.column };
}

function declLines(node: Node): { start_line: number; end_line: number; code_start_line: number } {
  return {
    start_line: node.getStartLineNumber(true),
    end_line: node.getEndLineNumber(),
    code_start_line: node.getStartLineNumber(false),
  };
}

function accessibilityOf(node: Node): string | null {
  const mods = (node as unknown as { getModifiers?: () => Node[] }).getModifiers?.() ?? [];
  for (const m of mods) {
    const k = m.getKind();
    if (k === SyntaxKind.PrivateKeyword) return "private";
    if (k === SyntaxKind.ProtectedKeyword) return "protected";
    if (k === SyntaxKind.PublicKeyword) return "public";
  }
  return null;
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
    return {
      name: dec.getName(),
      qualified_name: dec.getFullName() ?? null,
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
    return {
      name: t.getName(),
      constraint: t.getConstraint?.()?.getText() ?? null,
      default: t.getDefault?.()?.getText() ?? null,
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
  return {
    name: p.getName(),
    type: p.getTypeNode?.()?.getText() ?? inferredType(param),
    default_value: p.getInitializer?.()?.getText() ?? null,
    is_optional: boolOf(param, "isOptional"),
    is_rest: boolOf(param, "isRestParameter"),
    is_readonly: boolOf(param, "isReadonly"),
    accessibility: accessibilityOf(param),
    decorators: decoratorsOf(param),
    ...span(param),
  };
}

function buildVariable(vd: Node, scope: TSVariableDeclaration["scope"]): TSVariableDeclaration {
  const v = vd as unknown as {
    getName: () => string;
    getTypeNode?: () => { getText: () => string } | undefined;
    getInitializer?: () => { getText: () => string } | undefined;
    getVariableStatement?: () => { isExported?: () => boolean; getDeclarationKind?: () => string } | undefined;
  };
  const vs = v.getVariableStatement?.();
  const kindRaw = String(vs?.getDeclarationKind?.() ?? "");
  const declaration_kind: TSVariableDeclaration["declaration_kind"] = kindRaw.includes("const")
    ? "const"
    : kindRaw.includes("let")
      ? "let"
      : kindRaw.includes("var")
        ? "var"
        : kindRaw.includes("using")
          ? "using"
          : "unknown";
  return {
    name: v.getName(),
    type: v.getTypeNode?.()?.getText() ?? inferredType(vd),
    initializer: v.getInitializer?.()?.getText() ?? null,
    value: null,
    scope,
    declaration_kind,
    is_readonly: declaration_kind === "const",
    is_exported: vs?.isExported?.() ?? false,
    ...span(vd),
  };
}

function buildAttribute(prop: Node): TSClassAttribute {
  const p = prop as unknown as {
    getName: () => string;
    getTypeNode?: () => { getText: () => string } | undefined;
    getInitializer?: () => { getText: () => string } | undefined;
  };
  return {
    name: p.getName(),
    type: p.getTypeNode?.()?.getText() ?? inferredType(prop),
    comments: jsDocsOf(prop),
    decorators: decoratorsOf(prop),
    initializer: p.getInitializer?.()?.getText() ?? null,
    accessibility: accessibilityOf(prop),
    is_static: boolOf(prop, "isStatic"),
    is_readonly: boolOf(prop, "isReadonly"),
    is_optional: boolOf(prop, "hasQuestionToken"),
    is_abstract: boolOf(prop, "isAbstract"),
    start_line: prop.getStartLineNumber(true),
    end_line: prop.getEndLineNumber(),
  };
}

function buildCallsite(call: Node): TSCallsite {
  const isNew = Node.isNewExpression(call);
  const expr = (call as unknown as { getExpression: () => Node }).getExpression();
  let method_name = expr.getText();
  let receiver_expr: string | null = null;
  let receiver_type: string | null = null;
  let is_optional_chain = false;
  if (Node.isPropertyAccessExpression(expr)) {
    method_name = expr.getName();
    receiver_expr = expr.getExpression().getText();
    receiver_type = inferredType(expr.getExpression());
    is_optional_chain = boolOf(expr, "hasQuestionDotToken");
  }
  const args = (call as unknown as { getArguments: () => Node[] }).getArguments();
  const argument_types = args.map((a) => inferredType(a) ?? "unknown");
  const typeArgs = (call as unknown as { getTypeArguments?: () => Node[] }).getTypeArguments?.() ?? [];
  const type_arguments = typeArgs.map((t) => t.getText());
  return {
    method_name,
    receiver_expr,
    receiver_type,
    argument_types,
    type_arguments,
    return_type: inferredType(call),
    callee_signature: null,
    is_constructor_call: isNew,
    is_optional_chain,
    ...span(call),
  };
}

// ----------------------------------------------------------------------------------------------
// body walking (own-scope attribution)
// ----------------------------------------------------------------------------------------------

type Boundary = "callable" | "class" | "skip" | null;

function namedBoundary(node: Node): Boundary {
  if (Node.isFunctionDeclaration(node)) return "callable";
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
  onLocal: (vd: Node) => void;
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
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) h.onCall(node);
    if (Node.isVariableDeclaration(node)) h.onLocal(node);
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
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
  return ovs.map((o) => ({
    parameters: ((o as unknown as { getParameters?: () => Node[] }).getParameters?.() ?? []).map(buildParam),
    return_type: returnTypeText(o),
    type_parameters: typeParamsOf(o),
    start_line: o.getStartLineNumber(true),
    end_line: o.getEndLineNumber(),
  }));
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
  const local_variables: TSVariableDeclaration[] = [];
  const inner_callables: Record<string, TSCallable> = {};
  const inner_classes: Record<string, TSClass> = {};

  const body = (fnNode as unknown as { getBody?: () => Node | undefined }).getBody?.();
  if (body) {
    walkBody(body, {
      onCall: (n) => call_sites.push(buildCallsite(n)),
      onLocal: (vd) => local_variables.push(buildVariable(vd, "function")),
      onNestedCallable: (n) => {
        if (Node.isVariableDeclaration(n)) {
          const init = n.getInitializer();
          if (!init) return;
          const k: TSCallableKind = Node.isArrowFunction(init) ? "arrow" : "function_expression";
          const r = buildCallable(n, init, k, root);
          if (r) inner_callables[r.sig] = r.callable;
        } else {
          const r = buildCallable(n, n, "function", root);
          if (r) inner_callables[r.sig] = r.callable;
        }
      },
      onNestedClass: (n) => {
        const r = buildClass(n, root);
        inner_classes[r.sig] = r.cls;
      },
    });
  }

  const nameNode = sigNode as unknown as { getName?: () => string | undefined };
  const name =
    Node.isConstructorDeclaration(fnNode) ? "constructor" : (nameNode.getName?.() ?? "(anonymous)");

  const callable: TSCallable = {
    name,
    path: sigNode.getSourceFile().getFilePath(),
    signature: sig,
    comments: jsDocsOf(sigNode),
    decorators: decoratorsOf(fnNode),
    parameters: ((fnNode as unknown as { getParameters?: () => Node[] }).getParameters?.() ?? []).map(buildParam),
    type_parameters: typeParamsOf(fnNode),
    return_type: kind === "constructor" || kind === "setter" ? null : returnTypeText(fnNode),
    code: clamp(sigNode.getText(), 20000),
    ...declLines(sigNode),
    accessed_symbols: [],
    call_sites,
    inner_callables,
    inner_classes,
    local_variables,
    cyclomatic_complexity: body ? computeCC(body) : 0,
    entrypoints: [],
    kind,
    accessibility: accessibilityOf(fnNode),
    is_static: boolOf(fnNode, "isStatic"),
    is_abstract: boolOf(fnNode, "isAbstract"),
    is_async: boolOf(fnNode, "isAsync"),
    is_generator: boolOf(fnNode, "isGenerator"),
    is_optional: boolOf(fnNode, "hasQuestionToken"),
    is_readonly: false,
    is_exported: isExportedDecl(sigNode),
    is_ambient: isAmbientDecl(sigNode),
    is_implicit: false,
    accessor_kind: kind === "getter" ? "getter" : kind === "setter" ? "setter" : null,
    overload_signatures: overloadsOf(fnNode),
  };
  return { sig, callable };
}

function implicitConstructor(classSig: string, filePath: string): { sig: string; callable: TSCallable } {
  const sig = constructorSignatureOf(classSig);
  return {
    sig,
    callable: {
      name: "constructor",
      path: filePath,
      signature: sig,
      comments: [],
      decorators: [],
      parameters: [],
      type_parameters: [],
      return_type: null,
      code: null,
      start_line: -1,
      end_line: -1,
      code_start_line: -1,
      accessed_symbols: [],
      call_sites: [],
      inner_callables: {},
      inner_classes: {},
      local_variables: [],
      cyclomatic_complexity: 0,
      entrypoints: [],
      kind: "constructor",
      accessibility: null,
      is_static: false,
      is_abstract: false,
      is_async: false,
      is_generator: false,
      is_optional: false,
      is_readonly: false,
      is_exported: false,
      is_ambient: false,
      is_implicit: true,
      accessor_kind: null,
      overload_signatures: [],
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

export function buildClass(cls: Node, root: string): { sig: string; cls: TSClass } {
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

  const methods: Record<string, TSCallable> = {};
  for (const m of c.getMethods()) {
    if (isRedundantOverload(m)) continue;
    const r = buildCallable(m, m, "method", root);
    if (r) methods[r.sig] = r.callable;
  }
  const ctors = c.getConstructors();
  if (ctors.length === 0) {
    const imp = implicitConstructor(sig, filePath);
    methods[imp.sig] = imp.callable;
  } else {
    for (const ctor of ctors) {
      if (isRedundantOverload(ctor)) continue;
      const r = buildCallable(ctor, ctor, "constructor", root);
      if (r) methods[r.sig] = r.callable;
    }
  }
  for (const g of c.getGetAccessors()) {
    const r = buildCallable(g, g, "getter", root);
    if (r) methods[`${r.sig}#get`] = r.callable;
  }
  for (const s of c.getSetAccessors()) {
    const r = buildCallable(s, s, "setter", root);
    if (r) methods[`${r.sig}#set`] = r.callable;
  }

  const attributes: Record<string, TSClassAttribute> = {};
  for (const p of c.getProperties()) {
    attributes[(p as unknown as { getName: () => string }).getName()] = buildAttribute(p);
  }
  // parameter properties (constructor(private x: T)) are class fields too
  for (const ctor of ctors) {
    for (const p of (ctor as unknown as { getParameters: () => Node[] }).getParameters()) {
      const acc = accessibilityOf(p);
      if (acc || boolOf(p, "isReadonly")) {
        const pn = p as unknown as { getName: () => string; getTypeNode?: () => { getText: () => string } | undefined };
        attributes[pn.getName()] = {
          name: pn.getName(),
          type: pn.getTypeNode?.()?.getText() ?? inferredType(p),
          comments: [],
          decorators: decoratorsOf(p),
          initializer: null,
          accessibility: acc,
          is_static: false,
          is_readonly: boolOf(p, "isReadonly"),
          is_optional: boolOf(p, "isOptional"),
          is_abstract: false,
          start_line: p.getStartLineNumber(true),
          end_line: p.getEndLineNumber(),
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
      name: c.getName?.() ?? "(anonymous)",
      signature: sig,
      comments: jsDocsOf(cls),
      code: clamp(cls.getText(), 20000),
      decorators: decoratorsOf(cls),
      base_classes,
      implements_types,
      type_parameters: typeParamsOf(cls),
      methods,
      attributes,
      inner_classes: {},
      entrypoints: [],
      is_abstract: boolOf(cls, "isAbstract"),
      is_exported: isExportedDecl(cls),
      is_ambient: isAmbientDecl(cls),
      start_line: cls.getStartLineNumber(true),
      end_line: cls.getEndLineNumber(),
    },
  };
}

export function buildInterface(intf: Node, root: string): { sig: string; intf: TSInterface } {
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
  const methods: Record<string, TSCallable> = {};
  for (const m of i.getMethods()) {
    const r = buildCallable(m, m, "method", root);
    if (r) methods[r.sig] = r.callable;
  }
  const properties: Record<string, TSClassAttribute> = {};
  for (const p of i.getProperties()) {
    properties[(p as unknown as { getName: () => string }).getName()] = buildAttribute(p);
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
      name: i.getName(),
      signature: sig,
      comments: jsDocsOf(intf),
      code: clamp(intf.getText(), 20000),
      base_classes,
      type_parameters: typeParamsOf(intf),
      methods,
      properties,
      call_signatures,
      index_signatures,
      is_exported: isExportedDecl(intf),
      is_ambient: isAmbientDecl(intf),
      start_line: intf.getStartLineNumber(true),
      end_line: intf.getEndLineNumber(),
    },
  };
}

export function buildEnum(en: Node, root: string): { sig: string; en: TSEnum } {
  const sig = computeSignatureForDecl(en, root) ?? `${fileKeyOf(en.getSourceFile().getFilePath(), root).modulePrefix}.(anonymous)`;
  const e = en as unknown as { getName: () => string; getMembers: () => Node[]; isConstEnum?: () => boolean };
  const members = e.getMembers().map((m) => {
    const mm = m as unknown as {
      getName: () => string;
      getValue?: () => string | number | undefined;
      getInitializer?: () => { getText: () => string } | undefined;
    };
    const v = mm.getValue?.();
    return {
      name: mm.getName(),
      value: v !== undefined && v !== null ? String(v) : (mm.getInitializer?.()?.getText() ?? null),
      start_line: m.getStartLineNumber(true),
      end_line: m.getEndLineNumber(),
    };
  });
  return {
    sig,
    en: {
      name: e.getName(),
      signature: sig,
      comments: jsDocsOf(en),
      code: clamp(en.getText(), 20000),
      members,
      is_const: e.isConstEnum?.() ?? false,
      is_exported: isExportedDecl(en),
      is_ambient: isAmbientDecl(en),
      start_line: en.getStartLineNumber(true),
      end_line: en.getEndLineNumber(),
    },
  };
}

export function buildTypeAlias(ta: Node, root: string): { sig: string; ta: TSTypeAlias } {
  const sig = computeSignatureForDecl(ta, root) ?? `${fileKeyOf(ta.getSourceFile().getFilePath(), root).modulePrefix}.(anonymous)`;
  const t = ta as unknown as { getName: () => string; getTypeNode?: () => { getText: () => string } | undefined };
  return {
    sig,
    ta: {
      name: t.getName(),
      signature: sig,
      comments: jsDocsOf(ta),
      code: clamp(ta.getText(), 20000),
      aliased_type: t.getTypeNode?.()?.getText() ?? "",
      type_parameters: typeParamsOf(ta),
      is_exported: isExportedDecl(ta),
      is_ambient: isAmbientDecl(ta),
      start_line: ta.getStartLineNumber(true),
      end_line: ta.getEndLineNumber(),
    },
  };
}

// ----------------------------------------------------------------------------------------------
// statemented container (Module + Namespace share this)
// ----------------------------------------------------------------------------------------------

interface Buckets {
  classes: Record<string, TSClass>;
  interfaces: Record<string, TSInterface>;
  enums: Record<string, TSEnum>;
  type_aliases: Record<string, TSTypeAlias>;
  functions: Record<string, TSCallable>;
  namespaces: Record<string, TSNamespace>;
  variables: TSVariableDeclaration[];
}

function buildStatemented(container: Node, root: string, varScope: TSVariableDeclaration["scope"]): Buckets {
  const c = container as unknown as {
    getClasses: () => Node[];
    getInterfaces: () => Node[];
    getEnums: () => Node[];
    getTypeAliases: () => Node[];
    getFunctions: () => Node[];
    getModules: () => Node[];
    getVariableStatements: () => Node[];
  };
  const classes: Record<string, TSClass> = {};
  for (const cl of c.getClasses()) {
    const r = buildClass(cl, root);
    classes[r.sig] = r.cls;
  }
  const interfaces: Record<string, TSInterface> = {};
  for (const it of c.getInterfaces()) {
    const r = buildInterface(it, root);
    interfaces[r.sig] = r.intf;
  }
  const enums: Record<string, TSEnum> = {};
  for (const en of c.getEnums()) {
    const r = buildEnum(en, root);
    enums[r.sig] = r.en;
  }
  const type_aliases: Record<string, TSTypeAlias> = {};
  for (const ta of c.getTypeAliases()) {
    const r = buildTypeAlias(ta, root);
    type_aliases[r.sig] = r.ta;
  }
  const functions: Record<string, TSCallable> = {};
  for (const fn of c.getFunctions()) {
    if (isRedundantOverload(fn)) continue;
    const r = buildCallable(fn, fn, "function", root);
    if (r) functions[r.sig] = r.callable;
  }
  const variables: TSVariableDeclaration[] = [];
  for (const vs of c.getVariableStatements()) {
    for (const vd of (vs as unknown as { getDeclarations: () => Node[] }).getDeclarations()) {
      const init = (vd as unknown as { getInitializer?: () => Node | undefined }).getInitializer?.();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        const k: TSCallableKind = Node.isArrowFunction(init) ? "arrow" : "function_expression";
        const r = buildCallable(vd, init, k, root);
        if (r) functions[r.sig] = r.callable;
      } else {
        variables.push(buildVariable(vd, varScope));
      }
    }
  }
  const namespaces: Record<string, TSNamespace> = {};
  for (const ns of c.getModules()) {
    const r = buildNamespace(ns, root);
    namespaces[r.sig] = r.ns;
  }
  return { classes, interfaces, enums, type_aliases, functions, namespaces, variables };
}

export function buildNamespace(ns: Node, root: string): { sig: string; ns: TSNamespace } {
  const sig = computeSignatureForDecl(ns, root) ?? `${fileKeyOf(ns.getSourceFile().getFilePath(), root).modulePrefix}.(anonymous)`;
  const buckets = buildStatemented(ns, root, "namespace");
  return {
    sig,
    ns: {
      name: (ns as unknown as { getName: () => string }).getName(),
      signature: sig,
      comments: jsDocsOf(ns),
      ...buckets,
      is_exported: isExportedDecl(ns),
      is_ambient: isAmbientDecl(ns),
      start_line: ns.getStartLineNumber(true),
      end_line: ns.getEndLineNumber(),
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
    if (def) out.push({ module, name: def.getText(), alias: null, is_type_only: typeOnly, import_kind: "default", ...s });
    if (ns) out.push({ module, name: "*", alias: ns.getText(), is_type_only: typeOnly, import_kind: "namespace", ...s });
    for (const ni of named) {
      const n = ni as unknown as { getName: () => string; getAliasNode?: () => { getText: () => string } | undefined; isTypeOnly?: () => boolean };
      out.push({
        module,
        name: n.getName(),
        alias: n.getAliasNode?.()?.getText() ?? null,
        is_type_only: typeOnly || (n.isTypeOnly?.() ?? false),
        import_kind: "named",
        ...s,
      });
    }
    if (!def && !ns && named.length === 0) {
      out.push({ module, name: "", alias: null, is_type_only: typeOnly, import_kind: "side_effect", ...s });
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
    const module = e.getModuleSpecifierValue?.() ?? null;
    const typeOnly = e.isTypeOnly();
    const s = span(exp);
    const nsExp = e.getNamespaceExport?.();
    const named = e.getNamedExports?.() ?? [];
    if (nsExp) {
      out.push({ module, name: "*", alias: nsExp.getNameNode?.()?.getText() ?? null, is_type_only: typeOnly, export_kind: module ? "re_export" : "namespace", ...s });
    }
    for (const ne of named) {
      const n = ne as unknown as { getName: () => string; getAliasNode?: () => { getText: () => string } | undefined };
      out.push({ module, name: n.getName(), alias: n.getAliasNode?.()?.getText() ?? null, is_type_only: typeOnly, export_kind: module ? "re_export" : "named", ...s });
    }
    if (!nsExp && named.length === 0 && module) {
      // `export * from "m"` with no namespace binding
      out.push({ module, name: "*", alias: null, is_type_only: typeOnly, export_kind: "re_export", ...s });
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
  const { fileKey, modulePrefix } = fileKeyOf(filePath, root);
  const buckets = buildStatemented(sf, root, "module");
  return {
    file_path: fileKey,
    module_name: modulePrefix,
    imports: buildImports(sf),
    exports: buildExports(sf),
    comments: collectComments(sf),
    classes: buckets.classes,
    interfaces: buckets.interfaces,
    enums: buckets.enums,
    type_aliases: buckets.type_aliases,
    functions: buckets.functions,
    namespaces: buckets.namespaces,
    variables: buckets.variables,
    is_tsx: filePath.endsWith(".tsx"),
    is_declaration_file: (sf as unknown as { isDeclarationFile: () => boolean }).isDeclarationFile(),
    content_hash: null,
    last_modified: null,
    file_size: null,
  };
}

/**
 * Stage 1 — exceptional CFG per callable, lowered directly from the ts-morph AST.
 *
 * Shape: statement-level nodes plus one `param` node per formal, between a synthetic ENTRY (id 0)
 * and a synthetic EXIT (last id). Node ids are the source-span order of the owning AST nodes
 * within the callable, so they are stable across runs on identical content.
 *
 * TS lowering rules (each asserted by the fixture gate tests):
 *  - if/loops/switch: the control statement itself is the condition-carrying node; branches get
 *    `true`/`false` edges, the loop back edge is `loop_back`, switch dispatch is `switch_case`
 *    (clause fallthrough between non-terminated clauses is `fallthrough`).
 *  - A `for` node carries its init/condition/incrementor as one node; `for-of`/`for-in` nodes
 *    bind the iteration variable.
 *  - Multi-exit is normalized: `return` → EXIT (`return` edge), fall-off-end → EXIT
 *    (`fallthrough`), `throw` → nearest enclosing handler or EXIT (`exception`).
 *  - Exceptional edges are over-approximate: every node whose expression contains a call / `new` /
 *    `await` / tagged template — and every `throw` — gets an `exception` edge to the nearest
 *    enclosing catch node, else the enclosing finally block, else EXIT. Bare property reads are
 *    NOT treated as throwing (documented unsoundness for TypeError-on-undefined).
 *  - try/catch/finally: region splicing, not duplication — try-body throwers edge to the catch
 *    node (which binds the exception variable), catch-body throwers to the finally entry or
 *    outward; a finally block's exits additionally edge to the outer handler (`exception`),
 *    over-approximating the rethrow continuation.
 *  - `await` / `yield`: the suspending statement's outgoing normal edge is kind `await_resume` /
 *    `yield` (resumption), per the shared vocabulary.
 *  - Short-circuit (`&&`/`||`/`??`), ternaries, and optional chaining stay intra-statement: they
 *    do not split nodes; their reads are attributed to the containing statement
 *    (over-approximation, recorded in SCHEMA_DECISIONS.md).
 *  - Infinite loops (`while (true)` / `for (;;)`): the dead loop-exit `false` edge is still
 *    emitted from the loop header, which is exactly the synthetic edge post-dominance needs.
 *  - Nested callables (arrows, function expressions, declarations): the declaring statement is a
 *    single node in the enclosing CFG; the nested body gets its own CFG (closure capture is a
 *    def-use concern, stage 3).
 */
import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { CfgEdge, CfgEdgeKind } from "../schema";
import type { DfNode, FunctionCfgBuild } from "./model";

/** A dangling forward edge: source node emitted, target not yet known. */
interface Dangling {
  from: number;
  kind: CfgEdgeKind;
}

/** Result of lowering a statement (list): its entry node and the dangling normal exits. */
interface Lowered {
  entry: number | null; // null ⇒ the region is empty (control passes straight through)
  exits: Dangling[];
}

interface LoopLabel {
  breaks: Dangling[];
  continueHeader: number | null;
}

interface LowerCtx {
  /** Nearest enclosing handler node (catch node / finally entry) or EXIT. */
  exceptionTarget: number;
  /** Break/continue sinks of the nearest enclosing loop/switch. */
  nearestBreaks: Dangling[] | null;
  nearestContinueHeader: number | null;
  labels: Map<string, LoopLabel>;
}

export function buildCfg(signature: string, fn: Node): FunctionCfgBuild | null {
  const body = getBodyNode(fn);
  if (!body) return null; // ambient / abstract / overload signature / implicit ctor — no graph
  const sf = fn.getSourceFile();

  // ---- pass 1: collect the node universe and assign span-ordered ids ----
  const astNodes: Node[] = [];
  const params = getParameters(fn);
  for (const p of params) astNodes.push(p);
  collectStatementNodes(body, astNodes);
  astNodes.sort((a, b) => a.getStart() - b.getStart() || b.getEnd() - a.getEnd());

  const nodes: DfNode[] = [{ id: 0, kind: "entry", ast: null }];
  const idOf = new Map<Node, number>();
  for (const [i, n] of astNodes.entries()) {
    const id = i + 1;
    idOf.set(n, id);
    nodes.push({ id, kind: Node.isParameterDeclaration(n) ? "param" : "statement", ast: n });
  }
  const exitId = astNodes.length + 1;
  nodes.push({ id: exitId, kind: "exit", ast: null });

  // ---- pass 2: lower to edges ----
  const edgeSet = new Set<string>();
  const edges: CfgEdge[] = [];
  const addEdge = (source: number, target: number, kind: CfgEdgeKind): void => {
    const k = `${source}>${target}>${kind}`;
    if (edgeSet.has(k)) return;
    edgeSet.add(k);
    edges.push({ source, target, kind });
  };

  const lower = new Lowerer(idOf, addEdge, exitId);
  const ctx: LowerCtx = {
    exceptionTarget: exitId,
    nearestBreaks: null,
    nearestContinueHeader: null,
    labels: new Map(),
  };

  // ENTRY → params (in order) → body.
  let cursor: Dangling[] = [{ from: 0, kind: "fallthrough" }];
  const paramIds: number[] = [];
  for (const p of params) {
    const pid = idOf.get(p) as number;
    paramIds.push(pid);
    for (const d of cursor) addEdge(d.from, pid, d.kind);
    cursor = [{ from: pid, kind: "fallthrough" }];
  }

  let bodyLowered: Lowered;
  if (Node.isBlock(body)) {
    bodyLowered = lower.statements(body.getStatements(), ctx);
  } else {
    // Arrow expression body: one statement node, implicit return.
    const id = idOf.get(body) as number;
    lower.exceptionEdgeIfThrows(body, id, ctx);
    addEdge(id, exitId, "return");
    bodyLowered = { entry: id, exits: [] };
  }

  if (bodyLowered.entry !== null) {
    for (const d of cursor) addEdge(d.from, bodyLowered.entry, d.kind);
    cursor = bodyLowered.exits;
  }
  // Fall-off-end → EXIT.
  for (const d of cursor) addEdge(d.from, exitId, d.kind);

  return { signature, fn, sf, nodes, edges, entryId: 0, exitId, paramIds };
}

// ------------------------------------------------------------------------------------------------
// Node collection (pass 1)
// ------------------------------------------------------------------------------------------------

/** Statements (and catch clauses) that become CFG nodes, recursing only through control structure. */
function collectStatementNodes(node: Node, out: Node[]): void {
  const stmts = Node.isBlock(node) ? node.getStatements() : [node];
  for (const s of stmts) {
    if (Node.isBlock(s)) {
      collectStatementNodes(s, out);
    } else if (Node.isLabeledStatement(s)) {
      collectStatementNodes(s.getStatement(), out);
    } else if (Node.isIfStatement(s)) {
      out.push(s);
      collectStatementNodes(s.getThenStatement(), out);
      const els = s.getElseStatement();
      if (els) collectStatementNodes(els, out);
    } else if (
      Node.isWhileStatement(s) ||
      Node.isDoStatement(s) ||
      Node.isForStatement(s) ||
      Node.isForOfStatement(s) ||
      Node.isForInStatement(s)
    ) {
      out.push(s);
      collectStatementNodes(s.getStatement(), out);
    } else if (Node.isSwitchStatement(s)) {
      out.push(s);
      for (const clause of s.getClauses()) for (const cs of clause.getStatements()) collectStatementNodes(cs, out);
    } else if (Node.isTryStatement(s)) {
      collectStatementNodes(s.getTryBlock(), out);
      const cc = s.getCatchClause();
      if (cc) {
        out.push(cc);
        collectStatementNodes(cc.getBlock(), out);
      }
      const fin = s.getFinallyBlock();
      if (fin) collectStatementNodes(fin, out);
    } else {
      // Leaf statement: expression / variable / return / throw / break / continue / nested
      // function or class declaration / debugger / empty. One node; nested bodies excluded.
      out.push(s);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Lowering (pass 2)
// ------------------------------------------------------------------------------------------------

class Lowerer {
  constructor(
    private idOf: Map<Node, number>,
    private addEdge: (s: number, t: number, k: CfgEdgeKind) => void,
    private exitId: number,
  ) {}

  statements(stmts: readonly Node[], ctx: LowerCtx): Lowered {
    let entry: number | null = null;
    let cursor: Dangling[] | null = null; // null before the first statement
    for (const s of stmts) {
      const low = this.statement(s, ctx);
      if (low.entry === null) continue; // empty region (e.g. bare block with nothing in it)
      if (entry === null) entry = low.entry;
      if (cursor) for (const d of cursor) this.addEdge(d.from, low.entry, d.kind);
      cursor = low.exits;
    }
    return { entry, exits: cursor ?? [] };
  }

  statement(s: Node, ctx: LowerCtx, label?: string): Lowered {
    if (Node.isBlock(s)) return this.statements(s.getStatements(), ctx);
    if (Node.isLabeledStatement(s)) return this.statement(s.getStatement(), ctx, s.getLabel().getText());
    if (Node.isIfStatement(s)) return this.ifStatement(s, ctx);
    if (Node.isWhileStatement(s) || Node.isForStatement(s) || Node.isForOfStatement(s) || Node.isForInStatement(s))
      return this.loop(s, ctx, label);
    if (Node.isDoStatement(s)) return this.doLoop(s, ctx, label);
    if (Node.isSwitchStatement(s)) return this.switchStatement(s, ctx);
    if (Node.isTryStatement(s)) return this.tryStatement(s, ctx);
    return this.leaf(s, ctx);
  }

  private leaf(s: Node, ctx: LowerCtx): Lowered {
    const id = this.idOf.get(s) as number;
    this.exceptionEdgeIfThrows(s, id, ctx);

    if (Node.isReturnStatement(s)) {
      this.addEdge(id, this.exitId, "return");
      return { entry: id, exits: [] };
    }
    if (Node.isThrowStatement(s)) {
      this.addEdge(id, ctx.exceptionTarget, "exception");
      return { entry: id, exits: [] };
    }
    if (Node.isBreakStatement(s)) {
      const lbl = s.getLabel()?.getText();
      const sink = lbl ? ctx.labels.get(lbl)?.breaks : ctx.nearestBreaks;
      sink?.push({ from: id, kind: "break" });
      return { entry: id, exits: [] };
    }
    if (Node.isContinueStatement(s)) {
      const lbl = s.getLabel()?.getText();
      const header = lbl ? (ctx.labels.get(lbl)?.continueHeader ?? null) : ctx.nearestContinueHeader;
      if (header !== null) this.addEdge(id, header, "continue");
      return { entry: id, exits: [] };
    }
    // Plain statement: the outgoing normal edge carries the suspend/resume kind when the
    // statement awaits or yields (stopping at nested function boundaries).
    const kind: CfgEdgeKind = containsKind(s, SyntaxKind.AwaitExpression)
      ? "await_resume"
      : containsKind(s, SyntaxKind.YieldExpression)
        ? "yield"
        : "fallthrough";
    return { entry: id, exits: [{ from: id, kind }] };
  }

  private ifStatement(s: Node, ctx: LowerCtx): Lowered {
    if (!Node.isIfStatement(s)) throw new Error("unreachable");
    const id = this.idOf.get(s) as number;
    this.exceptionEdgeIfThrows(s.getExpression(), id, ctx);
    const then = this.statement(s.getThenStatement(), ctx);
    const exits: Dangling[] = [];
    if (then.entry !== null) {
      this.addEdge(id, then.entry, "true");
      exits.push(...then.exits);
    } else {
      exits.push({ from: id, kind: "true" });
    }
    const elseStmt = s.getElseStatement();
    if (elseStmt) {
      const els = this.statement(elseStmt, ctx);
      if (els.entry !== null) {
        this.addEdge(id, els.entry, "false");
        exits.push(...els.exits);
      } else {
        exits.push({ from: id, kind: "false" });
      }
    } else {
      exits.push({ from: id, kind: "false" });
    }
    return { entry: id, exits };
  }

  /** while / for / for-of / for-in: the statement node is the header (condition/binding). */
  private loop(s: Node, ctx: LowerCtx, label?: string): Lowered {
    const id = this.idOf.get(s) as number;
    const cond = Node.isWhileStatement(s)
      ? s.getExpression()
      : Node.isForStatement(s)
        ? (s.getCondition() ?? null)
        : Node.isForOfStatement(s) || Node.isForInStatement(s)
          ? s.getExpression()
          : null;
    if (Node.isForStatement(s)) {
      const init = s.getInitializer();
      if (init) this.exceptionEdgeIfThrows(init, id, ctx);
      const incr = s.getIncrementor();
      if (incr) this.exceptionEdgeIfThrows(incr, id, ctx);
    }
    if (cond) this.exceptionEdgeIfThrows(cond, id, ctx);

    const breaks: Dangling[] = [];
    const labelEntry: LoopLabel = { breaks, continueHeader: id };
    if (label) ctx.labels.set(label, labelEntry);
    const bodyCtx: LowerCtx = { ...ctx, nearestBreaks: breaks, nearestContinueHeader: id };
    const body = this.statement(getLoopBody(s), bodyCtx);
    if (label) ctx.labels.delete(label);

    if (body.entry !== null) {
      this.addEdge(id, body.entry, "true");
      for (const d of body.exits) this.addEdge(d.from, id, "loop_back");
    } else {
      this.addEdge(id, id, "loop_back"); // empty body: the header loops on itself
    }
    // The loop-exit edge is emitted even for `while (true)` / `for (;;)` — that dead `false`
    // edge is the synthetic edge that keeps EXIT the unique post-dominance root.
    return { entry: id, exits: [{ from: id, kind: "false" }, ...breaks] };
  }

  private doLoop(s: Node, ctx: LowerCtx, label?: string): Lowered {
    if (!Node.isDoStatement(s)) throw new Error("unreachable");
    const id = this.idOf.get(s) as number; // the do-while node carries the condition
    this.exceptionEdgeIfThrows(s.getExpression(), id, ctx);
    const breaks: Dangling[] = [];
    if (label) ctx.labels.set(label, { breaks, continueHeader: id });
    const bodyCtx: LowerCtx = { ...ctx, nearestBreaks: breaks, nearestContinueHeader: id };
    const body = this.statement(s.getStatement(), bodyCtx);
    if (label) ctx.labels.delete(label);

    if (body.entry !== null) {
      for (const d of body.exits) this.addEdge(d.from, id, d.kind);
      this.addEdge(id, body.entry, "loop_back"); // condition true → run the body again
      return { entry: body.entry, exits: [{ from: id, kind: "false" }, ...breaks] };
    }
    this.addEdge(id, id, "loop_back");
    return { entry: id, exits: [{ from: id, kind: "false" }, ...breaks] };
  }

  private switchStatement(s: Node, ctx: LowerCtx): Lowered {
    if (!Node.isSwitchStatement(s)) throw new Error("unreachable");
    const id = this.idOf.get(s) as number;
    this.exceptionEdgeIfThrows(s.getExpression(), id, ctx);
    const breaks: Dangling[] = [];
    const clauseCtx: LowerCtx = { ...ctx, nearestBreaks: breaks };

    const clauses = s.getClauses();
    const lowered = clauses.map((c) => this.statements(c.getStatements(), clauseCtx));
    const exits: Dangling[] = [];
    let nonEmptyDefault = false;
    let pendingFallthrough: Dangling[] = [];
    for (const [i, clause] of clauses.entries()) {
      const low = lowered[i] as Lowered;
      if (low.entry === null) continue; // empty clause: dispatch/fallthrough slides to the next
      if (Node.isDefaultClause(clause)) nonEmptyDefault = true;
      this.addEdge(id, low.entry, "switch_case");
      for (const d of pendingFallthrough) this.addEdge(d.from, low.entry, d.kind);
      pendingFallthrough = low.exits;
    }
    exits.push(...pendingFallthrough, ...breaks);
    // Without a (non-empty) default arm, dispatch may skip the switch entirely.
    if (!nonEmptyDefault) exits.push({ from: id, kind: "fallthrough" });
    return { entry: id, exits };
  }

  private tryStatement(s: Node, ctx: LowerCtx): Lowered {
    if (!Node.isTryStatement(s)) throw new Error("unreachable");
    const cc = s.getCatchClause();
    const fin = s.getFinallyBlock();

    // Lower the finally region first so try/catch know their exceptional continuation.
    let finLowered: Lowered | null = null;
    if (fin) {
      finLowered = this.statements(fin.getStatements(), ctx);
      // A finally region may re-raise (it runs on the exceptional path too): over-approximate by
      // edging every finally exit to the outer handler as well.
      if (finLowered.entry !== null) {
        for (const d of finLowered.exits) this.addEdge(d.from, ctx.exceptionTarget, "exception");
      }
    }
    const afterCatchTarget = finLowered?.entry ?? ctx.exceptionTarget;

    const exits: Dangling[] = [];
    let catchEntry: number | null = null;
    if (cc) {
      const catchId = this.idOf.get(cc) as number; // binds the exception variable (a def, stage 3)
      catchEntry = catchId;
      const catchCtx: LowerCtx = { ...ctx, exceptionTarget: afterCatchTarget };
      const catchBody = this.statements(cc.getBlock().getStatements(), catchCtx);
      if (catchBody.entry !== null) {
        this.addEdge(catchId, catchBody.entry, "fallthrough");
        this.routeThroughFinally(catchBody.exits, finLowered, exits);
      } else {
        this.routeThroughFinally([{ from: catchId, kind: "fallthrough" }], finLowered, exits);
      }
    }

    const tryCtx: LowerCtx = { ...ctx, exceptionTarget: catchEntry ?? afterCatchTarget };
    const tryBody = this.statements(s.getTryBlock().getStatements(), tryCtx);
    if (tryBody.entry !== null) this.routeThroughFinally(tryBody.exits, finLowered, exits);
    else if (finLowered?.entry != null) this.routeThroughFinally([], finLowered, exits);

    const entry = tryBody.entry ?? catchEntry ?? finLowered?.entry ?? null;
    if (tryBody.entry === null && finLowered?.entry !== null && finLowered) {
      // Empty try block: control passes straight to finally.
      exits.push(...finLowered.exits);
    }
    return { entry, exits };
  }

  /** Route a region's normal exits through the finally block (if any) or straight out. */
  private routeThroughFinally(regionExits: Dangling[], fin: Lowered | null, outExits: Dangling[]): void {
    if (fin && fin.entry !== null) {
      for (const d of regionExits) this.addEdge(d.from, fin.entry, d.kind);
      for (const d of fin.exits) if (!outExits.includes(d)) outExits.push(d);
    } else {
      outExits.push(...regionExits);
    }
  }

  /** Over-approximate exceptional flow: calls / new / await / tagged templates may throw. */
  exceptionEdgeIfThrows(expr: Node, nodeId: number, ctx: LowerCtx): void {
    if (mayThrow(expr)) this.addEdge(nodeId, ctx.exceptionTarget, "exception");
  }
}

// ------------------------------------------------------------------------------------------------
// AST helpers
// ------------------------------------------------------------------------------------------------

function getBodyNode(fn: Node): Node | undefined {
  const f = fn as unknown as { getBody?: () => Node | undefined };
  return f.getBody?.();
}

function getParameters(fn: Node): Node[] {
  const f = fn as unknown as { getParameters?: () => Node[] };
  return f.getParameters?.() ?? [];
}

function getLoopBody(s: Node): Node {
  return (s as unknown as { getStatement: () => Node }).getStatement();
}

export function isFunctionBoundary(n: Node): boolean {
  return (
    Node.isFunctionDeclaration(n) ||
    Node.isFunctionExpression(n) ||
    Node.isArrowFunction(n) ||
    Node.isMethodDeclaration(n) ||
    Node.isConstructorDeclaration(n) ||
    Node.isGetAccessorDeclaration(n) ||
    Node.isSetAccessorDeclaration(n) ||
    Node.isClassDeclaration(n) ||
    Node.isClassExpression(n)
  );
}

/** Does this subtree (stopping at nested function boundaries) contain a node of `kind`? */
export function containsKind(root: Node, kind: SyntaxKind): boolean {
  if (root.getKind() === kind) return true;
  let found = false;
  root.forEachDescendant((n, traversal) => {
    if (found) {
      traversal.stop();
      return;
    }
    if (isFunctionBoundary(n)) {
      traversal.skip();
      return;
    }
    if (n.getKind() === kind) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

const THROWING_KINDS = new Set([
  SyntaxKind.CallExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.AwaitExpression,
  SyntaxKind.TaggedTemplateExpression,
]);

/** May evaluating this subtree throw? Over-approximate: any call-like or await counts. */
export function mayThrow(root: Node): boolean {
  if (THROWING_KINDS.has(root.getKind())) return true;
  let found = false;
  root.forEachDescendant((node, traversal) => {
    if (found) {
      traversal.stop();
      return;
    }
    // Match containsKind's callable boundary: nested bodies execute separately from this subtree.
    if (isFunctionBoundary(node)) {
      traversal.skip();
      return;
    }
    if (THROWING_KINDS.has(node.getKind())) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

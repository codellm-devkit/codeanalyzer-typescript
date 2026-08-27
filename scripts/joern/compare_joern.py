#!/usr/bin/env python3
"""Joern jssrc2cpg superset comparator (#98 / defuse-linker-call-graph.md).

Usage:
  1. joern-parse --language jssrc <app> -o app.cpg
  2. joern --script scripts/joern/dump-calls.sc --param cpgFile=app.cpg --param outFile=app.tsv
  3. python3 scripts/joern/compare_joern.py <app-dir> app.tsv [-v]

Maps Joern's real call pairs onto analyzer signatures and verifies our call_graph covers them
(RESIDUAL must be 0). Exception classes are counted and printed, never silently waved through —
see docs/design/specs/defuse-linker-joern-ledger.md for the audited class definitions."""
import json, re, subprocess, sys, collections

JUNK_NAMES = {"__decorate", "__param", "__metadata", "__runInitializers", "__esDecorate", "require", "import"}

def load_joern(tsv):
    calls, methods = [], {}
    for line in open(tsv):
        parts = line.rstrip("\n").split("\t")
        if parts[0] == "C":
            _, caller, name, direct, linked, line_no = parts
            calls.append((caller, name, direct, linked, int(line_no)))
        elif parts[0] == "M":
            _, fn, ln, col = parts
            methods[fn] = (int(ln), int(col))
    return calls, methods

STRIP_EXT = re.compile(r"\.(d\.ts|tsx|ts|jsx|js|mts|cts|mjs|cjs)$")

def map_fullname(fn, methods, our_sigs):
    """Joern fullName -> our signature, or (None, reason)."""
    if "::" not in fn:
        return None, "external"
    path, chain = fn.split("::", 1)
    segs = chain.split(":")
    if segs[0] != "program":
        return None, "odd-chain"
    segs = segs[1:]
    prefix = STRIP_EXT.sub("", path)
    if not segs:
        return prefix, None  # module-scope caller: the module prefix IS the source (python #131)
    out = []
    consumed = ["program"]
    for s in segs:
        consumed.append(s)
        if s == "<init>" or s == "super":
            out.append("constructor")
        elif s.startswith("<lambda>"):
            # a lambda anywhere in the chain: line-match the progressive Joern fullName against
            # our positional <anon@line:col> under the mapped base so far
            jfn = path + "::" + ":".join(consumed)
            ln = methods.get(jfn, (-1, -1))[0]
            base = prefix + ("." + ".".join(out) if out else "")
            cands = sorted(sig for sig in our_sigs
                           if sig.startswith(base + ".<anon@%d:" % ln)
                           and sig.count("<anon@") == len([o for o in out if o.startswith("<anon@")]) + 1)
            if len(cands) != 1:
                return None, "lambda-unmapped"
            out.append(cands[0].rsplit(".", 1)[1])
        else:
            out.append(s)
    return prefix + "." + ".".join(out), None

def our_edges(fixture):
    here = __import__("os").path.dirname(__import__("os").path.abspath(__file__))
    out = subprocess.run(["bun", "run", here + "/edges.ts", fixture], capture_output=True, text=True)
    if out.returncode != 0:
        print(out.stderr[-2000:]); sys.exit(1)
    d = json.loads(out.stdout)
    return set(map(tuple, d["edges"])), set(d["sigs"])

def main(fixture, tsv):
    calls, methods = load_joern(tsv)
    edges, sigs = our_edges(fixture)
    covered, residual = [], []
    classes = collections.Counter()
    seen = set()
    for caller, name, direct, linked, line in calls:
        if name in JUNK_NAMES or name == "":
            classes["joern-synthetic-helper"] += 1; continue
        callee_fn = linked.split("|")[0] if linked else (direct if direct != "<unknownFullName>" else "")
        if not callee_fn or callee_fn == "<unknownFullName>":
            classes["joern-unresolved"] += 1; continue
        src, why_s = map_fullname(caller, methods, sigs)
        dst, why_d = map_fullname(callee_fn, methods, sigs)
        if dst is None or dst not in sigs:
            k = "external-or-unmapped-target:" + (why_d or "notin")
            classes[k] += 1
            if "-v" in sys.argv and (why_d or "notin") != "external": print("   [", k, "]", caller, "->", callee_fn)
            continue
        if src is None or src not in sigs:
            classes["caller-unmapped:" + (why_s or "notin")] += 1
            if "-v" in sys.argv: print("   [caller-unmapped]", caller, "->", callee_fn)
            continue
        pair = (src, dst)
        if pair in seen: continue
        seen.add(pair)
        if pair in edges: covered.append(pair)
        elif "." not in src and any(e[1] == dst and e[0].startswith(src + ".") for e in edges):
            # Joern desugars decorator factories to module-scope __decorate calls; we attribute the
            # SAME invocation to the decorated callable (more precise). Same edge, finer caller.
            classes["decorator-attribution-variant"] += 1
            covered.append(pair)
        else: residual.append(pair)
    print(f"== {fixture}: joern real pairs {len(seen)}, covered {len(covered)}, RESIDUAL {len(residual)}")
    for p in residual: print("   MISSING:", p[0], "->", p[1])
    for k, v in sorted(classes.items()): print(f"   [class] {k}: {v}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

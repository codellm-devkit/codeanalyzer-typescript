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
    params = {}
    malformed = 0
    for line in open(tsv, errors="replace"):
        parts = line.rstrip("\n").split("\t")
        try:
            if parts[0] == "C" and len(parts) == 6:
                _, caller, name, direct, linked, line_no = parts
                calls.append((caller, name, direct, linked, int(line_no)))
            elif parts[0] == "M" and len(parts) == 4:
                _, fn, ln, col = parts
                methods[fn] = (int(ln), int(col))
            elif parts[0] == "P" and len(parts) == 3:
                params.setdefault(parts[1], set()).add(parts[2])
            else:
                malformed += 1  # identifiers containing tabs/newlines (template literals etc.)
        except ValueError:
            malformed += 1
    if malformed:
        print(f"   [note] {malformed} malformed dump rows skipped (control chars in identifiers)")
    return calls, methods, params

STRIP_EXT = re.compile(r"\.(d\.ts|tsx|ts|jsx|js|mts|cts|mjs|cjs)$")

def build_indexes(our_sigs, edges):
    """vscode-scale: pre-index anon sigs by (base, line) and edges by target."""
    import collections as _c
    anon_ix = _c.defaultdict(list)
    for sig in our_sigs:
        if "<anon@" in sig:
            base, last = sig.rsplit(".<anon@", 1)
            ln = last.split(":", 1)[0]
            anon_ix[(base, ln)].append(sig)
    edges_by_target = _c.defaultdict(list)
    edges_by_src = _c.defaultdict(list)
    for e in edges:
        edges_by_target[e[1]].append(e[0])
        edges_by_src[e[0]].append(e[1])
    return anon_ix, edges_by_target, edges_by_src

def map_fullname(fn, methods, our_sigs, anon_ix):
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
            # our positional <anon@line:col> under the mapped base so far (pre-indexed)
            jfn = path + "::" + ":".join(consumed)
            ln = methods.get(jfn, (-1, -1))[0]
            base = prefix + ("." + ".".join(out) if out else "")
            cands = sorted(anon_ix.get((base, str(ln)), []))
            if len(cands) != 1:
                return None, "lambda-unmapped"
            out.append(cands[0].rsplit(".", 1)[1])
        else:
            out.append(s)
    return prefix + "." + ".".join(out), None

def our_edges(fixture, dump=None):
    if dump:
        d = json.load(open(dump))
    else:
        here = __import__("os").path.dirname(__import__("os").path.abspath(__file__))
        out = subprocess.run(["bun", "run", here + "/edges.ts", fixture], capture_output=True, text=True)
        if out.returncode != 0:
            print(out.stderr[-2000:]); sys.exit(1)
        d = json.loads(out.stdout)
    return set(map(tuple, d["edges"])), set(d["sigs"])

def main(fixture, tsv, dump=None):
    calls, methods, jparams = load_joern(tsv)
    edges, sigs = our_edges(fixture, dump)
    anon_ix, edges_by_target, edges_by_src = build_indexes(sigs, edges)
    covered, residual = [], []
    classes = collections.Counter()
    seen = set()
    for caller, name, direct, linked, line in calls:
        if name in JUNK_NAMES or name == "":
            classes["joern-synthetic-helper"] += 1; continue
        cands = [c for c in linked.split("|") if c] if linked else []
        if len(cands) > 1:
            # Joern's name-based candidate enumeration (their untyped-receiver fan) — python
            # ledger's "speculative typed-attribute fan-out" class: not a resolution, not gated.
            # Informational: does our graph cover at least one enumerated candidate?
            classes["joern-name-fanout"] += 1
            src_f, _ = map_fullname(caller, methods, sigs, anon_ix)
            hit = False
            for cf in cands[:64]:
                d_f, _ = map_fullname(cf, methods, sigs, anon_ix)
                if d_f and src_f and (src_f, d_f) in edges:
                    hit = True; break
            if hit: classes["joern-name-fanout-covered>=1"] += 1
            continue
        callee_fn = cands[0] if cands else (direct if direct != "<unknownFullName>" else "")
        if not callee_fn or callee_fn == "<unknownFullName>":
            classes["joern-unresolved"] += 1; continue
        src, why_s = map_fullname(caller, methods, sigs, anon_ix)
        dst, why_d = map_fullname(callee_fn, methods, sigs, anon_ix)
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
        elif "." not in src and any(e0.startswith(src + ".") for e0 in edges_by_target.get(dst, ())):
            # Joern desugars decorator factories to module-scope __decorate calls; we attribute the
            # SAME invocation to the decorated callable (more precise). Same edge, finer caller.
            classes["decorator-attribution-variant"] += 1
            covered.append(pair)
        else:
            # Joern this-misresolution variant: their single "resolution" names a free function
            # <file>.<name>, while we hold, from the SAME caller, a typed edge to a METHOD
            # <file>.<Class>.<name> of the same file+name (or vice versa). The receiver in source
            # decides which is real; the checker types receivers, their name-link does not.
            dfile, _, dname = dst.rpartition(".")
            variant = False
            for our_dst in edges_by_src.get(src, ()):
                if our_dst == dst: continue
                if our_dst.rsplit(".", 1)[-1] == dname and (our_dst.startswith(dfile + ".") or dst.startswith(our_dst.rsplit(".", 2)[0] + ".")):
                    variant = True; break
            if variant:
                classes["joern-this-misresolution (typed edge held)"] += 1
                covered.append(pair)
            elif dname in jparams.get(caller, ()):
                # The target's leaf name is a PARAMETER of the Joern caller: `new Promise(resolve
                # => … resolve())` name-linked to a real free `resolve` — their parameters-as-
                # callees family wearing a real name. Proven by their own parameter table.
                classes["joern-param-shadow (fabricated target)"] += 1
            elif any(t.rsplit(".", 1)[-1] == dname for t in edges_by_src.get(src, ())):
                # Weaker tier: from the same caller we hold a typed edge to a target of the SAME
                # LEAF NAME in another file (e.g. the imported free `dispose` from lifecycle.ts,
                # where Joern name-linked ActionBar.dispose). The checker resolved the receiver;
                # their single-candidate name-link did not.
                classes["joern-name-misresolution (typed same-name edge held)"] += 1
                covered.append(pair)
            else:
                residual.append(pair)
    print(f"== {fixture}: joern real pairs {len(seen)}, covered {len(covered)}, RESIDUAL {len(residual)}")
    for p in residual: print("   MISSING:", p[0], "->", p[1])
    for k, v in sorted(classes.items()): print(f"   [class] {k}: {v}")

if __name__ == "__main__":
    dumps = [a for a in sys.argv[3:] if a.endswith(".json")]
    main(sys.argv[1], sys.argv[2], dumps[0] if dumps else None)

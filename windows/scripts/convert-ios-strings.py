#!/usr/bin/env python3
"""Generates src/renderer/src/i18n/strings.json from the iOS app's Strings.swift.

The iOS app keeps every piece of copy in one exhaustive Swift switch, so the
Windows app reads the very same sentences instead of a second translation that
could drift. Re-run after the iOS strings change:

    python3 scripts/convert-ios-strings.py
"""
import json, re, pathlib, sys

root = pathlib.Path(__file__).resolve().parents[2]
src = root / "ios/WebyarNative/Sources/Localization/Strings.swift"
out = pathlib.Path(__file__).resolve().parents[1] / "src/renderer/src/i18n/strings.json"

text = src.read_text(encoding="utf-8")
LANGS = ("en", "fa", "tr")
result = {l: {} for l in LANGS}

func_re = re.compile(r"static func (\w+)\(([^)]*)\) -> String \{")
case_re = re.compile(r'case ((?:\.\w+,?\s*)+):\s*(?:return\s+)?(.*)$')

def swift_literal(expr: str) -> str:
    expr = re.sub(r"^\w+\s*=\s*", "", expr.strip())
    # `n == 1 ? "1 thing" : "\(text) things"` — keep the general branch.
    m = re.match(r'.*\?\s*"(?:[^"\\]|\\.)*"\s*:\s*("(?:[^"\\]|\\.)*")\s*$', expr)
    if m:
        expr = m.group(1)
    m = re.match(r'^"((?:[^"\\]|\\.)*)"$', expr)
    if not m:
        raise ValueError(expr)
    s = m.group(1)
    s = re.sub(r"\\\((\w+)\)", lambda g: "{" + ("n" if g.group(1) == "text" else g.group(1)) + "}", s)
    s = re.sub(r"\\u\{([0-9A-Fa-f]+)\}", lambda g: chr(int(g.group(1), 16)), s)
    s = s.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")
    return s

lines = text.splitlines()
i = 0
count = 0
while i < len(lines):
    m = func_re.search(lines[i])
    if not m:
        i += 1
        continue
    name = m.group(1)
    depth = lines[i].count("{") - lines[i].count("}")
    j = i + 1
    while j < len(lines) and depth > 0:
        line = lines[j]
        depth += line.count("{") - line.count("}")
        cm = case_re.search(line.strip())
        if cm:
            langs = re.findall(r"\.(\w+)", cm.group(1))
            try:
                value = swift_literal(cm.group(2))
            except ValueError:
                print(f"skip {name}: {cm.group(2)}", file=sys.stderr)
                value = None
            if value is not None:
                for l in langs:
                    if l in result:
                        result[l][name] = value
        j += 1
    count += 1
    i = j

result["en"]["brandWordmark"] = result["fa"]["brandWordmark"] = result["tr"]["brandWordmark"] = "WEBYAR"
missing = [k for k in result["en"] if k not in result["fa"] or k not in result["tr"]]
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(result, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
print(f"{count} functions, {len(result['en'])} keys, missing translations: {missing}")

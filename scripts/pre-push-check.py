#!/usr/bin/env python3
"""
pre-push check: mirror of scripts/validate-localization.ps1 plus extras.
Run this BEFORE git commit/push to avoid CI surprises.

Usage:  python3 scripts/pre-push-check.py
Exit:   0 = all green, 1 = red (prints which step failed)
"""
import re, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZH = os.path.join(ROOT, "app", "src", "main", "res", "values", "strings.xml")
EN = os.path.join(ROOT, "app", "src", "main", "res", "values-en", "strings.xml")

def fail(msg):
    print(f"  ❌ {msg}")
    sys.exit(1)

def ok(msg):
    print(f"  ✅ {msg}")

# ---------- 1) XML parse ----------
import xml.etree.ElementTree as ET
def parse_xml(path):
    if not os.path.exists(path):
        fail(f"缺少文件: {path}")
    return ET.parse(path).getroot()

zh_root = parse_xml(ZH)
en_root = parse_xml(EN)

def collect(node, tag):
    """Return dict name -> (elem, inner_text)."""
    out = {}
    for child in node.findall(tag):
        name = child.get("name", "")
        if not name:
            fail(f"{tag} 没有 name 属性: {ET.tostring(child, encoding='unicode')}")
        if name in out:
            fail(f"重复 key: {name}")
        # strip inner XML tags, keep text
        text = "".join(child.itertext()).strip()
        out[name] = text
    return out

zh_strings = collect(zh_root, "string")
en_strings = collect(en_root, "string")
zh_plurals = collect(zh_root, "plurals")
en_plurals = collect(en_root, "plurals")
ok(f"strings.xml 解析: {len(zh_strings)} strings, {len(zh_plurals)} plurals")

# ---------- 2) key alignment ----------
def assert_same_keys(a, b, kind):
    ma = set(a.keys())
    mb = set(b.keys())
    missing = sorted(ma - mb)
    extra = sorted(mb - ma)
    if missing or extra:
        fail(f"{kind} keys 不一致. missing: {missing}; extra: {extra}")

assert_same_keys(zh_strings, en_strings, "String")
assert_same_keys(zh_plurals, en_plurals, "Plural")
ok("ZH/EN key 完全对齐")

# ---------- 3) English non-empty + format tokens ----------
def fmt_tokens(s):
    return sorted(set(re.findall(r'%(?:\d+\$)?[a-zA-Z]', s)))

for name, en_val in en_strings.items():
    if not en_val.strip():
        fail(f"英文翻译为空: {name}")
    zh_tokens = fmt_tokens(zh_strings[name])
    en_tokens = fmt_tokens(en_val)
    if zh_tokens != en_tokens:
        fail(f"格式 token 不匹配 {name}: ZH={zh_tokens} EN={en_tokens}")

ok("英文翻译非空 + 格式 token 一致")

# ---------- 4) hardcoded Chinese outside strings.xml ----------
CHINESE_RE = re.compile(r'[\u4e00-\u9fff]')
scanned_roots = [
    os.path.join(ROOT, "app", "src", "main", "java"),
    os.path.join(ROOT, "app", "src", "main", "res", "layout"),
    os.path.join(ROOT, "app", "src", "main", "res", "xml"),
    os.path.join(ROOT, "app", "src", "main", "AndroidManifest.xml"),
]
hits = []
for root in scanned_roots:
    if os.path.isfile(root):
        with open(root, encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f, 1):
                if CHINESE_RE.search(line):
                    hits.append((root, i, line.rstrip()))
    elif os.path.isdir(root):
        for dirpath, _, filenames in os.walk(root):
            for fn in filenames:
                p = os.path.join(dirpath, fn)
                try:
                    with open(p, encoding="utf-8", errors="replace") as f:
                        for i, line in enumerate(f, 1):
                            if CHINESE_RE.search(line):
                                hits.append((p, i, line.rstrip()))
                except Exception:
                    pass

if hits:
    for p, i, line in hits:
        print(f"  ❌ {os.path.relpath(p, ROOT)}:{i}: {line[:120]}")
    fail("硬编码中文 — 请移到 strings.xml")
ok("源码 / layout / xml / manifest 无硬编码中文")

# ---------- 5) extra: all R.string references resolve ----------
all_keys = set(zh_strings.keys()) | set(zh_plurals.keys())
java_root = os.path.join(ROOT, "app", "src", "main", "java")
refs = set()
for dirpath, _, filenames in os.walk(java_root):
    for fn in filenames:
        if fn.endswith(".java"):
            with open(os.path.join(dirpath, fn), encoding="utf-8") as f:
                content = f.read()
            for m in re.finditer(r'R\.string\.([a-zA-Z_][a-zA-Z0-9_]*)', content):
                refs.add(m.group(1))

missing = sorted(refs - all_keys)
if missing:
    fail(f"Java 引用了不存在的 R.string: {missing}")
ok(f"Java 引用的 R.string 全部存在 ({len(refs)} refs)")

print("\n🎉 全部通过，可以 push 了")

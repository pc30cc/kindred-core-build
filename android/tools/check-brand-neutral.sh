#!/usr/bin/env bash
# RESPOK's Android app must not name the Iranian edition: not in a class, a
# package, a resource name or value, the manifest, a string, an asset, a file
# name inside the APK or a dex string pool. One source builds both apps
# (app/build.gradle.kts), so this checks the two places that could let the
# name through.
#
#   tools/check-brand-neutral.sh                  the sources (run from android/ or anywhere)
#   tools/check-brand-neutral.sh APK [APK...]     the sources, then each APK given
#   tools/check-brand-neutral.sh --apk-only APK…  only the APKs
#
# Sources: every file under app/src/main, app/src/respok, app/src/debug and
# app/src/release (names and contents), the build scripts, the ProGuard rules
# and the baseline profile module. The Iranian flavor's own folders
# (app/src/webyar, its tests) are not checked, and in the build scripts only
# the body of its flavor block (`create("webyar") { … }`) may name it: that is
# where its own values (package, server, storage names) live.
#
# APK: every entry's name, and every entry's bytes read as UTF-8 and as
# UTF-16 (dex string pools are MUTF-8; resources.arsc and the binary manifest
# may hold UTF-16), nested archives included; and no entry may be
# byte-identical to a file of the Iranian flavor's art (app/src/webyar).
#
# Exit status: 0 clean, 1 on any hit, 2 on a usage error.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -I - "$(dirname "$here")" "$@" <<'PY'
import hashlib
import io
import os
import re
import sys
import zipfile

ANDROID = sys.argv[1]
args = sys.argv[2:]

# The Iranian edition's name, any case and spelling: "webyar", "web-yar",
# "web_yar", "web.yar"; "web yar" too, unless a lowercase letter follows
# (the Turkish "web yardım" is a word, not the name). Its domains
# (webyar.ai, webyar.app) are covered by the first. Persian: و ب (optional
# kashida, zero-width or space) ی ا ر, with the Arabic yeh as well.
PATTERNS = [
    re.compile(r'(?i)web[_.\-]?yar'),
    re.compile(r'(?i)web[  ]yar(?![a-zçğıöşüâîû])'),
    re.compile('وـ*ب[ـ​-‏  ]*[یيى]ـ*اـ*ر'),
]


def hits_in(text):
    out = []
    for rx in PATTERNS:
        for m in rx.finditer(text):
            a, b = max(0, m.start() - 30), min(len(text), m.end() + 30)
            out.append(text[a:b].replace('\n', ' ').replace('\x00', '.'))
    return out


def decodings(data):
    yield data.decode('utf-8', errors='ignore')
    yield data.decode('utf-16-le', errors='ignore')
    if len(data) > 1:
        yield data[1:].decode('utf-16-le', errors='ignore')


# ── Sources ──────────────────────────────────────────────────────────────

SOURCE_DIRS = ['app/src/main', 'app/src/respok', 'app/src/debug', 'app/src/release', 'baselineprofile/src']
BUILD_FILES = [
    'build.gradle.kts', 'settings.gradle.kts', 'gradle.properties', 'gradle/libs.versions.toml',
    'app/build.gradle.kts', 'app/proguard-rules.pro', 'baselineprofile/build.gradle.kts',
]
# Build scripts in which the Iranian flavor's own block may name it.
FLAVOR_BLOCK = 'create("webyar")'


def without_flavor_block(text):
    """The script with the Iranian flavor block's lines blanked (line numbers kept)."""
    start = text.find(FLAVOR_BLOCK)
    if start < 0:
        return text
    depth, i = 0, text.index('{', start)
    while i < len(text):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                break
        i += 1
    line_start = text.rfind('\n', 0, start) + 1
    blanked = re.sub(r'[^\n]', ' ', text[line_start:i + 1])
    return text[:line_start] + blanked + text[i + 1:]


def check_sources():
    problems = []

    def check_text(rel, text):
        for n, line in enumerate(text.split('\n'), 1):
            for h in hits_in(line):
                problems.append(f'{rel}:{n}: {h.strip()}')

    for d in SOURCE_DIRS:
        root = os.path.join(ANDROID, d)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [x for x in dirnames if x != 'build']
            for name in dirnames + filenames:
                for h in hits_in(name):
                    problems.append(f'{os.path.relpath(os.path.join(dirpath, name), ANDROID)}: file name: {h}')
            for f in filenames:
                p = os.path.join(dirpath, f)
                rel = os.path.relpath(p, ANDROID)
                with open(p, 'rb') as fh:
                    data = fh.read()
                if b'\x00' in data[:4096]:
                    # Binary (an image, a font): its bytes as text, whatever they say.
                    for h in hits_in(data.decode('utf-8', errors='ignore')):
                        problems.append(f'{rel}: bytes: {h.strip()}')
                else:
                    check_text(rel, data.decode('utf-8', errors='replace'))

    for rel in BUILD_FILES:
        p = os.path.join(ANDROID, rel)
        if not os.path.exists(p):
            continue
        with open(p, encoding='utf-8') as fh:
            check_text(rel, without_flavor_block(fh.read()))
    return problems


# ── APKs ─────────────────────────────────────────────────────────────────

def flavor_art():
    """sha256 → path of every file in the Iranian flavor's source set."""
    out = {}
    root = os.path.join(ANDROID, 'app/src/webyar')
    for dirpath, _, filenames in os.walk(root):
        for f in filenames:
            p = os.path.join(dirpath, f)
            with open(p, 'rb') as fh:
                out[hashlib.sha256(fh.read()).hexdigest()] = os.path.relpath(p, ANDROID)
    return out


def check_archive(label, data, art, problems, depth=0):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            name = info.filename
            where = f'{label}!{name}'
            for h in hits_in(name):
                problems.append(f'{where}: entry name: {h}')
            if info.is_dir():
                continue
            blob = z.read(info)
            digest = hashlib.sha256(blob).hexdigest()
            if digest in art:
                problems.append(f'{where}: identical to {art[digest]}')
            if depth < 2 and blob[:4] == b'PK\x03\x04':
                try:
                    check_archive(where, blob, art, problems, depth + 1)
                    continue
                except zipfile.BadZipFile:
                    pass
            seen = set()
            for text in decodings(blob):
                for h in hits_in(text):
                    if h not in seen:
                        seen.add(h)
                        problems.append(f'{where}: {h.strip()}')


def check_apks(paths):
    art = flavor_art()
    problems = []
    for p in paths:
        with open(p, 'rb') as fh:
            check_archive(os.path.basename(p), fh.read(), art, problems)
    return problems


# ── Main ─────────────────────────────────────────────────────────────────

apk_only = False
if args and args[0] == '--apk-only':
    apk_only, args = True, args[1:]
    if not args:
        print('usage: check-brand-neutral.sh [--apk-only] [APK ...]', file=sys.stderr)
        sys.exit(2)
for a in args:
    if a.startswith('-') or not os.path.isfile(a):
        print(f'check-brand-neutral: not a file: {a}', file=sys.stderr)
        sys.exit(2)

failed = False
if not apk_only:
    problems = check_sources()
    if problems:
        failed = True
        print(f'Sources: {len(problems)} place(s) name the Iranian edition outside its own flavor:')
        for line in problems:
            print(f'  {line}')
    else:
        print('Sources: brand-neutral (app/src/main, respok, debug, release, build scripts, ProGuard rules, baseline profile module).')

if args:
    problems = check_apks(args)
    if problems:
        failed = True
        print(f'APK: {len(problems)} hit(s):')
        for line in problems[:500]:
            print(f'  {line}')
        if len(problems) > 500:
            print(f'  … and {len(problems) - 500} more')
    else:
        for a in args:
            print(f'APK: {os.path.basename(a)} is brand-neutral.')

sys.exit(1 if failed else 0)
PY

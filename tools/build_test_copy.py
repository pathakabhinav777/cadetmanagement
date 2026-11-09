#!/usr/bin/env python3
"""Build the test copy of CadetFlow: https://pathakabhinav777.github.io/cadetflow-test/

The test copy is this site pointed at the separate Supabase project "CadetFlow Test", so people can
try the sign-in version without touching the real data. The real site and the test copy share the
address pathakabhinav777.github.io, so the copy also gets its own browser storage keys, its own
offline cache and its own app name; on one phone or laptop the two never mix. Its titles say "Test".

Usage:  python3 tools/build_test_copy.py <output folder>
Then commit and push that folder to the pathakabhinav777/cadetflow-test repository (GitHub Pages).
"""
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEST_URL = 'https://pgkwlxothkmlwoyibqof.supabase.co'
TEST_KEY = 'sb_publishable_2u4rg7ZPRKUxCEFz9rnBXA_NdNhjVRA'
TEST_NOTE = 'Test copy: changes here do not touch the real CadetFlow'


def swap(text, old, new, what):
    """Replace exactly one occurrence, or stop: a changed source must not build a copy that talks to the real data."""
    if text.count(old) != 1:
        sys.exit(f'build_test_copy: expected exactly one {what} ({old[:70]!r}), found {text.count(old)}')
    return text.replace(old, new)


def build(out):
    out = pathlib.Path(out)
    if out.exists():
        for child in out.iterdir():  # keep the folder's .git, replace everything else
            if child.name != '.git':
                shutil.rmtree(child) if child.is_dir() else child.unlink()
    out.mkdir(parents=True, exist_ok=True)

    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    html = swap(html, "const SUPABASE_URL = 'https://fyezdsvrlbbqrepbxcuj.supabase.co';",
                f"const SUPABASE_URL = '{TEST_URL}';", 'Supabase address')
    html = swap(html, "const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_sbc6JpS_Gg6ooOQUbmKnUg_ZtdnZPyS';",
                f"const SUPABASE_PUBLISHABLE_KEY = '{TEST_KEY}';", 'Supabase key')
    html = swap(html, "this.storageKey = 'cadetflow_ncc_user_37_roster_v3_dark_dl';",
                "this.storageKey = 'cadetflow_test_copy_state_v1';", 'saved-data key')
    html = swap(html, "const ACCESS_KEY = 'cadetflow_access_v1';", "const ACCESS_KEY = 'cadetflow_test_copy_access_v1';", 'access key')
    html = swap(html, '<title>CadetFlow | NCC Roster</title>', '<title>CadetFlow Test</title>', 'title')
    html = swap(html, '<meta name="apple-mobile-web-app-title" content="CadetFlow">',
                '<meta name="apple-mobile-web-app-title" content="CF Test">', 'iPhone app name')
    # Say it is the test copy in the page itself (a floating label would cover content when scrolled).
    html = swap(html, '<h1 id="gateTitle" class="text-3xl font-extrabold text-white mt-1">CadetFlow</h1>',
                '<h1 id="gateTitle" class="text-3xl font-extrabold text-white mt-1">CadetFlow Test</h1>', 'sign-in title')
    html = swap(html, '<p class="text-sm text-slate-400 mt-1">Jessami \u00b7 Kohima \u00b7 Naushera</p>',
                f'<p class="text-sm font-semibold text-amber-300 mt-1">{TEST_NOTE}</p>', 'sign-in subtitle')
    html = swap(html, '<h1 class="font-extrabold text-white text-sm sm:text-base tracking-tight leading-tight">CadetFlow</h1>',
                '<h1 class="font-extrabold text-white text-sm sm:text-base tracking-tight leading-tight">CadetFlow Test</h1>', 'header title')
    if 'fyezdsvrlbbqrepbxcuj' in html:
        sys.exit('build_test_copy: the real project is still mentioned in index.html')
    (out / 'index.html').write_text(html, encoding='utf-8')

    sw = (ROOT / 'sw.js').read_text(encoding='utf-8')
    sw = swap(sw, "const VERSION = 'cadetflow-v", "const VERSION = 'cadetflow-test-copy-v", 'cache name')
    # Only clear this copy's own old caches: the real site's cache lives under the same address.
    sw = swap(sw, '.then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))',
              ".then(keys => Promise.all(keys.filter(k => k.startsWith('cadetflow-test-copy-') && k !== VERSION).map(k => caches.delete(k))))",
              'cache clean-up')
    (out / 'sw.js').write_text(sw, encoding='utf-8')

    manifest = (ROOT / 'manifest.webmanifest').read_text(encoding='utf-8')
    manifest = swap(manifest, '"name": "CadetFlow",', '"name": "CadetFlow Test",', 'app name')
    manifest = swap(manifest, '"short_name": "CadetFlow",', '"short_name": "CF Test",', 'short app name')
    (out / 'manifest.webmanifest').write_text(manifest, encoding='utf-8')

    shutil.copytree(ROOT / 'icons', out / 'icons')
    shutil.copy(ROOT / 'cadetflow.css', out / 'cadetflow.css')
    (out / '.nojekyll').write_text('', encoding='utf-8')
    (out / 'README.md').write_text(
        '# CadetFlow test copy\n\n'
        'A test copy of the sign-in version of CadetFlow, built by `tools/build_test_copy.py` in '
        '[cadetmanagement](https://github.com/pathakabhinav777/cadetmanagement) (branch `cadet-accounts`).\n\n'
        'It uses its own test database. Nothing done here changes the real CadetFlow at '
        'https://pathakabhinav777.github.io/cadetmanagement/.\n', encoding='utf-8')
    print(f'Built the test copy in {out}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    build(sys.argv[1])

# Usage: python tests/dew/audit_fork_lines.py [<merge base>] [<fork ref>]
# After merging an upstream release: every line the fork added to a core file (merge base -> fork ref) should
# still be somewhere in the working tree. Upstream moves code between files, and a fork change to moved code
# either conflicts or disappears, so lines that went missing are printed per file. Expect the ones rewritten on
# purpose while resolving conflicts, and nothing else. RENAMES lists where upstream has moved things so far.
# Defaults are the 5.2 port: base 47e633e4 (v5.1.6), fork ref the last pre-port commit.
import subprocess, os, sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BASE = sys.argv[1] if len(sys.argv) > 1 else '47e633e4'
FORK = sys.argv[2] if len(sys.argv) > 2 else '7ca80d00'
RENAMES = {
    'js/interface/toolbars.js': ['js/interface/toolbars.ts', 'js/interface/main_tools.ts'],
    'js/interface/menu_bar.js': ['js/interface/menu_bar.ts'],
    'js/preview/preview.js': ['js/preview/preview.ts'],
    'js/interface/interface.js': ['js/interface/interface.js', 'js/interface/status_bar.ts'],
    'js/modeling/mesh_editing.js': ['js/modeling/mesh_editing.js', 'js/modeling/mesh/extrude.ts'],
}
SKIP = ('js/dew/', 'tests/', 'package', 'CLAUDE', 'scripts/')
KINDS = ('.js', '.ts', '.css', '.json', '.glsl', '.html', '.vue')

def git(*args):
    return subprocess.run(['git', '-C', REPO] + list(args), capture_output=True, text=True, encoding='utf-8', errors='replace').stdout

files = [f for f in git('diff', '--name-only', BASE, FORK).splitlines() if not f.startswith(SKIP) and f.endswith(KINDS)]
total_missing = 0
for f in files:
    added = [l[1:].strip() for l in git('diff', '-U0', BASE, FORK, '--', f).splitlines()
             if l.startswith('+') and not l.startswith('+++')]
    added = [l for l in added if len(l) > 14 and not l.startswith(('//', '*', '/*'))]
    if not added:
        continue
    text = ''
    for target in RENAMES.get(f, [f]):
        p = os.path.join(REPO, target)
        if os.path.exists(p):
            text += open(p, encoding='utf-8', errors='replace').read()
    if not text:
        print('FILE GONE:', f, '(%d added lines)' % len(added))
        total_missing += len(added)
        continue
    present = set(l.strip() for l in text.splitlines())
    missing = [l for l in added if l not in present]
    if missing:
        total_missing += len(missing)
        print('\n== %s: %d of %d added lines missing' % (f, len(missing), len(added)))
        for l in missing[:40]:
            print('   ', l[:160])
print('\ntotal missing:', total_missing, 'across', len(files), 'files')

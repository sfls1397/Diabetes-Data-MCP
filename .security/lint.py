#!/usr/bin/env python3
"""Types and strict lint, before any test runs (docs/TYPES-AND-LINT.md; docs/dev-process-plan.md D16 and D19, build steps 3 and 4).

TypeScript's checker and ESLint for TypeScript and JavaScript, Ruff and Pyright for Python, an import check, a check that
no comment turns a checker off, and a check that no new code comment lands. Each finding is keyed by its tool, rule, file
and the text of its line, so moving code does not change it. Today's findings are recorded in .lint/baseline.json, which
only shrinks: a change fails only on findings the baseline does not hold, in a file it touches, or in a file it does not
touch when main does not have that finding too.

  python3 .security/lint.py gate       the gate's step: every tool over the tracked tree, against LOCAL_GATE_BASE when set
  python3 .security/lint.py staged     the pre-commit hook: the fast tools over the staged files
  python3 .security/lint.py prune      drop baseline entries the code no longer has
  python3 .security/lint.py prune --resolved-only   the same, but every kept entry keeps its line field untouched
  python3 .security/lint.py counts     findings per tool and how many the baseline holds
  python3 .security/lint.py counts --folders   comment lines per folder, for the cleanup parts
  python3 .security/lint.py baseline   write the first entries for a tool the baseline does not hold yet; never touches a held tool
"""
import ast
import collections
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tokenize

ROOT = Path(__file__).resolve().parent.parent
BASELINE = '.lint/baseline.json'
CONFIG_FILES = ['.lint/ruff.toml', '.lint/eslint.config.mjs', '.lint/tsconfig.json', '.lint/ts-reader.mjs',
                'pyrightconfig.json', 'package.json', 'tsconfig.json']
POLICY_FILES = ['.lint/ruff.toml', '.lint/eslint.config.mjs', '.lint/tsconfig.json', '.lint/ts-reader.mjs', 'pyrightconfig.json']
POLICY_SYMBOLS = {'TSC_KEPT', 'tsc_kept', 'PYRIGHT_CALL_KEPT', 'pyright_kept'}
INSTALL = 'bash .cursor/install-lint.sh'
TS_SUFFIXES = ('.ts', '.mts', '.cts')
JS_SUFFIXES = ('.js', '.mjs', '.cjs')
SCRIPT_SUFFIXES = TS_SUFFIXES + JS_SUFFIXES
SHELL_SUFFIXES = ('.sh', '.bash')
SHELL_SHEBANG = re.compile(rb'^#!\s*\S*/(?:env\s+)?(?:ba|da|k)?sh(?:\s|$)')
SKIPPED_PARTS = {'node_modules', '.git', '__pycache__', 'dist'}
GATE_TOOLS = ('ruff', 'pyright', 'eslint', 'tsc', 'imports', 'suppress', 'comments')
STAGED_TOOLS = ('ruff', 'pyright', 'eslint', 'imports', 'suppress', 'comments')
FIRST_TOOLS = ('ruff', 'pyright', 'eslint', 'tsc', 'imports', 'suppress')
TSC_LINE = re.compile(r'^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$')
TSC_KEPT = {'TS2304', 'TS2552', 'TS2580', 'TS2591', 'TS2592', 'TS2300', 'TS2451', 'TS2393', 'TS2323',
            'TS2307', 'TS2305', 'TS2306', 'TS2613', 'TS2614', 'TS2724', 'TS2459', 'TS2460'}
PYRIGHT_CALL_KEPT = ('Expected ', 'No parameter named', 'Argument missing for parameter', 'Arguments missing for parameters',
                     'Multiple parameters')
PYRIGHT_UNREAD_MODULES = ('"tconnectsync"',)
PY_LOADERS = {'spec_from_file_location': 1, 'SourceFileLoader': 1, 'run_path': 0, 'import_module': 0}
TEST_PATH = re.compile(r'(^|/)(tests|fixtures)(/|$)')
TEST_MODULE = re.compile(r'^(tests|fixtures)(\.|$)')
WORKTREE_PATH = re.compile(r'(^|/)(\.t3|worktrees)(/|$)')
OUTSIDE_PATH = re.compile(r'^(/|~)|/code/')
PY_SUPPRESS = re.compile(r'#\s*(pyright\s*:|type\s*:\s*ignore)')
JS_SUPPRESS = re.compile(r'^[\s*/]*(?:@ts-(?:nocheck|ignore|expect-error)\b|eslint-(?:disable|enable)\b)')
JS_DIRECTIVE = re.compile(r'^\s*(?:///\s*<(?:reference|amd-module|amd-dependency)\b|//\s*@ts-check\s*$|/?\*?\s*@vitest-environment\s)')
PY_CODING = re.compile(r'^#\s*(?:-\*-\s*)?(?:vim?:\s*(?:set\s+)?(?:fileencoding|encoding)|(?:file)?encoding|coding)[:=]\s*[-\w.]+\s*(?:-\*-)?\s*:?\s*$')
SHELLCHECK_READS = re.compile(r'^#\s*shellcheck\s+(?:(?:shell|source|source-path)=\S+\s*)+$')
UPSTREAM_LINK = re.compile(
    r'https?://(?:'
    r'(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org)/(?!sfls1397/)[^\s/]+/[^\s/]+/(?:-/)?(?:issues|pull|pulls|merge_requests|discussions)/\d+'
    r'|(?:bugs|bugzilla)\.[\w.-]+/\S*\d'
    r'|[\w.-]+/show_bug\.cgi\?id=\d+'
    r'|crbug\.com/\d+|issues\.chromium\.org/issues/\d+|issuetracker\.google\.com/issues/\d+'
    r'|(?:www\.)?rfc-editor\.org/rfc/rfc\d+|datatracker\.ietf\.org/doc/(?:html/)?rfc\d+|tools\.ietf\.org/html/rfc\d+)', re.I)
LICENSE_TEXT = re.compile(r'SPDX-License-Identifier:|\bCopyright\b|\bLicensed under\b|Permission is hereby granted|\bAll rights reserved\b', re.I)
SHOWN = 40
SHOWN_WARNINGS = 5
LINT_HOME = Path(os.environ.get('DIABETES_LINT_HOME') or Path.home() / '.local/share/repo-lint/diabetes-data-mcp')


class LintError(Exception):
    pass


def lock_hash():
    path = ROOT / '.lint/package-lock.json'
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16] if path.is_file() else 'none'


def node_modules():
    path = LINT_HOME / ('node-' + lock_hash()) / 'node_modules'
    if not (path / '.bin/eslint').exists():
        raise LintError('the lint tools are not installed for this lockfile; run %s' % INSTALL)
    return path


def tool(name):
    if name in ('ruff', 'shfmt'):
        path = LINT_HOME / 'bin' / name
    else:
        path = node_modules() / '.bin' / name
    if not path.exists():
        raise LintError('%s missing; run %s' % (name, INSTALL))
    return str(path)


def link_tools(root):
    target = Path(root) / '.lint/node_modules'
    wanted = node_modules()
    if target.is_symlink() and os.path.realpath(str(target)) == os.path.realpath(str(wanted)):
        return
    if target.is_symlink():
        target.unlink()
    if target.exists():
        raise LintError('%s is not a link to the lint install; remove it and run %s' % (target, INSTALL))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.symlink_to(wanted)


def run(args, cwd, ok=(0,), env=None):
    try:
        result = subprocess.run(args, cwd=str(cwd), capture_output=True, text=True, env=env)
    except OSError as error:
        raise LintError('%s could not start (%s); run %s' % (Path(args[0]).name, error.strerror, INSTALL))
    if result.returncode == 127 and 'node' in (result.stderr or ''):
        raise LintError('%s needs node, which is not on PATH; add the folder that holds node to PATH' % Path(args[0]).name)
    if result.returncode not in ok:
        tail = '\n'.join((result.stderr or result.stdout or '').strip().splitlines()[-15:])
        raise LintError('%s exited %d; run %s if it is missing or not the pinned version\n%s' % (Path(args[0]).name, result.returncode, INSTALL, tail))
    return result


def git(args, cwd=ROOT, binary=False):
    result = subprocess.run(['git'] + args, cwd=str(cwd), capture_output=True)
    if result.returncode:
        raise LintError('git %s failed: %s' % (args[0], result.stderr.decode(errors='replace').strip()[-300:]))
    return result.stdout if binary else result.stdout.decode()


def text_hash(text):
    return hashlib.sha256(text.strip().encode()).hexdigest()[:16]


def finding(tool_name, rule, file, line, message, text):
    return {'tool': tool_name, 'rule': rule, 'file': file, 'line': line, 'message': ' '.join(message.split())[:300],
            'hash': text_hash(text)}


def key(item):
    return (item['tool'], item['rule'], item['file'], item['hash'])


def relative(root, name):
    path = os.path.realpath(name if os.path.isabs(name) else os.path.join(str(root), name))
    base = os.path.realpath(str(root))
    return os.path.relpath(path, base) if path.startswith(base + os.sep) else name


class Source:

    def __init__(self, root):
        self.root = Path(root)
        self.cache = {}
        self.lock = threading.Lock()
        self.script = None

    def lines(self, name):
        if name not in self.cache:
            try:
                self.cache[name] = (self.root / name).read_text(errors='replace').splitlines()
            except OSError:
                self.cache[name] = []
        return self.cache[name]

    def line(self, name, number):
        lines = self.lines(name)
        return lines[number - 1] if 0 < number <= len(lines) else ''

    def script_read(self, script):
        with self.lock:
            if self.script is None:
                real = os.path.realpath(str(node_modules()))
                result = run(['node', '.lint/ts-reader.mjs', real, str(self.root)] + script, self.root)
                try:
                    self.script = json.loads(result.stdout)
                except ValueError:
                    raise LintError('the comment reader gave no JSON; run %s' % INSTALL)
        return self.script


def kinds(root, names):
    python, script, shell = [], [], []
    for name in sorted(set(names)):
        path = Path(root) / name
        if any(part in SKIPPED_PARTS for part in Path(name).parts) or path.is_symlink() or not path.is_file():
            continue
        if name.endswith('.py'):
            python.append(name)
        elif name.endswith(SCRIPT_SUFFIXES):
            script.append(name)
        elif name.endswith(SHELL_SUFFIXES):
            shell.append(name)
        elif not Path(name).suffix:
            with path.open('rb') as handle:
                first = handle.readline(200)
            if first.startswith(b'#!') and b'python' in first:
                python.append(name)
            elif SHELL_SHEBANG.match(first):
                shell.append(name)
    return python, script, shell


def check_ruff(root, python, script, shell, source):
    if not python:
        return []
    result = run([tool('ruff'), 'check', '--config', '.lint/ruff.toml', '--ignore-noqa', '--no-cache', '--output-format', 'json', '--'] + python,
                 root, ok=(0, 1))
    found = []
    for item in json.loads(result.stdout or '[]'):
        name = relative(root, item['filename'])
        line = (item.get('location') or {}).get('row') or 0
        found.append(finding('ruff', item.get('code') or 'syntax', name, line, item.get('message', ''), source.line(name, line)))
    return found


def pyright_kept(item):
    rule = item.get('rule') or ''
    message = item.get('message', '')
    if item.get('severity') not in ('error', 'warning'):
        return False
    if rule == 'reportAttributeAccessIssue':
        first = message.split('\n')[0]
        return 'of module' in first and not first.endswith(tuple('module ' + name for name in PYRIGHT_UNREAD_MODULES))
    if rule == 'reportCallIssue':
        return message.startswith(PYRIGHT_CALL_KEPT)
    if rule == 'reportGeneralTypeIssues':
        return 'requires Python' in message
    return True


def undotted(name):
    return '/'.join('dot_' + part[1:] if part.startswith('.') else part for part in name.split('/'))


def check_pyright(root, python, script, shell, source):
    if not python:
        return []
    with tempfile.TemporaryDirectory(prefix='lint-pyright-') as folder:
        mirror = Path(folder)
        mapped = {undotted(name): name for name in python}
        for copy, name in mapped.items():
            (mirror / copy).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(Path(root) / name, mirror / copy)
        shutil.copyfile(Path(root) / 'pyrightconfig.json', mirror / 'pyrightconfig.json')
        result = run([tool('pyright'), '--outputjson'] + sorted(mapped), mirror, ok=(0, 1))
        try:
            data = json.loads(result.stdout)
        except ValueError:
            raise LintError('pyright gave no JSON; run %s' % INSTALL)
    if data.get('summary', {}).get('filesAnalyzed', 0) < len(python):
        raise LintError('pyright read %d of %d Python files' % (data.get('summary', {}).get('filesAnalyzed', 0), len(python)))
    found = []
    for item in data.get('generalDiagnostics', []):
        if not pyright_kept(item):
            continue
        name = mapped.get(relative(folder, item.get('file', '')), item.get('file', ''))
        line = item.get('range', {}).get('start', {}).get('line', -1) + 1
        rule = item.get('rule') or 'error'
        if rule == 'reportAttributeAccessIssue':
            rule = 'reportAttributeAccessIssue:module'
        found.append(finding('pyright', rule, name, line, item['message'].split('\n')[0], source.line(name, line)))
    return found


def check_eslint(root, python, script, shell, source, typed=True):
    if not script:
        return []
    env = dict(os.environ, LINT_TYPED='1' if typed else '0')
    result = run([tool('eslint'), '-c', '.lint/eslint.config.mjs', '--no-warn-ignored', '--no-inline-config', '--format', 'json', '--'] + script,
                 root, ok=(0, 1), env=env)
    found = []
    for item in json.loads(result.stdout or '[]'):
        name = relative(root, item['filePath'])
        for message in item.get('messages', []):
            line = message.get('line') or 0
            found.append(finding('eslint', message.get('ruleId') or 'parse', name, line, message.get('message', ''), source.line(name, line)))
    return found


def tsc_kept(code, name):
    if name.endswith(TS_SUFFIXES):
        return True
    return code in TSC_KEPT


def check_tsc(root, python, script, shell, source):
    if not script:
        return []
    result = run([tool('tsc'), '-p', '.lint/tsconfig.json', '--pretty', 'false'], root, ok=(0, 1, 2))
    found, parsed = [], 0
    for raw in result.stdout.splitlines():
        match = TSC_LINE.match(raw)
        parsed += bool(match)
        if not match:
            if re.search(r'error TS(5\d{3}|6\d{3}|2688)', raw):
                raise LintError('tsc could not read its setup: %s; run %s' % (raw.strip()[:200], INSTALL))
            continue
        name, line, _, code, message = match.groups()
        name = relative(root, name)
        if not tsc_kept(code, name):
            continue
        found.append(finding('tsc', code, name, int(line), message, source.line(name, int(line))))
    if result.returncode and not parsed:
        raise LintError('tsc exited %d without naming an error; run %s\n%s' % (result.returncode, INSTALL, (result.stdout + result.stderr).strip()[-300:]))
    return found


def literals(node):
    return [item.value for item in ast.walk(node) if isinstance(item, ast.Constant) and isinstance(item.value, str)]


def call_name(node):
    func = node.func
    if isinstance(func, ast.Attribute):
        if func.attr in ('insert', 'append') and isinstance(func.value, ast.Attribute) and func.value.attr == 'path' \
                and isinstance(func.value.value, ast.Name) and func.value.value.id == 'sys':
            return 'sys.path.' + func.attr
        return func.attr
    return func.id if isinstance(func, ast.Name) else ''


def import_rule(text, from_test, module=False):
    if not from_test and (TEST_MODULE.match(text) if module else TEST_PATH.search(text)):
        return 'no-test-or-fixture-import'
    if not module and WORKTREE_PATH.search(text):
        return 'no-worktree-import'
    if not module and OUTSIDE_PATH.search(text):
        return 'no-import-outside-repo'
    return None


def python_imports(root, python, source):
    found = []
    for name in python:
        try:
            tree = ast.parse('\n'.join(source.lines(name)), filename=name)
        except (SyntaxError, ValueError):
            continue
        from_test = name.startswith('tests/') or Path(name).name.startswith('test_')
        for node in ast.walk(tree):
            checks = []
            if isinstance(node, ast.Import):
                checks = [(alias.name, True) for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
                checks = [(node.module, True)]
            elif isinstance(node, ast.Call):
                called = call_name(node)
                index = {'sys.path.insert': 1, 'sys.path.append': 0}.get(called, PY_LOADERS.get(called))
                if index is not None and len(node.args) > index:
                    checks = [(text, called == 'import_module') for text in literals(node.args[index])]
            for text, module in checks:
                rule = import_rule(text, from_test, module)
                if rule:
                    line = getattr(node, 'lineno', 0)
                    found.append(finding('imports', rule, name, line, 'imports %s' % text, source.line(name, line)))
    return found


def script_import_rule(name, spec, root):
    from_test = name.startswith('tests/') or bool(re.search(r'\.(test|spec)\.[cm]?[jt]s$', name))
    rule = import_rule(spec, from_test)
    if rule:
        return rule
    if spec.startswith('.'):
        target = os.path.normpath(os.path.join(os.path.dirname(name), spec))
        if target == '..' or target.startswith('..' + os.sep):
            return 'no-import-outside-repo'
    return None


def check_imports(root, python, script, shell, source):
    found = python_imports(root, python, source)
    if script:
        for item in source.script_read(script)['imports']:
            name = relative(root, item['file'])
            rule = script_import_rule(name, item['spec'], root)
            if rule:
                found.append(finding('imports', rule, name, item['line'], 'imports %s' % item['spec'], source.line(name, item['line'])))
    return found


def python_tokens(source, name):
    text = '\n'.join(source.lines(name)) + '\n'
    try:
        return list(tokenize.generate_tokens(io.StringIO(text).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return []


def check_suppress(root, python, script, shell, source):
    found = []
    for name in python:
        for token in python_tokens(source, name):
            if token.type == tokenize.COMMENT and PY_SUPPRESS.search(token.string):
                line = token.start[0]
                found.append(finding('suppress', 'inline-suppression', name, line, 'a comment that turns a checker off', source.line(name, line)))
    if script:
        for item in source.script_read(script)['comments']:
            for offset, part in enumerate(item['value'].split('\n')):
                if JS_SUPPRESS.search(part):
                    name, line = relative(root, item['file']), item['line'] + offset
                    found.append(finding('suppress', 'inline-suppression', name, line, 'a comment that turns a checker off', source.line(name, line)))
    return found


def whole_lines(lines, spans):
    whole = set()
    for start, first, end, last in spans:
        for number in range(start, end + 1):
            text = lines[number - 1] if 0 < number <= len(lines) else ''
            before = text[:first] if number == start else ''
            after = text[last:] if number == end else ''
            if not before.strip() and not after.strip():
                whole.add(number)
    return whole


def license_block(lines, spans):
    whole = whole_lines(lines, spans)
    block = set()
    for number, text in enumerate(lines, 1):
        if number in whole:
            block.add(number)
        elif text.strip():
            break
    return block if any(LICENSE_TEXT.search(lines[number - 1]) for number in block) else set()


def comment_findings(name, lines, spans, skip):
    licensed = license_block(lines, spans)
    found = {}
    for start, first, end, last in spans:
        for number in range(start, end + 1):
            text = lines[number - 1] if 0 < number <= len(lines) else ''
            part = text[first if number == start else 0:last if number == end else len(text)]
            if number in licensed or UPSTREAM_LINK.search(part) or (number == 1 and text.startswith('#!')) or skip(number, part):
                continue
            found.setdefault(number, finding('comments', 'no-comment', name, number, 'a code comment', text))
    return list(found.values())


def docstring_lines(tree):
    module_read = any(isinstance(node, ast.Name) and node.id == '__doc__' for node in ast.walk(tree))
    read = {node.value.id for node in ast.walk(tree)
            if isinstance(node, ast.Attribute) and node.attr == '__doc__' and isinstance(node.value, ast.Name)}
    lines = set()
    for node in ast.walk(tree):
        for field in ('body', 'orelse', 'finalbody'):
            body = getattr(node, field, None)
            if not isinstance(body, list):
                continue
            for index, statement in enumerate(body):
                if not (isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str)):
                    continue
                if field == 'body' and index == 0 and (
                        (isinstance(node, ast.Module) and module_read)
                        or (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name in read)):
                    continue
                lines.update(range(statement.lineno, statement.end_lineno + 1))
    return lines


def python_comments(name, source):
    lines = source.lines(name)
    spans = [(token.start[0], token.start[1], token.end[0], token.end[1]) for token in python_tokens(source, name)
             if token.type == tokenize.COMMENT and not PY_SUPPRESS.search(token.string)]
    found = comment_findings(name, lines, spans,
                             lambda number, part: number <= 2 and PY_CODING.match(part) and part.strip() == source.line(name, number).strip())
    try:
        tree = ast.parse('\n'.join(lines), filename=name)
    except (SyntaxError, ValueError):
        return found
    for number in sorted(docstring_lines(tree)):
        found.append(finding('comments', 'no-docstring', name, number, 'a docstring nothing reads', source.line(name, number)))
    return found


def shell_spans(root, text):
    result = subprocess.run([tool('shfmt'), '-ln', 'bash', '--to-json'], input=text, cwd=str(root), capture_output=True, text=True)
    if result.returncode:
        return None
    spans, stack = {}, [json.loads(result.stdout)]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(node)
        elif isinstance(node, dict):
            if isinstance(node.get('Hash'), dict) and 'Text' in node:
                line, column = node['Hash']['Line'], node['Hash']['Col'] - 1
                spans[(line, column)] = (line, column, line, column + 1 + len(node['Text']))
            stack.extend(node.values())
    return sorted(spans.values())


def shell_comments(root, name, source):
    lines = source.lines(name)
    spans = shell_spans(root, '\n'.join(lines) + '\n')
    if spans is None:
        return [finding('comments', 'unreadable-shell', name, 0, 'shfmt could not parse this shell file, so its comments are unchecked', name)]
    return comment_findings(name, lines, spans, lambda number, part: SHELLCHECK_READS.match(part))


def check_comments(root, python, script, shell, source):
    found = []
    for name in python:
        found += python_comments(name, source)
    if script:
        spans = collections.defaultdict(list)
        read = source.script_read(script)
        for name in read['unread']:
            name = relative(root, name)
            found.append(finding('comments', 'unreadable-script', name, 0, 'the TypeScript parser could not read this file, so its comments are unchecked', name))
        for item in read['comments']:
            spans[relative(root, item['file'])].append((item['line'], item['column'], item['endLine'], item['endColumn']))
        for name, items in sorted(spans.items()):
            found += comment_findings(name, source.lines(name), items,
                                      lambda number, part: JS_SUPPRESS.search(part) or JS_DIRECTIVE.search(part))
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for items in pool.map(lambda name: shell_comments(root, name, source), shell):
            found += items
    return found


CHECKS = {'ruff': check_ruff, 'pyright': check_pyright, 'eslint': check_eslint, 'tsc': check_tsc, 'imports': check_imports,
          'suppress': check_suppress, 'comments': check_comments}


def needed(tools, python, script, shell):
    wanted = {'ruff': python, 'pyright': python, 'eslint': script, 'tsc': script}
    commands = {t for t in tools if wanted.get(t)}
    if script and ('suppress' in tools or 'comments' in tools or 'imports' in tools):
        commands.add('node')
    if shell and 'comments' in tools:
        commands.add('shfmt')
    return commands


def check(root, names, tools, staged=False):
    python, script, shell = kinds(root, names)
    link_tools(root)
    missing = sorted(c for c in needed(tools, python, script, shell) if c == 'node' and not shutil.which('node'))
    if missing:
        raise LintError('node missing; put the folder that holds node on PATH')
    source = Source(root)
    for name in python + script + shell:
        source.lines(name)
    timings, found = {}, []

    def one(name):
        started = time.time()
        if name == 'eslint':
            items = check_eslint(root, python, script, shell, source, typed=not staged)
        else:
            items = CHECKS[name](root, python, script, shell, source)
        timings[name] = time.time() - started
        return items
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(tools)) as pool:
        for items in pool.map(one, tools):
            found += items
    return found, timings, (len(python), len(script), len(shell))


def tracked(root):
    return [os.fsdecode(name) for name in git(['ls-files', '-z'], root, binary=True).split(b'\0') if name]


def held_tools(data):
    return set(data.get('tools', FIRST_TOOLS)) if data else set()


def read_baseline(text):
    data = json.loads(text) if text else {}
    counts = collections.Counter()
    for item in data.get('findings', []):
        counts[(item['tool'], item['rule'], item['file'], item['hash'])] += int(item.get('count', 1))
    return counts, data


def renamed(counts, renames):
    moved = collections.Counter()
    for (tool_name, rule, file, digest), count in counts.items():
        moved[(tool_name, rule, renames.get(file, file), digest)] += count
    return moved


def changes(args, cwd):
    out = git(['diff', '--name-status', '-M', '-z'] + args, cwd, binary=True).split(b'\0')
    touched, renames, index = set(), {}, 0
    while index < len(out) and out[index]:
        status = out[index].decode()
        if status[0] in 'RC':
            old, new = os.fsdecode(out[index + 1]), os.fsdecode(out[index + 2])
            touched.add(new)
            if status[0] == 'R':
                renames[old] = new
            index += 3
        else:
            touched.add(os.fsdecode(out[index + 1]))
            index += 2
    return touched, renames


def beyond(found, allowed):
    left = collections.Counter(allowed)
    extra = []
    for item in sorted(found, key=lambda f: (f['file'], f['line'], f['tool'], f['rule'])):
        if left[key(item)] > 0:
            left[key(item)] -= 1
        else:
            extra.append(item)
    return extra


def shown(item):
    return '%s %s %s:%s: %s' % (item['tool'], item['rule'], item['file'], item['line'], item['message'])


def hint(tool_name):
    return {'ruff': 'ruff check --config .lint/ruff.toml <file>', 'pyright': 'pyright <file>',
            'eslint': 'eslint -c .lint/eslint.config.mjs <file> (LINT_TYPED=1 for the type-aware rules)',
            'tsc': 'tsc -p .lint/tsconfig.json',
            'imports': 'a file outside tests/ may not load tests or fixtures, a worktree or another repo',
            'suppress': 'fix the finding instead of turning the checker off',
            'comments': 'say it with a better name or a test, or move the why to the rule, doc or commit message that owns it; '
                        'allowed: shebangs, upstream issue, RFC or bug links, license text, tool directives (docs/TYPES-AND-LINT.md)'}[tool_name]


def report_blocked(blocked, label):
    for item in blocked[:SHOWN]:
        print('lint BLOCKED: ' + shown(item))
    if len(blocked) > SHOWN:
        print('lint BLOCKED: ... and %d more' % (len(blocked) - SHOWN))
    for tool_name in sorted({item['tool'] for item in blocked if item['tool'] in GATE_TOOLS}):
        print('  %s: %s' % (tool_name, hint(tool_name)))
    print('Types and lint BLOCKED: %d new finding%s %s (docs/TYPES-AND-LINT.md). Fix the code; the baseline only shrinks.'
          % (len(blocked), '' if len(blocked) == 1 else 's', label))


def base_findings(base, tools):
    folder = Path(tempfile.mkdtemp(prefix='lint-base-'))
    tree = folder / 'tree'
    try:
        git(['worktree', 'add', '--detach', '--quiet', str(tree), base])
        for name in CONFIG_FILES:
            if (ROOT / name).is_file():
                (tree / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, tree / name)
        if (ROOT / 'node_modules').is_dir() and not (tree / 'node_modules').exists():
            (tree / 'node_modules').symlink_to(ROOT / 'node_modules')
        found, _, _ = check(tree, tracked(tree), tools)
        return found
    finally:
        subprocess.run(['git', 'worktree', 'remove', '--force', str(tree)], cwd=str(ROOT), capture_output=True)
        shutil.rmtree(str(folder), ignore_errors=True)


def policy_digest(base=None):
    def text(name):
        if base:
            result = subprocess.run(['git', 'show', '%s:%s' % (base, name)], cwd=str(ROOT), capture_output=True, text=True)
            if result.returncode:
                return None
            return result.stdout
        path = ROOT / name
        return path.read_text() if path.is_file() else None

    policy = {name: text(name) for name in POLICY_FILES}
    code = ast.parse(text('.security/lint.py') or '')
    for statement in code.body:
        names = {statement.name} if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)) else {
            target.id for target in statement.targets if isinstance(target, ast.Name)
        } if isinstance(statement, ast.Assign) else set()
        if names & POLICY_SYMBOLS:
            policy['symbols:' + ','.join(sorted(names))] = ast.dump(statement, include_attributes=False)
    return hashlib.sha256(json.dumps(policy, sort_keys=True).encode()).hexdigest()


def policy_review(base):
    if subprocess.run(['git', 'cat-file', '-e', base + ':.security/lint.py'], cwd=str(ROOT), capture_output=True).returncode:
        return []
    before, after = policy_digest(base), policy_digest()
    if before == after:
        return []
    path = ROOT / '.lint/policy-review.json'
    try:
        note = json.loads(path.read_text()) if not path.is_symlink() else None
        accepted = isinstance(note, dict) and note.get('before') == before and note.get('after') == after and isinstance(note.get('reason'), str) and len(note['reason'].strip()) >= 40
    except (OSError, ValueError):
        accepted = False
    if accepted:
        print('Lint policy change has an exact reviewer note; the fresh reviewer must assess its rationale')
        return []
    return [{'tool': 'policy', 'rule': 'lint-policy-review', 'file': '.lint/policy-review.json', 'line': 0,
             'message': 'Lint policy changed: record before %s, after %s and a specific review reason (at least 40 characters); review cannot be waived' % (before, after)}]


def check_pins():
    installer = (ROOT / '.cursor/install-lint.sh').read_text()
    seen = []
    for name, variable, extract in (('ruff', 'version', lambda out: out.split()[-1]), ('shfmt', 'shfmt_version', lambda out: out.strip().lstrip('v'))):
        match = re.search(r'^%s=(\S+)$' % variable, installer, re.M)
        if not match:
            raise LintError('no %s pin in .cursor/install-lint.sh' % name)
        installed = extract(run([tool(name), '--version'], ROOT).stdout)
        if installed != match.group(1):
            raise LintError('%s is %s, not the pinned %s; run %s' % (name, installed, match.group(1), INSTALL))
        seen.append('%s %s' % (name, installed))
    seen.append('node tools %s' % lock_hash())
    return seen


def gate():
    started = time.time()
    pins = check_pins()
    found, timings, sizes = check(ROOT, tracked(ROOT), GATE_TOOLS)
    path = ROOT / BASELINE
    allowed, _ = read_baseline(path.read_text() if path.exists() else '')
    base = os.environ.get('LOCAL_GATE_BASE', '').strip()
    if base and subprocess.run(['git', 'cat-file', '-e', base + '^{commit}'], cwd=str(ROOT), capture_output=True).returncode:
        print('gate-warning: lint: LOCAL_GATE_BASE is not a commit here, so new findings are only reported')
        base = ''
    blocked, warned = [], []
    if base:
        _, renames = changes([base, 'HEAD'], ROOT)
        blocked += policy_review(base)
        allowed = renamed(allowed, renames)
        try:
            before, before_data = read_baseline(git(['show', '%s:%s' % (base, BASELINE)]))
        except LintError:
            before = None
        if before is not None:
            before = renamed(before, renames)
            first = collections.Counter(key(item) for item in found)
            for entry, count in sorted(allowed.items()):
                if count > (before[entry] if entry[0] in held_tools(before_data) else first[entry]):
                    print('lint BLOCKED: the baseline grew: %s %s %s' % entry[:3])
                    blocked.append({'tool': entry[0], 'rule': 'baseline-grew', 'file': entry[2], 'line': 0, 'message': 'baseline grew'})
        new = beyond(found, allowed)
        if new:
            on_main = renamed(collections.Counter(key(item) for item in base_findings(base, sorted({item['tool'] for item in new}))), renames)
            main_left = collections.Counter({k: max(0, n - allowed[k]) for k, n in on_main.items()})
            for item in new:
                if main_left[key(item)] > 0:
                    main_left[key(item)] -= 1
                    warned.append(item)
                else:
                    blocked.append(item)
    else:
        warned = beyond(found, allowed)
    stale = sum((allowed - collections.Counter(key(item) for item in found)).values())
    for item in warned[:SHOWN_WARNINGS]:
        print('gate-warning: lint: %s %s %s:%s is new since the baseline but on main too, not from this change'
              % (item['tool'], item['rule'], item['file'], item['line']) if base else
              'gate-warning: lint: %s %s %s:%s is not in the baseline' % (item['tool'], item['rule'], item['file'], item['line']))
    if len(warned) > SHOWN_WARNINGS:
        print('gate-warning: lint: ... and %d more findings outside the baseline (see this step\'s log)' % (len(warned) - SHOWN_WARNINGS))
    for item in warned[SHOWN_WARNINGS:SHOWN]:
        print('lint (not blocking): ' + shown(item))
    if stale:
        print('gate-warning: lint: %d baseline entr%s no longer found; shrink it with python3 .security/lint.py prune'
              % (stale, 'y is' if stale == 1 else 'ies are'))
    took = ', '.join('%s %.1fs' % kv for kv in sorted(timings.items()))
    if blocked:
        report_blocked(blocked, 'in this change')
        print('Checked %d Python and %d TypeScript or JavaScript files, %d shell files in %.1fs (%s)' % (sizes + (time.time() - started, took)))
        return 1
    print('Types and lint PASS: %d Python and %d TypeScript or JavaScript files, %d shell files, %d findings held by the baseline, none new; %.1fs (%s; %s)'
          % (sizes + (len(found) - len(warned), time.time() - started, took, ', '.join(pins))))
    return 0


def staged():
    started = time.time()
    names = [os.fsdecode(p) for p in git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], binary=True).split(b'\0') if p]
    if not names:
        return 0
    with tempfile.TemporaryDirectory(prefix='lint-staged-') as folder:
        snapshot = Path(folder)
        for name in dict.fromkeys(names + CONFIG_FILES + [BASELINE]):
            entries = [x for x in git(['ls-files', '--stage', '-z', '--', ':(literal)' + name], binary=True).split(b'\0') if x]
            if not entries:
                continue
            mode, oid, stage = entries[0].split(b'\t', 1)[0].split()
            if stage != b'0' or mode not in (b'100644', b'100755'):
                continue
            target = snapshot / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git(['cat-file', 'blob', oid.decode()], binary=True))
        python, script, shell = kinds(snapshot, names)
        if not python and not script and not shell:
            return 0
        tools = [t for t in STAGED_TOOLS if (t not in ('ruff', 'pyright') or python) and (t != 'eslint' or script)]
        found, timings, sizes = check(snapshot, python + script + shell, tools, staged=True)
        path = snapshot / BASELINE
        allowed, _ = read_baseline(path.read_text() if path.exists() else '')
    _, renames = changes(['--cached'], ROOT)
    blocked = beyond(found, renamed(allowed, renames))
    if blocked:
        report_blocked(blocked, 'in the staged files')
        return 1
    print('Types and lint PASS on %d staged Python and %d TypeScript or JavaScript files, %d shell files in %.1fs' % (sizes + (time.time() - started,)))
    return 0


def write_baseline(counts, found, about, tools):
    lines = {}
    for item in found:
        lines.setdefault(key(item), item['line'])
    entries = [{'tool': k[0], 'rule': k[1], 'file': k[2], 'hash': k[3], 'count': n, 'line': lines.get(k, 0)}
               for k, n in sorted(counts.items()) if n > 0]
    body = ',\n'.join('  ' + json.dumps(entry, sort_keys=True) for entry in entries)
    (ROOT / BASELINE).write_text('{\n "_about": %s,\n "tools": %s,\n "findings": [\n%s\n ]\n}\n'
                                 % (json.dumps(about), json.dumps(sorted(tools)), body))
    return sum(counts.values())


ABOUT = ('Findings in code that was here before the lint step (.security/lint.py, docs/TYPES-AND-LINT.md). Each is keyed by tool, rule, '
         'file and a hash of its line\'s text; line is only a hint. This list only shrinks: fix the code, then run '
         'python3 .security/lint.py prune. Never add an entry.')


def prune(resolved_only=False):
    found, _, _ = check(ROOT, tracked(ROOT), GATE_TOOLS)
    allowed, data = read_baseline((ROOT / BASELINE).read_text())
    kept = allowed & collections.Counter(key(item) for item in found)
    if resolved_only:
        total = write_baseline(kept, data.get('findings', []), data.get('_about', ABOUT), held_tools(data))
    else:
        total = write_baseline(kept, found, ABOUT, held_tools(data))
    print('Baseline: %d entries kept, %d dropped' % (total, sum(allowed.values()) - total))
    return 0


def counts(folders=False):
    found, timings, sizes = check(ROOT, tracked(ROOT), GATE_TOOLS)
    path = ROOT / BASELINE
    allowed, _ = read_baseline(path.read_text() if path.exists() else '')
    by_tool = collections.Counter(item['tool'] for item in found)
    for tool_name in GATE_TOOLS:
        print('%-9s %4d findings  %5.1fs' % (tool_name, by_tool[tool_name], timings.get(tool_name, 0)))
    print('total     %4d findings, %d outside the baseline, in %d Python and %d TypeScript or JavaScript files, %d shell files'
          % ((len(found), len(beyond(found, allowed))) + sizes))
    if folders:
        lines, files = collections.Counter(), collections.defaultdict(collections.Counter)
        for item in found:
            if item['tool'] == 'comments':
                top = item['file'].split('/')[0] if '/' in item['file'] else '.'
                lines[top] += 1
                files[top][item['file']] += 1
        for top, number in sorted(lines.items(), key=lambda kv: (-kv[1], kv[0])):
            print('%-12s %5d comment lines in %d files' % (top, number, len(files[top])))
        for name, number in collections.Counter({f: n for c in files.values() for f, n in c.items()}).most_common(10):
            print('  %5d %s' % (number, name))
    return 0


def baseline():
    path = ROOT / BASELINE
    allowed, data = read_baseline(path.read_text() if path.exists() else '')
    held = held_tools(data)
    new = [tool_name for tool_name in GATE_TOOLS if tool_name not in held]
    if not new:
        print('The baseline holds every tool and only shrinks: use python3 .security/lint.py prune', file=sys.stderr)
        return 1
    found, _, _ = check(ROOT, tracked(ROOT), GATE_TOOLS)
    held_counts = allowed + collections.Counter(key(item) for item in found if item['tool'] in new)
    total = write_baseline(held_counts, found, ABOUT, held | set(new))
    print('Baseline written: %d findings, first entries for %s' % (total, ', '.join(new)))
    return 0


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    extra = sys.argv[2:]
    if mode == 'counts' and extra in ([], ['--folders']):
        return counts(folders=bool(extra))
    actions = {'gate': gate, 'staged': staged, 'prune': prune, 'baseline': baseline}
    if mode not in actions or (extra and not (mode == 'prune' and extra == ['--resolved-only'])):
        print(__doc__, file=sys.stderr)
        return 2
    return prune(resolved_only=True) if extra else actions[mode]()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except LintError as error:
        print('Types and lint BLOCKED: %s' % error)
        sys.exit(1)

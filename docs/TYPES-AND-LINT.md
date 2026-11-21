# Types and strict lint

Build steps 3 and 4 of the development process plan (D16, D19), copied from the Toolbox's `docs/TYPES-AND-LINT.md` and its `.security/lint.py`, and from the same step in ResMed-Data-MCP, SimpleFIN-Data-MCP and Alexa-Echo-MCP. Whole kinds of mistakes fail in seconds, before any test runs, and no new code comment lands. Lauren Tan: "lint rules, type systems, compilers" come first, and "start with a lint rule to prevent new occurrences of anti-patterns and then clean up those old patterns as well". Comments "go stale easily", so they are banned by a lint rule. The comments that existed when the rule landed are all cleaned out ([below](#comments-cleaned-out)).

## What runs

This repository holds TypeScript (`src`, `tests`), Python (`sync`, `tconnectsync`, `tests`, `.security`), shell (16 files, some without a suffix) and a few JavaScript files (`bin`, `scripts`, `nightscout`). Each language gets its tools.

| Tool | Checks | Pinned in |
|---|---|---|
| TypeScript's checker (`tsc -p .lint/tsconfig.json`) | `src`, `tests`, `scripts`, `bin`, `nightscout/*.mjs` and the lint scripts: strict mode plus unused locals, missing returns, switch fallthrough, missing `override`, unreachable code, unused labels. `tests` were not type checked before. JavaScript files are checked too, but only for names that do not resolve, imports that do not resolve, and duplicate declarations | `.lint/package-lock.json`, options in `.lint/tsconfig.json` |
| ESLint with typescript-eslint | Bugs: duplicate keys, unreachable code, self assignment, bad regular expressions, unsafe negation, and with types floating or misused promises, `await` on a non promise, throwing a non error, unbound methods. Run with `--no-inline-config`, so a comment cannot turn a rule off. `nightscout/compat/*.cjs` run inside the upstream Nightscout runtime, so ESLint reads them without types | `.lint/package-lock.json`, rules in `.lint/eslint.config.mjs` |
| Ruff | Python bugs: undefined names, unused imports, bad escapes, dead conditions, Python 3.9 syntax. Run with `--ignore-noqa` | `.cursor/install-lint.sh` (version and checksum), rules in `.lint/ruff.toml` |
| Pyright | Python types: wrong calls, unknown module attributes, Python 3.10 features on the Mini's Python 3.9 | `.lint/package-lock.json`, rules in `pyrightconfig.json` |
| Import check | No file outside `tests` loads a test or fixture, a worktree, another repository, or a relative path that leaves the repository | `.security/lint.py` (Python syntax tree) and `.lint/ts-reader.mjs` (TypeScript syntax tree) |
| Suppression check | No comment turns a checker off: `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `eslint-disable`, `# pyright:`, `# type: ignore` | `.security/lint.py` |
| Comment ban | No new code comment in TypeScript, JavaScript, Python or shell, and no new Python docstring nothing reads ([below](#the-comment-ban)) | `.security/lint.py`; shell is read by shfmt, pinned in `.cursor/install-lint.sh` |
| ShellCheck | Shell scripts, already in the gate with no findings allowed | `.cursor/install-shellcheck.sh` (unchanged) |

`python3 .security/lint.py gate` is the gate's step "Types and strict lint", run right after `npm ci` and before `npm test`, because the type checker reads the real dependencies. It takes about 3 to 4 seconds on the Mac mini. The gate's first line records each tool's pinned version. `.githooks/pre-commit` runs `python3 .security/lint.py staged` on the staged text with ESLint (the rules that need no types), Ruff, Pyright, and the import, suppression and comment checks. `tsc` and the type aware ESLint rules need the whole tree, so they run in the gate only.

Install or update the tools with `bash .cursor/install-lint.sh`. They live in `~/.local/share/repo-lint/diabetes-data-mcp`, not in `~/.local/bin`, so this repository's pins can never replace another repository's `tsc`, `eslint` or `ruff`. `lint.py` finds them by path, never through `PATH`. The lint tools have their own `.lint/package.json` and lockfile, so the product's dependencies and published package are unchanged, and `.security/scan.py` audits them at the high threshold including development dependencies. `.lint/node_modules` is a link to the install that `lint.py` makes itself and Git ignores.

## The ratchet

Each finding is keyed by its tool, rule, file and a hash of its line's text, so moving code does not change it. `.lint/baseline.json` holds no findings: the 608 it held at the start (605 comment lines, one TypeScript type error, one Pyright finding and one suppression comment) are all fixed ([below](#comments-cleaned-out)). It only shrinks, so it stays empty:

- A change fails on a finding absent from both the baseline and the PR base, including indirect breakage in untouched files. Editing a finding's line changes its key. A renamed file keeps its old findings.
- A finding already on the PR base is a warning, even in a touched file: a merge resolution must not be blamed for main's existing finding. Counts matter: one existing occurrence does not excuse a second.
- A baseline that gains an entry fails. The one way in is a new check's first entries: `python3 .security/lint.py baseline` writes them only for a tool the baseline's `tools` list does not hold yet. When code is fixed the gate warns that entries are stale; `python3 .security/lint.py prune` drops them and never adds one.
- With no PR base (the `deploy` run), findings outside the baseline are warnings. The PR gate passes the base itself: the merge base of `origin/main` and the head, as `LOCAL_GATE_BASE`.
- A change to a lint config, to `.lint/ts-reader.mjs`, or to the kept error codes and filters in `lint.py` needs `.lint/policy-review.json` with the exact `before` and `after` fingerprints (`policy_digest(base)` and `policy_digest()` in `lint.py`) and a specific reason of at least 40 characters. This note never replaces the fresh PR reviewer.

`python3 .security/lint.py counts` prints the findings per tool; `counts --folders` prints comment lines per folder and the biggest files.

## Counts before and after

Measured on main at 8dad034 with each tool first run at its widest setting, then after the rules below were chosen.

| Tool | Widest run over today's code | After choosing rules (held by the baseline) |
|---|---|---|
| tsc | 307 errors with the four extra strictness flags | 1 |
| ESLint | 3,601 with every core rule and typescript-eslint strict and stylistic type checked sets | 0 |
| Ruff | 2,879 with every rule | 0 |
| Pyright | 112 in standard mode, 1,466 in strict mode | 1 |
| Imports | no rule widened | 0 |
| Suppressions | one | 1 |
| Comments | not run before | 605 |
| **All** | | **608** (0 after the comment cleanup) |

## Rules dropped, and why

False alarms must be zero, so a check that flags correct code is tuned or dropped. Each tool was first run with its widest rule set and every rule's hits were read.

**tsc** (307 errors with every strictness flag, in `src`, `tests`, `scripts`, `bin` and `nightscout/*.mjs`). Off because they flag correct code: `noUncheckedIndexedAccess` (61 hits, regular expression capture groups after a match and array reads after a length check), `exactOptionalPropertyTypes` (10 hits, one is the MCP SDK's own `sessionIdGenerator: undefined` for stateless mode), `noPropertyAccessFromIndexSignature` (248 hits, only a spelling of `process.env.NAME`), `noUnusedParameters` (6 hits, an unused callback argument is correct). On JavaScript files only the exact codes for unresolved names, unresolved imports and duplicate declarations count: `scripts/scan-package.js` passes the Buffer from `execFileSync` to `JSON.parse`, which works at runtime and fails the type check, and `scripts/mocha-retry-report.cjs` reads Mocha's context. `nightscout/compat/*.cjs` are not given to tsc: they are copied into the Nightscout runtime, where `apns2`, `xstate`, `brace-expansion` and Mocha's `describe` and `it` exist, so every unresolved import and name there would be a false alarm.

**ESLint** (3,601). The style rules are dropped wholesale: `no-magic-numbers` (520), `camelcase` (488, SQLite column names), `one-var`, `sort-keys`, `id-length`, `curly`, `func-style`, `no-ternary`, `require-unicode-regexp`, `sort-imports`, `max-statements`, `prefer-named-capture-group`, `no-undefined`, `no-console`, `capitalized-comments` and the rest of the style families. Bug rules dropped after reading their hits: `no-unused-vars` (9 hits, all parameter names inside function types such as `readFile?: (p: string) => string`; tsc's unused locals owns real unused names), `no-use-before-define` (2, function hoisting), `no-duplicate-imports` (2, a value and a type imported in two lines), `no-await-in-loop` (4, deliberate sequencing in the port retry and the push sender), `no-promise-executor-return` (6, `server.listen(0, host, resolve)`), `no-template-curly-in-string` (3, shell text in a test fixture), `no-useless-assignment` (2), `eqeqeq` and `no-eq-null` (`== null` on SQLite values is deliberate). From typescript-eslint: `no-unsafe-*` (about 300 hits, SQLite rows and `JSON.parse` are `any` and the code checks their shape), `no-base-to-string` (17, `String()` of a column that is a string or a number), `no-unnecessary-condition` (17, defensive `??` on rows cast with `as`), `no-confusing-void-expression` (13, arrow shorthand), `require-await` (6, async handlers the SDK requires), `no-deprecated` (3, the SDK's `Server` class is used deliberately), `no-unnecessary-type-assertion` (4), `restrict-template-expressions` (56), `use-unknown-in-catch-callback-variable` (6), `no-explicit-any` (22, in tests), `prefer-nullish-coalescing`. The kept set has no hits in today's code, and `tests/lint-gate.test.ts` confirms the kept families fire on a floating promise, a duplicate key and an unused local.

**Ruff** (2,879 with every rule): the Toolbox's selection is kept as is, with no hit in today's code. Dropped because they flag correct code: quotes (1,511), `unittest` assertion style (203), annotations, docstrings, `print` (60), exception message style, bandit's `S` rules (Semgrep owns security), `B023` (20, closures defined in a test loop and used inside the same iteration), `PLW1510` (27, every `subprocess.run` here checks the exit code itself), `RUF005`, `EXE001` (scripts run as `python3 file`), `RUF100` (3 unused `# noqa: E402`, and the comment ban owns that comment), `PLW2901`, `DTZ007` and `DTZ011` (4 and 1: `strptime(...).date()` reads a calendar date, no clock is involved), and the refactor and convention families.

**Pyright** (112 in standard mode, 1,466 in strict mode). Off: `reportMissingImports` (48) and `reportMissingModuleSource` (8), since the upstream tconnectsync packages are installed only in the separate tconnect runtime and sibling scripts are loaded by path; `reportOptionalMemberAccess` (21) and `reportArgumentType` (10), all `spec.loader.exec_module` after `spec_from_file_location` and similar; `reportFunctionMemberAccess` (2, the `_diabetes_combo` and `__wrapped__` marks set on a function on purpose); `reportReturnType` (1, `load_nightscout_auth` returns a secret that the `missing` list above it proved is set); `reportAssignmentType` (1, `warn = warning` inside a `LoggerAdapter` subclass). Also off, with only two hits when on (both in `lint.py` itself, both correct code): `reportOptionalSubscript`, `reportOptionalOperand`, `reportOptionalIterable`, `reportOptionalCall`, `reportOptionalContextManager` and `reportPossiblyUnboundVariable` (flow the checker cannot follow), `reportIndexIssue` and `reportOperatorIssue` (a mixed dict literal is guessed as a union), `reportIncompatibleMethodOverride` and `reportIncompatibleVariableOverride` (a `*args` override), `reportUnusedExpression` (a statement that checks keys exist) and `reportInvalidStringEscapeSequence` (Ruff's `W605` owns it). The remaining family is kept only in part, as the Toolbox does: module attribute errors, wrong call arguments and Python 3.10 features. Of its 21 hits, 8 are `tconnectsync.parse_args` and `tconnectsync.secret`: this repository's `tconnectsync/` folder shadows the upstream package, which the checker cannot see, so any attribute of module `tconnectsync` is skipped (`PYRIGHT_UNREAD_MODULES` in `lint.py`). The 12 other hits are `unknown import symbol` and `Cannot assign` messages the filter already drops, and one was held and is now fixed ([below](#comments-cleaned-out)). Strict mode reports over a thousand unknown types because the code has no annotations. Pyright skips folders that start with a dot, which hides `.security`, so `lint.py` reads those files through a copy with the dot renamed and fails if Pyright analyzes fewer files than it was given.

## The comment ban

**What fails.** Each line of a new comment is one finding, `comments no-comment`: `//` and `/* */` (including JSDoc) in TypeScript and JavaScript, `#` in Python and shell, whether on its own line or after code. A Python docstring nothing reads is `comments no-docstring`, per line. The ratchet applies, so editing a line that holds an old comment makes it new: remove the comment while you are there.

**How it reads code, so text is never a false alarm.** TypeScript and JavaScript through typescript-estree (the parser behind ESLint), Python through `tokenize` and `ast`, shell through shfmt's bash parser. Strings, template strings, regular expressions, heredocs and `$#` are never comments. A file the parser cannot read fails as `comments unreadable-script` or `unreadable-shell`. Only `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.py`, `.sh` and `.bash` files are read, plus files with no suffix whose first line is a Python, sh, bash, dash or ksh shebang (`sync/diabetes-sqlite-sync`, `nightscout/diabetes-nightscout-server` and `tconnectsync/diabetes-tconnectsync` are shell). JSON, Markdown, YAML and plist are never read.

**Allowed.**
- A shebang on line 1.
- A comment line holding a link to an upstream issue, pull request, bug or RFC (GitHub, GitLab and Codeberg except Peter's own repositories, bugzilla hosts, crbug and the Chromium and Google trackers, rfc-editor.org and the IETF datatracker).
- License text: the file's leading comment block when a line holds `SPDX-License-Identifier:`, `Copyright`, `Licensed under`, `Permission is hereby granted` or `All rights reserved`.
- Comments a tool needs in order to work: Python's encoding line, ShellCheck's `shell=`, `source=` and `source-path=` directives, TypeScript's `/// <reference ... />` and `// @ts-check`, and Vitest's `@vitest-environment` docblock. Nothing that turns a checker off qualifies: those are the suppression check's findings, counted once.
- A Python docstring the program reads: a module docstring in a file that uses `__doc__`, and a function or class docstring read as `name.__doc__` (`.security/lint.py` prints its own).

## Comments cleaned out

Measured on main at 5d70833: 605 comment lines in 59 files (TypeScript 254, Python 236 of which 158 are docstring lines, shell 99, JavaScript 16). All of them are gone, in one change, and `.lint/baseline.json` holds no entries. No shebang, license text, upstream link or tool directive was among them, and no comment named Peter or a lesson ID.

No comment was deleted until its "why" lived where it belongs (D19):

| Kind | Where its reason went |
|---|---|
| A reason the code cannot show (why a call is shaped as it is, a failure that happened once) | [DESIGN-REASONS.md](DESIGN-REASONS.md), by file or function, and the name of the test that guards it |
| A guarded behavior | The test's title now holds the reason (the Nightscout installer, the profile mirror, the sync backfill, the persistent database setting) |
| History (a PR, a date, an incident) | Git holds it; the one that explains a guard (the history scans never read `--all`) is in DESIGN-REASONS.md and its probe `test_history_ignores_another_jobs_scratch_worktree` |
| Narration, dividers, a docstring nothing reads | Deleted |

The three non comment findings the baseline held were fixed in the same change: `tests/env-secrets.test.ts` now types its two environment cases as `Record<string, string>[]`, `tests/test_diagnostics.py` imports `MagicMock` by name, and the `# type: ignore[arg-type]` on `float(value)` in `sync/sync_from_nightscout.py` is gone (Pyright's `reportArgumentType` is off here, see above).

No behavior changed: the syntax tree of every changed file (TypeScript with typescript-estree, Python with `ast`, shell with `shfmt -mn`) is identical with comments and docstrings dropped and test titles blanked, apart from the two typing edits above.

## Changing a pin or a rule

Edit `.lint/package.json` and regenerate `.lint/package-lock.json`, or the Ruff and shfmt versions and checksums in `.cursor/install-lint.sh`, then run the installer and `python3 .security/lint.py counts`. A pin or rule that finds new findings in today's code needs those fixed in the same PR, since the baseline never grows. Compare the counts before and after a config edit and verify the intended diagnostic changed: an accepted but misspelled rule key can leave the wrong behavior in force.

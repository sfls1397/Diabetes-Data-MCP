import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const setup = [
  ".security/lint.py",
  ".cursor/install-lint.sh",
  ".lint/ruff.toml",
  ".lint/eslint.config.mjs",
  ".lint/tsconfig.json",
  ".lint/ts-reader.mjs",
  ".lint/package.json",
  ".lint/package-lock.json",
  "pyrightconfig.json",
  "package.json",
  "tsconfig.json",
];
const timeout = 180_000;
const created: string[] = [];

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const run = spawnSync(
    "git",
    ["-c", "user.email=lint@example.invalid", "-c", "user.name=Lint Test", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf8" },
  );
  expect(run.status, `git ${args.join(" ")}: ${run.stderr}`).toBe(0);
  return run.stdout.trim();
}

function write(dir: string, files: Record<string, string | null>): void {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    if (text === null) fs.rmSync(path.join(dir, name));
    else fs.writeFileSync(path.join(dir, name), text);
  }
}

function commit(dir: string, files: Record<string, string | null>, message: string): string {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

function lint(dir: string, mode: string, base?: string): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["LOCAL_GATE_BASE"];
  if (base) env["LOCAL_GATE_BASE"] = base;
  const run = spawnSync("python3", [".security/lint.py", mode], { cwd: dir, env, encoding: "utf8" });
  return { status: run.status, out: run.stdout + run.stderr };
}

const legacy = {
  "src/index.ts": "export const answer = 42;\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n",
  "src/old.ts": "export const kept = 1; // an old comment\n",
  "tests/helper.ts": "export const helper = 1;\n",
  "security/tool.py": "def run():\n    return 1\n",
  "bin/tool.sh": "#!/bin/sh\necho ok\n",
};

function repo(): { dir: string; base: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-gate-"));
  created.push(dir);
  git(dir, "init", "-q", "-b", "main");
  for (const name of setup) write(dir, { [name]: fs.readFileSync(path.join(root, name), "utf8") });
  commit(dir, legacy, "base");
  const made = lint(dir, "baseline");
  expect(made.status, made.out).toBe(0);
  expect(made.out).toMatch(/Baseline written: 1 findings/);
  return { dir, base: commit(dir, {}, "baseline") };
}

function blocked(dir: string, base: string, files: Record<string, string | null>): string {
  commit(dir, files, "change");
  const run = lint(dir, "gate", base);
  expect(run.status, run.out).toBe(1);
  expect(run.out).toMatch(/Types and lint BLOCKED: 1 new finding/);
  return run.out;
}

describe("the lint step of the gate", () => {
  it("passes on today's code and holds its comment in the baseline", { timeout }, () => {
    const { dir, base } = repo();
    const run = lint(dir, "gate", base);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toMatch(/Types and lint PASS.*1 findings held by the baseline, none new/);
  });

  it("passes when a baselined comment line moves to another line", { timeout }, () => {
    const { dir, base } = repo();
    commit(dir, { "src/old.ts": "export const other = 2;\nexport const kept = 1; // an old comment\n" }, "move");
    const run = lint(dir, "gate", base);
    expect(run.status, run.out).toBe(0);
  });

  it("fails on a new comment", { timeout }, () => {
    const { dir, base } = repo();
    const out = blocked(dir, base, { "src/index.ts": "// explains the answer\nexport const answer = 42;\n" });
    expect(out).toContain("comments no-comment src/index.ts:1");
  });

  it("fails on a new trailing comment, a block comment and a JSDoc line", { timeout }, () => {
    const { dir, base } = repo();
    commit(dir, { "src/index.ts": "export const answer = 42; // trailing\n/* block */\n/**\n * doc\n */\nexport const b = 1;\n" }, "change");
    const run = lint(dir, "gate", base);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toMatch(/Types and lint BLOCKED: 5 new findings/);
  });

  it("does not read a comment marker inside a string, a template or a regular expression", { timeout }, () => {
    const { dir, base } = repo();
    const text = 'export const a = "// not one";\nexport const b = `/* nor */ ${a}`;\nexport const c = /\\/\\/x/;\n';
    commit(dir, { "src/index.ts": text }, "change");
    const run = lint(dir, "gate", base);
    expect(run.status, run.out).toBe(0);
  });

  it("allows a shebang, an upstream issue link and license text", { timeout }, () => {
    const { dir, base } = repo();
    commit(
      dir,
      {
        "src/cli.ts": "#!/usr/bin/env node\n// https://github.com/nodejs/node/issues/12345\nexport const cli = 1;\n",
        "src/licensed.ts": "// Copyright 2026 Someone\n// Licensed under the MIT license\nexport const licensed = 1;\n",
      },
      "change",
    );
    const run = lint(dir, "gate", base);
    expect(run.status, run.out).toBe(0);
  });

  it("fails on a new TypeScript type finding", { timeout }, () => {
    const { dir, base } = repo();
    const out = blocked(dir, base, { "src/index.ts": "export const answer: number = 'forty two';\n" });
    expect(out).toContain("tsc TS2322 src/index.ts:1");
  });

  it("fails on an unused local, which the type checker owns", { timeout }, () => {
    const { dir, base } = repo();
    const out = blocked(dir, base, { "src/index.ts": "export function f(): number {\n  const unused = 1;\n  return 2;\n}\n" });
    expect(out).toContain("tsc TS6133 src/index.ts:2");
  });

  it("fails on a floating promise through the type-aware ESLint rules", { timeout }, () => {
    const { dir, base } = repo();
    const out = blocked(dir, base, {
      "src/index.ts": "export async function f(): Promise<number> {\n  return 1;\n}\nexport function g(): void {\n  f();\n}\n",
    });
    expect(out).toContain("eslint @typescript-eslint/no-floating-promises src/index.ts:5");
  });

  it("fails on a duplicate object key", { timeout }, () => {
    const { dir, base } = repo();
    const run = (() => {
      commit(dir, { "src/index.ts": "export const o = { a: 1, a: 2 };\n" }, "change");
      return lint(dir, "gate", base);
    })();
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("eslint no-dupe-keys src/index.ts:1");
  });

  it("fails on a comment that turns a checker off, counted once as a suppression", { timeout }, () => {
    const { dir, base } = repo();
    const out = blocked(dir, base, { "src/index.ts": "// @ts-ignore\nexport const answer: number = 'x';\n" });
    expect(out).toContain("suppress inline-suppression src/index.ts:1");
  });

  it("fails when a source file loads a test or a file outside the repository", { timeout }, () => {
    const { dir, base } = repo();
    const run = (() => {
      commit(dir, { "src/index.ts": "export { helper } from '../tests/helper.js';\nexport { x } from '../../Other-Repo/x.js';\n" }, "change");
      return lint(dir, "gate", base);
    })();
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("imports no-test-or-fixture-import src/index.ts:1");
    expect(run.out).toContain("imports no-import-outside-repo src/index.ts:2");
  });

  it("fails on a new Python finding and on a new Python comment", { timeout }, () => {
    const { dir, base } = repo();
    commit(dir, { "security/tool.py": "import os\n\n\ndef run():\n    return 1  # note\n" }, "change");
    const run = lint(dir, "gate", base);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("ruff F401 security/tool.py:1");
    expect(run.out).toContain("comments no-comment security/tool.py:5");
  });

  it("fails on a new shell comment", { timeout }, () => {
    const { dir, base } = repo();
    const out = blocked(dir, base, { "bin/tool.sh": "#!/bin/sh\n# say ok\necho ok\n" });
    expect(out).toContain("comments no-comment bin/tool.sh:2");
  });

  it("fails when the baseline gains an entry", { timeout }, () => {
    const { dir, base } = repo();
    const baseline = JSON.parse(fs.readFileSync(path.join(dir, ".lint/baseline.json"), "utf8")) as { findings: Array<{ count: number }> };
    const first = baseline.findings[0];
    expect(first).toBeDefined();
    if (first) first.count += 1;
    commit(dir, { ".lint/baseline.json": JSON.stringify(baseline) }, "grow");
    const run = lint(dir, "gate", base);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("the baseline grew");
  });

  it("only warns, without a base, about a finding outside the baseline", { timeout }, () => {
    const { dir } = repo();
    commit(dir, { "src/index.ts": "// new\nexport const answer = 42;\n" }, "change");
    const run = lint(dir, "gate");
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain("is not in the baseline");
  });

  it("warns, and does not block, a finding main already has", { timeout }, () => {
    const { dir } = repo();
    const withComment = commit(dir, { "src/index.ts": "// on main already\nexport const answer = 42;\n" }, "main has it");
    commit(dir, { "bin/note.txt": "unrelated\n" }, "change");
    const run = lint(dir, "gate", withComment);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain("is new since the baseline but on main too");
  });

  it("refuses a lint rule change without an exact reviewer note", { timeout }, () => {
    const { dir, base } = repo();
    const eslint = fs.readFileSync(path.join(dir, ".lint/eslint.config.mjs"), "utf8");
    commit(dir, { ".lint/eslint.config.mjs": eslint.replace("'no-dupe-keys': 'error',", "'no-dupe-keys': 'off',") }, "weaken");
    const run = lint(dir, "gate", base);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("lint-policy-review");
  });
});

describe("the lint step of the commit hook", () => {
  it("fails on a staged new comment and passes on a clean staged file", { timeout }, () => {
    const { dir } = repo();
    write(dir, { "src/index.ts": "// staged\nexport const answer = 42;\n" });
    git(dir, "add", "src/index.ts");
    const bad = lint(dir, "staged");
    expect(bad.status, bad.out).toBe(1);
    expect(bad.out).toContain("comments no-comment src/index.ts:1");
    write(dir, { "src/index.ts": "export const answer = 43;\n" });
    git(dir, "add", "src/index.ts");
    const good = lint(dir, "staged");
    expect(good.status, good.out).toBe(0);
  });

  it("passes on a staged file whose only comment is in the baseline", { timeout }, () => {
    const { dir } = repo();
    write(dir, { "src/old.ts": "export const kept = 1; // an old comment\nexport const more = 2;\n" });
    git(dir, "add", "src/old.ts");
    const run = lint(dir, "staged");
    expect(run.status, run.out).toBe(0);
  });
});

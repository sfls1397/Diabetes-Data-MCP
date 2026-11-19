import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/*
 * Gate downloads used to hang about 650 s on a stalled GitHub path and then fail (curl 56). Both download sites now
 * abort a stalled transfer and retry a bounded number of times. The tconnectsync fetch() is cut out of install.sh and
 * run against a fake curl, so no network is used; the real stall behaviour was probed against a local server that
 * accepts and never answers (curl exit 28 and a git "Operation too slow" failure after the bounded attempts).
 */
const ROOT = path.resolve(__dirname, "..");
const INSTALL = fs.readFileSync(path.join(ROOT, "tconnectsync/install.sh"), "utf8");
const GATE = fs.readFileSync(path.join(ROOT, "scripts/nightscout-local-test.sh"), "utf8");
const FETCH_SOURCE = INSTALL.slice(INSTALL.indexOf("DOWNLOAD_ATTEMPTS="), INSTALL.indexOf("PYTHON=${DIABETES_TCONNECTSYNC_PYTHON"));
const BODY = "wheel bytes\n";
const SUM = createHash("sha256").update(BODY).digest("hex");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(curlScript: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "download-retry-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\necho "$@" >> "${dir}/curl.args"\n${curlScript}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "run.sh"), `set -eu\n${FETCH_SOURCE}\nfetch https://example.invalid/w.whl "${dir}/w.whl" ${SUM}\necho fetched\n`);
  return dir;
}

function run(dir: string, env: Record<string, string> = {}) {
  return spawnSync("sh", [path.join(dir, "run.sh")], {
    encoding: "utf8",
    env: { PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, HOME: dir, DIABETES_DOWNLOAD_RETRY_DELAY: "0", ...env }
  });
}

const calls = (dir: string) => (fs.existsSync(path.join(dir, "curl.args")) ? fs.readFileSync(path.join(dir, "curl.args"), "utf8").trim().split("\n") : []);
// A fake curl that fails (as a stalled transfer does, exit 28) until the Nth call, then writes the real bytes.
const flaky = (okOn: number, bytes = BODY) =>
  `n=$(wc -l < "${"$0"}.n" 2>/dev/null || echo 0); echo x >> "$0.n"; n=$((n + 1))\n` +
  `while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\n` +
  `[ "$n" -ge ${okOn} ] || exit 28\nprintf '%s' '${bytes.replace(/\n/g, "\\n")}' | sed 's/\\\\n//' > "$out"; printf '\\n' >> "$out"`;

describe("tconnectsync install.sh fetch()", () => {
  it("passes stall and connect timeouts to curl", () => {
    const dir = setup(flaky(1));
    expect(run(dir).status).toBe(0);
    expect(calls(dir)[0]).toMatch(/--connect-timeout 30 --speed-limit 1024 --speed-time 30/);
    expect(calls(dir)[0]).toMatch(/--proto =https --tlsv1\.2/);
  });
  it("retries a stalled download and installs the file once the checksum matches", () => {
    const dir = setup(flaky(3));
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(calls(dir)).toHaveLength(3);
    expect(fs.readFileSync(path.join(dir, "w.whl"), "utf8")).toBe(BODY);
    expect(fs.existsSync(path.join(dir, "w.whl.tmp"))).toBe(false);
  });
  it("stops after the bounded attempts when the download never completes", () => {
    const dir = setup(flaky(99));
    const result = run(dir, { DIABETES_DOWNLOAD_ATTEMPTS: "2" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/after 2 attempts/);
    expect(calls(dir)).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, "w.whl"))).toBe(false);
  });
  it("never accepts bytes that fail the checksum, however often they arrive", () => {
    const dir = setup(flaky(1, "tampered\n"));
    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(calls(dir)).toHaveLength(3);
    expect(fs.existsSync(path.join(dir, "w.whl"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "w.whl.tmp"))).toBe(false);
  });
  it("skips the download when the file already matches its checksum", () => {
    const dir = setup(flaky(1));
    fs.writeFileSync(path.join(dir, "w.whl"), BODY);
    expect(run(dir).status).toBe(0);
    expect(calls(dir)).toHaveLength(0);
  });
});

describe("scripts/nightscout-local-test.sh clone", () => {
  it("clones with a low-speed abort and a bounded retry from an empty directory", () => {
    expect(GATE).toMatch(/git -c http\.lowSpeedLimit=1024 -c http\.lowSpeedTime="\$STALL" clone/);
    expect(GATE).toMatch(/until git .* clone .*; do\n\s+rm -rf "\$\{WORK:\?\}\/nightscout"/);
    expect(GATE).toMatch(/\[ "\$attempt" -lt "\$ATTEMPTS" \] \|\| \{ echo "Nightscout clone failed after/);
  });
});

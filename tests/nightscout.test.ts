import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/*
 * Guards for the Mini-hosted Nightscout pieces (nightscout/ + the two
 * com.diabetes-nightscout.* LaunchAgents). Mongo must stay on loopback, no
 * secret may live in a plist, and the wrapper must refuse a non-loopback
 * MONGODB_URI before it touches Keychain.
 */
const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const MONGOD = "examples/com.diabetes-nightscout.mongod.plist";
const SERVER = "examples/com.diabetes-nightscout.server.plist";
const WRAPPER = path.join(ROOT, "nightscout/diabetes-nightscout-server");

function args(plist: string): string[] {
  const block = read(plist).match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  return [...(block?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

describe("nightscout LaunchAgents", () => {
  it("binds mongod to 127.0.0.1:27017 only", () => {
    const a = args(MONGOD);
    expect(a[a.indexOf("--bind_ip") + 1]).toBe("127.0.0.1");
    expect(a[a.indexOf("--port") + 1]).toBe("27017");
    expect(a).not.toContain("--bind_ip_all");
    expect(read(MONGOD)).not.toMatch(/0\.0\.0\.0/);
  });

  it("keeps secrets out of plists and the config example", () => {
    for (const f of [MONGOD, SERVER, "nightscout/config.env.example"]) {
      // A value would appear as a plist env key or a KEY= line; comments may name them.
      expect(read(f)).not.toMatch(/<key>(API_SECRET|BRIDGE_PASSWORD|BRIDGE_USER_NAME)<\/key>/);
      expect(read(f)).not.toMatch(/^\s*#?\s*(API_SECRET|BRIDGE_PASSWORD|BRIDGE_USER_NAME)=/m);
    }
  });

  it("runs the wrapper from the repo checkout through /bin/sh", () => {
    expect(args(SERVER)).toEqual(["/bin/sh", "REPLACE_REPO/nightscout/diabetes-nightscout-server"]);
  });
});

describe("nightscout wrapper", () => {
  it("refuses a non-loopback MONGODB_URI before reading Keychain", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dn-"));
    fs.mkdirSync(path.join(home, "runtime/nightscout"), { recursive: true });
    fs.writeFileSync(path.join(home, "runtime/nightscout/server.js"), "");
    fs.writeFileSync(path.join(home, "config.env"), "MONGODB_URI=mongodb://10.0.0.5:27017/Nightscout\n");
    const err = await run("/bin/sh", [WRAPPER], {
      env: { PATH: "/usr/bin:/bin", DIABETES_NIGHTSCOUT_HOME: home, NODE_BIN: process.execPath }
    }).catch((e) => e);
    expect(err.code).toBe(64);
    expect(err.stderr).toMatch(/loopback/);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses to start without the runtime", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dn-"));
    const err = await run("/bin/sh", [WRAPPER], {
      env: { PATH: "/usr/bin:/bin", DIABETES_NIGHTSCOUT_HOME: home, NODE_BIN: process.execPath }
    }).catch((e) => e);
    expect(err.code).toBe(1);
    expect(err.stderr).toMatch(/install-runtime/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("tconnectsync LaunchAgent", () => {
  const TCS = "examples/com.diabetes-tconnectsync.sync.plist";
  it("runs hourly at :35 from the repo wrapper, never at load", () => {
    const xml = read(TCS);
    expect(args(TCS)).toEqual(["/bin/sh", "REPLACE_REPO/tconnectsync/diabetes-tconnectsync"]);
    expect(xml).toMatch(/<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Minute<\/key>\s*<integer>35<\/integer>\s*<\/dict>/);
    expect(xml).not.toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it("keeps Tandem and Nightscout secrets out of the plist and wrapper", () => {
    for (const f of [TCS, "tconnectsync/diabetes-tconnectsync"]) {
      expect(read(f)).not.toMatch(/^\s*(export\s+)?(TCONNECT_PASSWORD|NS_SECRET)=["']?[^$"'\s(]/m);
    }
  });
});

/*
 * macOS Background Task Management (BTM) keys each LaunchAgent on the code
 * identity of ProgramArguments[0]. When that file is rewritten (every npm
 * reinstall rewrites the package), BTM records a new item and posts another
 * "App Background Activity: ... can run in the background" notice. A stable
 * system executable (/bin/sh, node) with the package script as an argument keeps
 * the same identity across reinstalls, so no notice.
 */
describe("LaunchAgent executables stay stable across reinstalls", () => {
  const plists = fs.readdirSync(path.join(ROOT, "examples")).filter((f) => f.endsWith(".plist"));

  it("never launches a file from the package or repo directly", () => {
    expect(plists.length).toBeGreaterThanOrEqual(5);
    for (const f of plists) {
      const exe = args(`examples/${f}`)[0];
      expect(exe, f).toBeTruthy();
      expect(exe.startsWith("REPLACE_REPO"), `${f} launches ${exe}`).toBe(false);
    }
  });
});

describe("install-launchagents.sh", () => {
  type Env = { home: string; bin: string; log: string; state: string };

  function fakeMini(): Env {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dn-la-"));
    const bin = path.join(home, "stub-bin");
    const state = path.join(home, "launchd-state");
    const log = path.join(home, "launchctl.log");
    fs.mkdirSync(bin);
    fs.mkdirSync(state);
    fs.mkdirSync(path.join(home, ".diabetes-data/nightscout/runtime/mongodb/bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".diabetes-data/nightscout/runtime/mongodb/bin/mongod"), "#!/bin/sh\n", { mode: 0o755 });
    // A stand-in launchctl: records every call, keeps "loaded" state as files.
    fs.writeFileSync(
      path.join(bin, "launchctl"),
      [
        "#!/bin/sh",
        'echo "$*" >> "$LC_LOG"',
        'case "$1" in',
        '  print) test -f "$LC_STATE/${2##*/}" ;;',
        '  bootout) rm -f "$LC_STATE/${2##*/}" ;;',
        '  bootstrap) b=${3##*/}; : > "$LC_STATE/${b%.plist}" ;;',
        "  kickstart) exit 0 ;;",
        "  *) exit 1 ;;",
        "esac",
        ""
      ].join("\n"),
      { mode: 0o755 }
    );
    return { home, bin, log, state };
  }

  async function install(e: Env, node: string, which: string) {
    fs.writeFileSync(e.log, "");
    await run("/bin/sh", [path.join(ROOT, "examples/install-launchagents.sh"), node, which], {
      env: { PATH: `${e.bin}:/usr/bin:/bin`, HOME: e.home, LC_LOG: e.log, LC_STATE: e.state }
    });
    return fs.readFileSync(e.log, "utf8").trim().split("\n").filter(Boolean);
  }

  it("waits for the old job to unload and retries bootstrap (no I/O-error race)", () => {
    const sh = read("examples/install-launchagents.sh");
    expect(sh).toMatch(/while launchctl print "gui\/\$\(id -u\)\/\$label"/);
    expect(sh).toMatch(/until launchctl bootstrap/);
  });

  it("leaves an unchanged plist byte-identical and untouched on reinstall, restarting in place", async () => {
    const e = fakeMini();
    const plist = path.join(e.home, "Library/LaunchAgents/com.diabetes-nightscout.server.plist");
    const first = await install(e, process.execPath, "nightscout");
    expect(first.filter((l) => l.startsWith("bootstrap"))).toHaveLength(2);
    const xml = fs.readFileSync(plist, "utf8");
    expect(xml).toContain("<string>/bin/sh</string>");
    expect(xml).toContain(`<string>${ROOT}/nightscout/diabetes-nightscout-server</string>`);
    const before = fs.statSync(plist);

    const second = await install(e, process.execPath, "nightscout");
    const after = fs.statSync(plist);
    expect(fs.readFileSync(plist, "utf8")).toBe(xml);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // No bootout/bootstrap: each bootstrap makes launchd rescan every agent with BTM.
    expect(second.some((l) => /^(bootout|bootstrap)/.test(l))).toBe(false);
    expect(second).toContain(`kickstart -k gui/${process.getuid?.()}/com.diabetes-nightscout.server`);
    expect(second).toContain(`kickstart -k gui/${process.getuid?.()}/com.diabetes-nightscout.mongod`);
    expect(fs.readdirSync(path.dirname(plist)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    fs.rmSync(e.home, { recursive: true, force: true });
  });

  it("does not fire a scheduled-only job early on an unchanged reinstall", async () => {
    const e = fakeMini();
    fs.mkdirSync(path.join(e.home, ".diabetes-data/tconnectsync/venv/bin"), { recursive: true });
    fs.writeFileSync(path.join(e.home, ".diabetes-data/tconnectsync/venv/bin/tconnectsync"), "#!/bin/sh\n", { mode: 0o755 });
    await install(e, process.execPath, "tconnectsync");
    const second = await install(e, process.execPath, "tconnectsync");
    expect(second.some((l) => /^(bootout|bootstrap|kickstart)/.test(l))).toBe(false);
    fs.rmSync(e.home, { recursive: true, force: true });
  });

  it("rewrites and reloads a plist whose content changed", async () => {
    const e = fakeMini();
    const plist = path.join(e.home, "Library/LaunchAgents/com.diabetes-nightscout.server.plist");
    await install(e, process.execPath, "nightscout");
    const otherNode = path.join(e.bin, "node");
    fs.symlinkSync(process.execPath, otherNode);
    const second = await install(e, otherNode, "nightscout");
    expect(fs.readFileSync(plist, "utf8")).toContain(`<string>${otherNode}</string>`);
    expect(second).toContain(`bootout gui/${process.getuid?.()}/com.diabetes-nightscout.server`);
    expect(second.some((l) => l.startsWith("bootstrap") && l.endsWith("com.diabetes-nightscout.server.plist"))).toBe(true);
    fs.rmSync(e.home, { recursive: true, force: true });
  });
});

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

  it("runs the wrapper from the repo checkout", () => {
    expect(args(SERVER)).toEqual(["REPLACE_REPO/nightscout/diabetes-nightscout-server"]);
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
    expect(args(TCS)).toEqual(["REPLACE_REPO/tconnectsync/diabetes-tconnectsync"]);
    expect(xml).toMatch(/<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Minute<\/key>\s*<integer>35<\/integer>\s*<\/dict>/);
    expect(xml).not.toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it("keeps Tandem and Nightscout secrets out of the plist and wrapper", () => {
    for (const f of [TCS, "tconnectsync/diabetes-tconnectsync"]) {
      expect(read(f)).not.toMatch(/^\s*(export\s+)?(TCONNECT_PASSWORD|NS_SECRET)=["']?[^$"'\s(]/m);
    }
  });
});

describe("install-launchagents.sh", () => {
  it("waits for the old job to unload and retries bootstrap (no I/O-error race)", () => {
    const sh = read("examples/install-launchagents.sh");
    expect(sh).toMatch(/while launchctl print "gui\/\$\(id -u\)\/\$label"/);
    expect(sh).toMatch(/until launchctl bootstrap/);
  });
});

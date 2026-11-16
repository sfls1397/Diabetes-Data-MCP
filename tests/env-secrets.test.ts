// Environment first, Keychain second (infisical-run puts each secret in the
// program environment). Fake values only; the Keychain is a PATH stub.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateHttpAuthToken, TOKEN_ENV } from "../src/mcp/httpAuth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAMES = ["API_SECRET", "BRIDGE_USER_NAME", "BRIDGE_PASSWORD", "TCONNECT_EMAIL", "TCONNECT_PASSWORD",
  "PUMP_SERIAL_NUMBER", "NS_SECRET"];

let dir: string;
let log: string;

/** A fake `security`: prints keychain-<service>/<account> unless that pair is listed as empty. */
function fakeKeychain(empty: string[] = []) {
  fs.writeFileSync(path.join(dir, "security"), `#!/bin/sh
s=; a=
while [ $# -gt 0 ]; do case "$1" in -s) s=$2; shift ;; -a) a=$2; shift ;; esac; shift; done
printf '%s/%s\\n' "$s" "$a" >> "${log}"
case " ${empty.join(" ")} " in *" $s/$a "*) exit 44 ;; esac
printf 'keychain-%s/%s\\n' "$s" "$a"
`);
  fs.chmodSync(path.join(dir, "security"), 0o700);
}

/** A probe program that prints each secret name the loader exported. */
function probe(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nfor n in ${NAMES.join(" ")}; do eval "v=\\\${$n-UNSET}"; printf '%s=%s\\n' "$n" "$v"; done\n`);
  fs.chmodSync(file, 0o700);
}

function parse(out: string): Record<string, string> {
  return Object.fromEntries(out.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1)];
  }));
}

function keychainReads(): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const n of NAMES) delete env[n];
  return { ...env, PATH: `${dir}:/usr/bin:/bin`, ...extra };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "diabetes-env-secrets-"));
  log = path.join(dir, "keychain-reads");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("nightscout/diabetes-nightscout-server", () => {
  function run(extra: Record<string, string>, config = "") {
    fs.mkdirSync(path.join(dir, "runtime/nightscout"), { recursive: true });
    fs.writeFileSync(path.join(dir, "runtime/nightscout/server.js"), "");
    fs.writeFileSync(path.join(dir, "nc"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(dir, "nc"), 0o700);
    fs.writeFileSync(path.join(dir, "config.env"), config);
    probe(path.join(dir, "node-probe"));
    return spawnSync("/bin/sh", [path.join(ROOT, "nightscout/diabetes-nightscout-server")], {
      env: baseEnv({ NODE_BIN: path.join(dir, "node-probe"), DIABETES_NIGHTSCOUT_HOME: dir, ...extra }), encoding: "utf8"
    });
  }

  it("uses API_SECRET from the environment even when the Keychain item is empty", () => {
    fakeKeychain(["diabetes-sqlite/api-secret"]);
    const result = run({ API_SECRET: "env-fixture-api" });
    expect(result.status).toBe(0);
    expect(parse(result.stdout).API_SECRET).toBe("env-fixture-api");
    expect(keychainReads()).toEqual([]);
  });

  it("reads the Keychain as today when API_SECRET is unset or empty", () => {
    fakeKeychain();
    for (const extra of [{}, { API_SECRET: "" }]) {
      const result = run(extra);
      expect(result.status).toBe(0);
      expect(parse(result.stdout).API_SECRET).toBe("keychain-diabetes-sqlite/api-secret");
    }
    expect(keychainReads()).toEqual(["diabetes-sqlite/api-secret", "diabetes-sqlite/api-secret"]);
  });

  it("still exits 2 when neither the environment nor the Keychain has API_SECRET", () => {
    fakeKeychain(["diabetes-sqlite/api-secret"]);
    const result = run({});
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("API_SECRET=");
  });

  it("never takes a secret from config.env", () => {
    fakeKeychain();
    const result = run({}, "API_SECRET=config-fixture\nBRIDGE_ENABLE=1\nBRIDGE_USER_NAME=config-fixture\n");
    const seen = parse(result.stdout);
    expect(seen.API_SECRET).toBe("keychain-diabetes-sqlite/api-secret");
    expect(seen.BRIDGE_USER_NAME).toBe("keychain-diabetes-nightscout/dexcom-username");
  });

  it("takes each bridge credential from the environment first, the Keychain for the rest", () => {
    fakeKeychain(["diabetes-nightscout/dexcom-username"]);
    const result = run({ API_SECRET: "env-fixture-api", BRIDGE_USER_NAME: "env-fixture-user" }, "BRIDGE_ENABLE=1\n");
    expect(result.status).toBe(0);
    const seen = parse(result.stdout);
    expect(seen.BRIDGE_USER_NAME).toBe("env-fixture-user");
    expect(seen.BRIDGE_PASSWORD).toBe("keychain-diabetes-nightscout/dexcom-password");
    expect(keychainReads()).toEqual(["diabetes-nightscout/dexcom-password"]);
  });

  it("exits 2 with the bridge on and a bridge credential missing everywhere", () => {
    fakeKeychain(["diabetes-nightscout/dexcom-password"]);
    const result = run({ API_SECRET: "env-fixture-api", BRIDGE_USER_NAME: "env-fixture-user" }, "BRIDGE_ENABLE=1\n");
    expect(result.status).toBe(2);
  });

  it("keeps injected bridge credentials away from Nightscout while the bridge is off", () => {
    fakeKeychain();
    const result = run({ API_SECRET: "env-fixture-api", BRIDGE_USER_NAME: "env-fixture-user", BRIDGE_PASSWORD: "env-fixture-pass" });
    expect(result.status).toBe(0);
    const seen = parse(result.stdout);
    expect(seen.BRIDGE_USER_NAME).toBe("UNSET");
    expect(seen.BRIDGE_PASSWORD).toBe("UNSET");
    expect(keychainReads()).toEqual([]);
  });
});

describe("tconnectsync/diabetes-tconnectsync", () => {
  const TANDEM = { TCONNECT_EMAIL: "env-fixture-email", TCONNECT_PASSWORD: "env-fixture-pass",
    PUMP_SERIAL_NUMBER: "env-fixture-serial", NS_SECRET: "env-fixture-ns" };

  function run(extra: Record<string, string>) {
    fs.mkdirSync(path.join(dir, "venv/bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "venv/bin/tconnectsync"), "#!/bin/sh\nexit 99\n");
    fs.chmodSync(path.join(dir, "venv/bin/tconnectsync"), 0o700);
    probe(path.join(dir, "venv/bin/python"));
    return spawnSync("/bin/sh", [path.join(ROOT, "tconnectsync/diabetes-tconnectsync")], {
      env: baseEnv({ DIABETES_TCONNECTSYNC_HOME: dir, ...extra }), encoding: "utf8"
    });
  }

  it("uses every value from the environment even when the Keychain is empty", () => {
    fakeKeychain(["diabetes-tconnectsync/tconnect-email", "diabetes-tconnectsync/tconnect-password",
      "diabetes-tconnectsync/pump-serial-number", "diabetes-sqlite/api-secret"]);
    const result = run(TANDEM);
    expect(result.status).toBe(0);
    const seen = parse(result.stdout);
    for (const [name, value] of Object.entries(TANDEM)) expect(seen[name]).toBe(value);
    expect(keychainReads()).toEqual([]);
  });

  it("reads the Keychain as today for each value unset or empty", () => {
    fakeKeychain();
    const result = run({ TCONNECT_EMAIL: "env-fixture-email", TCONNECT_PASSWORD: "" });
    expect(result.status).toBe(0);
    const seen = parse(result.stdout);
    expect(seen.TCONNECT_EMAIL).toBe("env-fixture-email");
    expect(seen.TCONNECT_PASSWORD).toBe("keychain-diabetes-tconnectsync/tconnect-password");
    expect(seen.PUMP_SERIAL_NUMBER).toBe("keychain-diabetes-tconnectsync/pump-serial-number");
    expect(seen.NS_SECRET).toBe("keychain-diabetes-sqlite/api-secret");
    expect(keychainReads()).toEqual(["diabetes-tconnectsync/tconnect-password",
      "diabetes-tconnectsync/pump-serial-number", "diabetes-sqlite/api-secret"]);
  });

  it("still exits 2 when a value is missing everywhere", () => {
    fakeKeychain(["diabetes-tconnectsync/pump-serial-number"]);
    const result = run({});
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });
});

describe("MCP HTTP server token", () => {
  const exec = ((..._args: unknown[]) => { throw new Error("Keychain must not be read"); }) as never;

  it("uses DIABETES_DATA_MCP_TOKEN from the environment without touching the Keychain", () => {
    expect(TOKEN_ENV).toBe("DIABETES_DATA_MCP_TOKEN");
    const result = loadOrCreateHttpAuthToken({ env: { [TOKEN_ENV]: "env-fixture-token" }, execFileSync: exec, log: () => {} });
    expect(result).toEqual({ token: "env-fixture-token", generated: false });
  });

  it("reads the Keychain as today when the variable is unset or empty", () => {
    const calls: string[][] = [];
    const keychain = ((file: string, args: string[]) => { calls.push([file, ...args]); return Buffer.from("keychain-fixture-token\n"); }) as never;
    for (const env of [{}, { [TOKEN_ENV]: " " }]) {
      expect(loadOrCreateHttpAuthToken({ env, execFileSync: keychain, log: () => {} }))
        .toEqual({ token: "keychain-fixture-token", generated: false });
    }
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(0, 2)).toEqual(["/usr/bin/security", "find-generic-password"]);
  });
});

it("proves the sync prefers NIGHTSCOUT_URL and NIGHTSCOUT_API_SECRET, each on its own", () => {
  const out = execFileSync("python3", [path.join(ROOT, "tests/test_env_secrets.py")], { encoding: "utf8", stdio: "pipe" });
  expect(out).toBe("");
});

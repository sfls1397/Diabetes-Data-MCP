import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabaseForFixture, openDatabaseReadOnly } from "../src/db/open.js";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, verifyAuthHeader } from "../src/mcp/httpAuth.js";
import { resolveConfig } from "../src/config.js";
import { createFixture } from "./fixture.js";

describe("read-only open", () => {
  it("rejects writes against the fixture archive", () => {
    const { db } = createFixture();
    expect(() => db.exec(`INSERT INTO meta (key, value) VALUES ('x', 'y')`)).toThrow(/readonly/i);
    expect(() => db.exec(`DELETE FROM sgv`)).toThrow(/readonly/i);
  });

  it("refuses to create a missing archive", () => {
    const missing = path.join(os.tmpdir(), `diabetes-missing-${process.pid}.sqlite`);
    expect(() => openDatabaseReadOnly(missing)).toThrow(/not found/i);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("can build a fixture only through the test helper", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diabetes-write-"));
    const file = path.join(dir, "fixture.sqlite");
    const db = openDatabaseForFixture(file);
    db.exec(`CREATE TABLE meta (key TEXT)`);
    db.close();
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("bearer auth", () => {
  it("uses the locked Keychain names", () => {
    expect(KEYCHAIN_SERVICE).toBe("diabetes-data-mcp-http");
    expect(KEYCHAIN_ACCOUNT).toBe("http-auth-token");
  });

  it("accepts an exact bearer token and rejects everything else", () => {
    expect(verifyAuthHeader("Bearer secret-token", "secret-token")).toBe(true);
    expect(verifyAuthHeader("bearer secret-token", "secret-token")).toBe(true);
    expect(verifyAuthHeader("Bearer secret-token-x", "secret-token")).toBe(false);
    expect(verifyAuthHeader("Basic secret-token", "secret-token")).toBe(false);
    expect(verifyAuthHeader(undefined, "secret-token")).toBe(false);
  });
});

describe("config", () => {
  it("defaults to port 8424 and the Mini archive path, env overrides", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "diabetes-home-"));
    const defaults = resolveConfig({ env: { DIABETES_DATA_MCP_HOME: home, HOME: home }, warn: () => {} });
    expect(defaults.serverPort).toBe(8424);
    expect(defaults.serverHost).toBe("0.0.0.0");
    expect(defaults.dbPath).toBe(path.join(home, ".diabetes-data", "diabetes.sqlite"));
    const env = resolveConfig({
      env: { DIABETES_DATA_MCP_HOME: home, DIABETES_DATA_MCP_DB_PATH: "/tmp/archive.sqlite", DIABETES_DATA_MCP_SERVER_PORT: "9000" },
      warn: () => {}
    });
    expect(env.dbPath).toBe("/tmp/archive.sqlite");
    expect(env.serverPort).toBe(9000);
  });
});

// Persisted overrides survive package upgrades and take precedence over a new default.
describe("persistent local database setting", () => {
  it("uses the saved archive without re-entry, while env remains the explicit override", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "diabetes-local-config-"));
    const saved = path.join(home, "existing-archive.sqlite");
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ dbPath: saved }));
    const env = { HOME: home, DIABETES_DATA_MCP_HOME: home };
    expect(resolveConfig({ env }).dbPath).toBe(saved);
    expect(resolveConfig({ env: { ...env, DIABETES_DATA_MCP_DB_PATH: "/tmp/override.sqlite" } }).dbPath).toBe("/tmp/override.sqlite");
  });
});

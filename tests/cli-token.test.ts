import { afterEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  loadOrCreateHttpAuthToken: vi.fn(() => ({ token: "fixture-env-token", generated: false })),
  readKeychainSecret: vi.fn(() => "fixture-keychain-token")
}));

vi.mock("../src/mcp/httpAuth.js", () => ({
  ...auth, KEYCHAIN_SERVICE: "fixture-service", KEYCHAIN_ACCOUNT: "fixture-account"
}));
vi.mock("../src/config.js", () => ({ ensureAppDir: vi.fn(), resolveConfig: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it("http-token uses the same environment-first token resolver as serve", async () => {
  const original = process.argv;
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = ["node", "cli", "http-token"];
  try {
    await import("../src/cli.js");
    expect(auth.readKeychainSecret).not.toHaveBeenCalled();
    expect(auth.loadOrCreateHttpAuthToken).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith("fixture-env-token");
  } finally {
    process.argv = original;
  }
});

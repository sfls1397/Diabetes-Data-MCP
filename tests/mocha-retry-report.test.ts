import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * scripts/mocha-retry-report.cjs is the root hook plugin the Nightscout local test loads into upstream mocha. Mocha
 * calls afterEach with this.currentTest set and afterAll once at the end; these probes drive it the same way.
 */
const PLUGIN = path.resolve(__dirname, "../scripts/mocha-retry-report.cjs");

type FakeTest = { state?: string; currentRetry: () => number; fullTitle: () => string };

function fresh() {
  const load = createRequire(__filename);
  delete load.cache[PLUGIN];
  return load(PLUGIN).mochaHooks as { afterEach(this: { currentTest?: FakeTest }): void; afterAll(): void };
}

function test(state: string | undefined, retry: number, title: string): FakeTest {
  return { state, currentRetry: () => retry, fullTitle: () => title };
}

function printed(hooks: ReturnType<typeof fresh>, tests: Array<FakeTest | undefined>) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  for (const currentTest of tests) hooks.afterEach.call({ currentTest });
  hooks.afterAll();
  return log.mock.calls.map((call) => String(call[0]));
}

afterEach(() => vi.restoreAllMocks());

describe("mocha retry report", () => {
  it("names a test that passed only on its retry on a gate-warning line", () => {
    const lines = printed(fresh(), [
      test(undefined, 0, "carbs TEST-CARB-004"), // the failed first attempt: mocha has not set a state yet
      test("passed", 1, "carbs TEST-CARB-004"),
      test("passed", 0, "entries steady"),
    ]);
    expect(lines).toEqual([
      "gate-warning: Nightscout test passed only on retry: carbs TEST-CARB-004",
      "Nightscout tests passed only on retry: 1",
    ]);
  });

  it("stays quiet for first-attempt passes and for tests that fail every attempt", () => {
    const lines = printed(fresh(), [test("passed", 0, "a"), test("failed", 1, "b"), undefined]);
    expect(lines).toEqual(["Nightscout tests passed only on retry: 0"]);
  });

  it("keeps a multi-line title on one warning line", () => {
    const lines = printed(fresh(), [test("passed", 1, "suite\n  case")]);
    expect(lines[0]).toBe("gate-warning: Nightscout test passed only on retry: suite case");
  });
});

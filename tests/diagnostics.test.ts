import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("proves privacy-safe Python sync failures offline", () => {
  const result = execFileSync("python3", [fileURLToPath(new URL("./test_diagnostics.py", import.meta.url))], {
    encoding: "utf8", stdio: "pipe"
  });
  expect(result).not.toContain("fixture-private-response");
});

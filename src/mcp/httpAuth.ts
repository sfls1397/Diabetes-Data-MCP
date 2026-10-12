/**
 * Shared-secret auth for the HTTP transport, same scheme as Network-Tools
 * (and Apple Tools): a random bearer token generated once and kept in the
 * macOS Keychain — never in a config file, the repo, or logs after the
 * one-time print.
 */
import crypto from "node:crypto";
import { writeKeychainSecret } from "../keychainWrite.js";
import { execFileSync as defaultExecFileSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "diabetes-data-mcp-http";
export const KEYCHAIN_ACCOUNT = "http-auth-token";

type Exec = typeof defaultExecFileSync;

export function readKeychainSecret(service: string, account: string, exec: Exec = defaultExecFileSync): string | null {
  try {
    const out = exec("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const token = out.toString("utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function loadOrCreateHttpAuthToken(
  options: { log?: (m: string) => void; forceNew?: boolean; execFileSync?: Exec; randomBytes?: typeof crypto.randomBytes } = {}
): { token: string; generated: boolean } {
  const log = options.log || ((m: string) => console.error(m));
  const exec = options.execFileSync || defaultExecFileSync;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  if (!options.forceNew) {
    const existing = readKeychainSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, exec);
    if (existing) return { token: existing, generated: false };
  }
  const token = randomBytes(32).toString("hex");
  writeKeychainSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token, exec);
  log("Generated a new Diabetes Data MCP HTTP auth token and stored it in the Keychain.");
  log("Print it with: diabetes-data-mcp http-token");
  return { token, generated: true };
}

/** Constant-time check of `Authorization: Bearer <token>`. Never throws. */
export function verifyAuthHeader(headerValue: string | string[] | undefined, expectedToken: string): boolean {
  if (typeof headerValue !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

import { execFileSync } from "node:child_process";

/** The security utility parses one stdin line; credential bytes never enter process argv. */
export function writeKeychainSecret(service: string, account: string, value: string, exec: typeof execFileSync = execFileSync) {
  try {
    const quote = (text: string) => {
      if (!text || /[\r\n\0]/.test(text)) throw new Error("Invalid Keychain field");
      return '"' + text.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    };
    const command = "add-generic-password -U -s " + quote(service) + " -a " + quote(account) + " -w " + quote(value) + "\n";
    // Apple's interactive command buffer is 4096 bytes. Reject before any truncated write.
    if (Buffer.byteLength(command, "utf8") >= 4095) throw new Error("Keychain field too large");
    exec("/usr/bin/security", ["-i"], { input: command, stdio: ["pipe", "ignore", "ignore"], timeout: 15000 });
  } catch {
    throw new Error("Keychain write failed; credential values omitted.");
  }
}

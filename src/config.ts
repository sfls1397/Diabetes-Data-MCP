import fs from "node:fs";
import { DEFAULT_DB_PATH, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT, getConfigPath } from "./paths.js";

const KNOWN_CONFIG_KEYS = new Set(["dbPath", "serverHost", "serverPort"]);

function defaultWarn(message: string): void {
  console.error(message);
}

export interface LoadedConfigFile {
  data: Record<string, unknown>;
  missing: boolean;
  invalid: boolean;
  path: string;
}

export function loadConfigFile(
  options: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    readFile?: (p: string) => string;
    exists?: (p: string) => boolean;
    warn?: (msg: string) => void;
  } = {}
): LoadedConfigFile {
  const warn = options.warn || defaultWarn;
  const configPath = options.configPath || getConfigPath({ env: options.env });
  const exists = options.exists || ((p) => fs.existsSync(p));
  const readFile = options.readFile || ((p) => fs.readFileSync(p, "utf8"));

  if (!exists(configPath)) {
    return { data: {}, missing: true, invalid: false, path: configPath };
  }

  try {
    const raw = readFile(configPath);
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warn("Invalid config.json: expected a JSON object. Using defaults.");
      return { data: {}, missing: false, invalid: true, path: configPath };
    }
    const data = parsed as Record<string, unknown>;
    for (const key of Object.keys(data)) {
      if (!KNOWN_CONFIG_KEYS.has(key)) {
        warn(`Ignoring unknown config key: ${key}`);
      }
    }
    return { data, missing: false, invalid: false, path: configPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : "parse error";
    warn(`Invalid config.json (${message}). Using defaults.`);
    return { data: {}, missing: false, invalid: true, path: configPath };
  }
}

export interface ResolvedConfig {
  dbPath: string;
  serverHost: string;
  serverPort: number;
  configPath: string;
}

/**
 * Precedence (highest wins): env var > config.json > product default.
 * Default HTTP port is 8424 (ResMed 8420, Apple Tools HTTP 8421, Network Tools 8422, SimpleFIN 8423).
 * That value is the preferred starting port. `serve` binds the next free port above it when it is taken.
 */
export function resolveConfig(
  options: { env?: NodeJS.ProcessEnv; warn?: (msg: string) => void } = {}
): ResolvedConfig {
  const env = options.env || process.env;
  const warn = options.warn || defaultWarn;
  const file = loadConfigFile({ env, warn });
  const data = file.data;

  const dbPath =
    env.DIABETES_DATA_MCP_DB_PATH ||
    (typeof data.dbPath === "string" && data.dbPath.trim() ? data.dbPath : undefined) ||
    DEFAULT_DB_PATH;

  const serverHost =
    env.DIABETES_DATA_MCP_SERVER_HOST ||
    (typeof data.serverHost === "string" && data.serverHost.trim() ? data.serverHost : undefined) ||
    DEFAULT_SERVER_HOST;

  const rawPort = env.DIABETES_DATA_MCP_SERVER_PORT || data.serverPort;
  const parsedPort = typeof rawPort === "number" ? rawPort : Number(rawPort);
  const serverPort =
    Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : DEFAULT_SERVER_PORT;
  if (rawPort !== undefined && rawPort !== "" && serverPort === DEFAULT_SERVER_PORT && parsedPort !== DEFAULT_SERVER_PORT) {
    warn(`Invalid serverPort ${JSON.stringify(rawPort)}; using default ${DEFAULT_SERVER_PORT}`);
  }

  return { dbPath, serverHost, serverPort, configPath: file.path };
}

export function ensureAppDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

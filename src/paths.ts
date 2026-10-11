import os from "node:os";
import path from "node:path";

export const APP_DIR_NAME = ".diabetes-data-mcp";
export const CONFIG_FILE_NAME = "config.json";

/** Archive written by com.diabetes-sqlite.sync (Nightscout -> SQLite). Not this package's directory. */
export const DEFAULT_DB_PATH = path.join(os.homedir(), ".diabetes-data", "diabetes.sqlite");

export const DEFAULT_SERVER_HOST = "0.0.0.0";
export const DEFAULT_SERVER_PORT = 8424;

export interface PathOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}

/**
 * Config directory for this MCP (`config.json` only).
 * The diabetes SQLite archive lives elsewhere and is not created here.
 *
 * `DIABETES_DATA_MCP_HOME` is a test/dev override only.
 */
export function getAppDir(options: PathOptions = {}): string {
  const env = options.env || process.env;
  if (env.DIABETES_DATA_MCP_HOME && env.DIABETES_DATA_MCP_HOME.trim()) {
    return path.resolve(env.DIABETES_DATA_MCP_HOME);
  }
  const homedir = options.homedir || (() => os.homedir());
  const home = env.HOME || homedir();
  return path.join(home, APP_DIR_NAME);
}

export function getConfigPath(options: PathOptions = {}): string {
  return path.join(getAppDir(options), CONFIG_FILE_NAME);
}

/** Home-derived archive default; real overrides belong in the local config file. */
export function getDefaultDbPath(options: PathOptions = {}): string {
  const env = options.env || process.env;
  const home = env.HOME || (options.homedir || (() => os.homedir()))();
  return path.join(home, ".diabetes-data", "diabetes.sqlite");
}

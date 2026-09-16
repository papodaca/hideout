import { homedir } from "node:os";
import { join } from "node:path";

const APP = "hideout";

function home(): string {
  return homedir();
}

export function configDir(): string {
  const raw = (process.env.XDG_CONFIG_HOME ?? "").trim();
  const base = raw ? raw : join(home(), ".config");
  return join(base, APP);
}

export function dataDir(): string {
  const raw = (process.env.XDG_DATA_HOME ?? "").trim();
  const base = raw ? raw : join(home(), ".local", "share");
  return join(base, APP);
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function indexDir(): string {
  return join(dataDir(), "index");
}

export function pgliteDir(): string {
  return join(dataDir(), "pglite");
}

export function historyPath(): string {
  return join(dataDir(), "history");
}

export function setsPath(): string {
  return join(dataDir(), "sets.json");
}

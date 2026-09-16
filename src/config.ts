import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { configDir, configPath } from "./paths.js";

export const DEFAULT_CHAT_MODEL = "ornith-1.5:9b";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";
export const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_SYSTEM = `You answer only from the excerpts. If they do not contain the answer, say so.
After each claim, cite book, file, section, and page from the excerpt labels.
Be direct. No preamble. Do not invent scenes, stats, or facts that are not in the excerpts.`;
export const MAX_CHARS = 2800;
export const MIN_CHARS = 80;
export const OVERLAP_CHARS = 200;

export type Config = {
  sources: string[];
  chatModel: string;
  embedModel: string;
  chatUrl: string;
  embedUrl: string;
  chatHeaders: Record<string, string>;
  embedHeaders: Record<string, string>;
  systemPrompt: string;
  maxChars: number;
  minChars: number;
  overlapChars: number;
  banner: boolean;
};

export function defaultConfig(sources: string[] = []): Config {
  return {
    sources,
    chatModel: DEFAULT_CHAT_MODEL,
    embedModel: DEFAULT_EMBED_MODEL,
    chatUrl: DEFAULT_BASE_URL,
    embedUrl: DEFAULT_BASE_URL,
    chatHeaders: {},
    embedHeaders: {},
    systemPrompt: DEFAULT_SYSTEM,
    maxChars: MAX_CHARS,
    minChars: MIN_CHARS,
    overlapChars: OVERLAP_CHARS,
    banner: true,
  };
}

function sortedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(headers).sort()) out[key] = headers[key];
  return out;
}

export function dumpJson(cfg: Config): string {
  const data: Record<string, unknown> = {
    chat_model: cfg.chatModel,
    embed_model: cfg.embedModel,
    chat_url: cfg.chatUrl,
    embed_url: cfg.embedUrl,
    banner: cfg.banner,
    system_prompt: cfg.systemPrompt.trim(),
    sources: cfg.sources,
  };
  if (Object.keys(cfg.chatHeaders).length) data.chat_headers = sortedHeaders(cfg.chatHeaders);
  if (Object.keys(cfg.embedHeaders).length) data.embed_headers = sortedHeaders(cfg.embedHeaders);
  return JSON.stringify(data, null, 2) + "\n";
}

export function writeConfig(cfg: Config): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), dumpJson(cfg), "utf8");
}

export function ensureConfig(seedSources: string[] | null = null): string {
  const path = configPath();
  if (existsSync(path)) return path;
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(path, dumpJson(defaultConfig(seedSources ?? [])), "utf8");
  return path;
}

export function expandUser(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function asPathList(raw: unknown): string[] {
  if (raw == null) return [];
  const items = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.map(String) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let p = expandUser(item);
    try {
      p = resolve(p);
    } catch {
      p = isAbsolute(p) ? p : resolve(p);
    }
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function parseSourceText(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return asPathList(lines);
}

export function parseHeaderText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let name: string;
    let value: string;
    if (line.includes(":")) {
      const i = line.indexOf(":");
      name = line.slice(0, i);
      value = line.slice(i + 1);
    } else if (line.includes("=")) {
      const i = line.indexOf("=");
      name = line.slice(0, i);
      value = line.slice(i + 1);
    } else {
      continue;
    }
    name = name.trim();
    if (name) out[name] = value.trim();
  }
  return out;
}

export function expandEnv(text: string): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = process.env[name];
    if (value === undefined) throw new Error(name);
    return value;
  });
}

export function formatHeaderText(headers: Record<string, string>): string {
  return Object.keys(headers)
    .map((key) => `${key}: ${headers[key]}`)
    .join("\n");
}

function asBool(raw: unknown, fallback = true): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw == null) return fallback;
  const text = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

export function parseBoolText(text: string, fallback = true): boolean {
  return asBool(text.trim() || null, fallback);
}

function asHeaderMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(key).trim();
    if (name) out[name] = String(value);
  }
  return out;
}

export function loadConfig(path?: string): Config {
  const cfgPath = path ?? configPath();
  if (!existsSync(cfgPath)) return defaultConfig();
  const data = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  const chatUrl = String(data.chat_url || DEFAULT_BASE_URL);
  return {
    sources: asPathList(data.sources),
    chatModel: String(data.chat_model || DEFAULT_CHAT_MODEL),
    embedModel: String(data.embed_model || DEFAULT_EMBED_MODEL),
    chatUrl,
    embedUrl: String(data.embed_url || chatUrl),
    chatHeaders: asHeaderMap(data.chat_headers),
    embedHeaders: asHeaderMap(data.embed_headers),
    systemPrompt: String(data.system_prompt || DEFAULT_SYSTEM).trim(),
    maxChars: Number(data.max_chars || MAX_CHARS),
    minChars: Number(data.min_chars || MIN_CHARS),
    overlapChars: Number(data.overlap_chars || OVERLAP_CHARS),
    banner: asBool(data.banner, true),
  };
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

export function reloadConfig(): Config {
  cached = null;
  return getConfig();
}

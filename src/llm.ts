import { expandEnv, getConfig } from "./config.js";

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

export function apiBase(url: string): string {
  url = url.replace(/\/+$/, "");
  if (url.endsWith("/v1")) return url;
  return url + "/v1";
}

export function nativeApiBase(url: string): string {
  url = url.replace(/\/+$/, "");
  if (url.endsWith("/v1")) return url.slice(0, -"/v1".length).replace(/\/+$/, "");
  return url;
}

function canonicalModel(name: string): string {
  name = name.trim();
  return name.includes(":") ? name : `${name}:latest`;
}

export function modelInstalled(name: string, names: string[]): boolean {
  const want = canonicalModel(name);
  return names.some((have) => canonicalModel(have) === want);
}

function endpoint(base: string, path: string): string {
  return apiBase(base) + path;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const hdrs: Record<string, string> = { "Content-Type": "application/json" };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      try {
        hdrs[String(key)] = expandEnv(String(value));
      } catch (err) {
        const name = err instanceof Error ? err.message : String(err);
        throw new LlmError(`environment variable ${name} is not set`);
      }
    }
  }
  return hdrs;
}

async function httpMessage(resp: Response): Promise<string> {
  let body = "";
  try {
    body = (await resp.text()).trim();
  } catch {
    body = "";
  }
  if (!body) return resp.statusText || String(resp.status);
  try {
    const data = JSON.parse(body) as { error?: { message?: string } | string };
    const err = data.error;
    if (err && typeof err === "object" && err.message) return String(err.message);
    if (typeof err === "string") return err;
  } catch {
    return body.slice(0, 400);
  }
  return body.slice(0, 400);
}

async function request(
  url: string,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeout: number;
  },
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout);
  try {
    const resp = await fetch(url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      throw new LlmError(`${resp.status} ${await httpMessage(resp)} (${url})`);
    }
    return resp;
  } catch (err) {
    if (err instanceof LlmError) throw err;
    throw new LlmError(`API is not reachable at ${url}. Check chat_url / embed_url and retry.`);
  } finally {
    clearTimeout(timer);
  }
}

export async function listModels(opts?: {
  url?: string;
  headers?: Record<string, string>;
}): Promise<string[]> {
  const cfg = getConfig();
  const url = endpoint(opts?.url ?? cfg.chatUrl, "/models");
  try {
    const resp = await request(url, {
      method: "GET",
      headers: headers(opts?.headers ?? cfg.chatHeaders),
      timeout: 5000,
    });
    const data = (await resp.json()) as { data?: { id?: string }[] };
    const names: string[] = [];
    for (const item of data.data || []) {
      if (item && typeof item === "object" && item.id) names.push(String(item.id));
    }
    return [...new Set(names)].sort();
  } catch {
    return [];
  }
}

export async function listNativeModels(
  base: string,
  extra?: Record<string, string>,
): Promise<string[] | null> {
  const url = nativeApiBase(base).replace(/\/+$/, "") + "/api/tags";
  try {
    const resp = await request(url, {
      method: "GET",
      headers: headers(extra),
      timeout: 5000,
    });
    const data = (await resp.json()) as { models?: { name?: string }[] };
    if (!data || typeof data !== "object" || !("models" in data)) return null;
    const names: string[] = [];
    for (const item of data.models || []) {
      if (item && typeof item === "object" && item.name) names.push(String(item.name));
    }
    return names;
  } catch {
    return null;
  }
}

function neededModels(): [string, Record<string, string>, string][] {
  const cfg = getConfig();
  const seen = new Set<string>();
  const out: [string, Record<string, string>, string][] = [];
  for (const [url, hdrs, model] of [
    [cfg.chatUrl, cfg.chatHeaders, cfg.chatModel],
    [cfg.embedUrl, cfg.embedHeaders, cfg.embedModel],
  ] as const) {
    const name = model.trim();
    if (!name) continue;
    const key = `${nativeApiBase(url)}\0${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([url, hdrs, name]);
  }
  return out;
}

export async function modelsToPull(): Promise<[string, Record<string, string>, string][]> {
  const missing: [string, Record<string, string>, string][] = [];
  const cache = new Map<string, string[] | null>();
  for (const [url, hdrs, name] of neededModels()) {
    const base = nativeApiBase(url);
    if (!cache.has(base)) cache.set(base, await listNativeModels(url, hdrs));
    const installed = cache.get(base);
    if (installed == null) continue;
    if (!modelInstalled(name, installed)) missing.push([url, hdrs, name]);
  }
  return missing;
}

export async function pullModel(
  name: string,
  opts: {
    base: string;
    headers?: Record<string, string>;
    onStatus?: (msg: string) => void;
  },
): Promise<void> {
  const url = nativeApiBase(opts.base).replace(/\/+$/, "") + "/api/pull";
  const payload = { model: name, name, stream: true };
  const resp = await request(url, {
    method: "POST",
    headers: headers(opts.headers),
    body: JSON.stringify(payload),
    timeout: 3_600_000,
  });
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof event !== "object" || !event) continue;
      const err = event.error;
      if (err) throw new LlmError(`could not pull ${name}: ${err}`);
      const status = String(event.status || "").trim();
      if (!status) continue;
      const total = event.total;
      const doneBytes = event.completed;
      let msg: string;
      if (total) {
        const pct = Math.trunc((100 * Number(doneBytes || 0)) / Number(total));
        msg = `pulling ${name}: ${status} ${pct}%`;
      } else {
        msg = `pulling ${name}: ${status}`;
      }
      opts.onStatus?.(msg);
    }
  }
}

export async function ensureModels(
  onStatus?: (msg: string) => void,
  jobs?: [string, Record<string, string>, string][],
): Promise<void> {
  const list = jobs ?? (await modelsToPull());
  for (const [url, hdrs, name] of list) {
    onStatus?.(`pulling ${name}`);
    await pullModel(name, { base: url, headers: hdrs, onStatus });
  }
}

async function post(
  base: string,
  path: string,
  payload: unknown,
  extra: Record<string, string>,
  timeout = 120_000,
): Promise<Record<string, unknown>> {
  const url = endpoint(base, path);
  const resp = await request(url, {
    method: "POST",
    headers: headers(extra),
    body: JSON.stringify(payload),
    timeout,
  });
  return (await resp.json()) as Record<string, unknown>;
}

export async function embed(texts: string[], query = false): Promise<number[][]> {
  const cfg = getConfig();
  const prefix = query ? "search_query: " : "search_document: ";
  const payload = {
    model: cfg.embedModel,
    input: texts.map((t) => prefix + t),
  };
  const data = await post(cfg.embedUrl, "/embeddings", payload, cfg.embedHeaders, 180_000);
  const rows = ((data.data as unknown[]) || []).filter(
    (row): row is Record<string, unknown> => !!row && typeof row === "object",
  );
  rows.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  const vectors = rows
    .filter((row) => "embedding" in row)
    .map((row) => (row.embedding as number[]).map(Number));
  if (vectors.length !== texts.length) throw new LlmError(`embed failed: ${JSON.stringify(data)}`);
  return vectors;
}

function choiceText(event: Record<string, unknown>): string {
  const choices = (event.choices as unknown[]) || [];
  if (!choices.length || typeof choices[0] !== "object" || !choices[0]) return "";
  const choice = choices[0] as Record<string, unknown>;
  const delta =
    choice.delta && typeof choice.delta === "object"
      ? (choice.delta as Record<string, unknown>)
      : {};
  const message =
    choice.message && typeof choice.message === "object"
      ? (choice.message as Record<string, unknown>)
      : {};
  let content = delta.content;
  if (content == null) content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object") {
        parts.push(String((part as { text?: string }).text || ""));
      }
    }
    return parts.join("");
  }
  return "";
}

async function* iterSse(resp: Response): AsyncGenerator<string> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      if (line.startsWith("data:")) line = line.slice(5).trim();
      if (!line || line === "[DONE]") continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const piece = choiceText(event);
      if (piece) yield piece;
    }
  }
}

export async function* chat(
  messages: { role: string; content: string }[],
  stream = true,
): AsyncGenerator<string> {
  const cfg = getConfig();
  const payload = {
    model: cfg.chatModel,
    messages,
    stream,
    temperature: 0.2,
  };
  const url = endpoint(cfg.chatUrl, "/chat/completions");
  const resp = await request(url, {
    method: "POST",
    headers: headers(cfg.chatHeaders),
    body: JSON.stringify(payload),
    timeout: 300_000,
  });
  if (!stream) {
    const data = (await resp.json()) as Record<string, unknown>;
    yield choiceText(data);
    return;
  }
  yield* iterSse(resp);
}

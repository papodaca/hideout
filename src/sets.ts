import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceRoots } from "./chunk.js";
import { connect } from "./db.js";
import { dataDir, setsPath } from "./paths.js";

export type DocSet = {
  slug: string;
  title: string;
  n: number;
};

function headingFrom(readme: string): string | null {
  if (!existsSync(readme)) return null;
  for (const line of readFileSync(readme, "utf8").split(/\r?\n/)) {
    if (line.startsWith("# ")) {
      return line
        .slice(2)
        .trim()
        .replaceAll("\u2014", "-")
        .replaceAll("\u2013", "-");
    }
  }
  return null;
}

function titleFor(slug: string): string {
  const parts = slug.split("/");
  for (const root of sourceRoots()) {
    const heading = headingFrom(join(root, ...parts, "README.md"));
    if (heading) return heading;
    if (slug === root.split(/[/\\]/).pop()) {
      const rootHeading = headingFrom(join(root, "README.md"));
      if (rootHeading) return rootHeading;
    }
  }
  return slug.replaceAll("_", " ").replaceAll("/", " / ");
}

export async function listSets(): Promise<DocSet[]> {
  const pg = await connect();
  const rows = (
    await pg.query<{ book: string; n: number }>(
      "SELECT book, COUNT(*) AS n FROM chunks GROUP BY book ORDER BY book",
    )
  ).rows;
  return rows.map((r) => ({
    slug: r.book,
    title: titleFor(r.book),
    n: Number(r.n),
  }));
}

export function loadEnabled(available: DocSet[]): Set<string> {
  const slugs = new Set(available.map((s) => s.slug));
  const path = setsPath();
  if (!slugs.size) return new Set();
  if (!existsSync(path)) return new Set(slugs);
  let data: { enabled?: unknown };
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as { enabled?: unknown };
  } catch {
    return new Set(slugs);
  }
  const enabled = new Set(
    ((data.enabled as unknown[]) || []).map(String).filter((x) => slugs.has(x)),
  );
  return enabled.size ? enabled : new Set(slugs);
}

export function saveEnabled(enabled: Set<string>): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(
    setsPath(),
    JSON.stringify({ enabled: [...enabled].sort() }, null, 2) + "\n",
    "utf8",
  );
}

export function parseSetArgs(
  rest: string,
  available: DocSet[],
): [Set<string> | null, string | null] {
  const slugs = new Set(available.map((s) => s.slug));
  const parts = rest.replaceAll(",", " ").split(/\s+/).filter(Boolean);
  if (!parts.length) return [null, "usage: /sets slug [slug ...]  (or /sets all)"];
  if (parts.length === 1 && parts[0].toLowerCase() === "all") return [new Set(slugs), null];
  const unknown = parts.filter((p) => !slugs.has(p));
  if (unknown.length) {
    const known = [...slugs].sort().join(", ");
    return [null, `unknown set: ${unknown.join(", ")}\n  known: ${known}`];
  }
  return [new Set(parts), null];
}

export async function pickSets(
  available: DocSet[],
  enabled: Set<string>,
): Promise<Set<string> | null> {
  if (!available.length) return new Set();
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  return runPicker(available, enabled);
}

const ACCENT = "\x1b[1m\x1b[38;2;255;107;74m";
const MUTED = "\x1b[38;2;115;115;115m";
const TEXT = "\x1b[38;2;229;229;229m";
const BORDER = "\x1b[38;2;68;68;68m";
const RESET = "\x1b[0m";

type Key =
  | { type: "text"; data: string }
  | { type: "up" | "down" | "tab" | "s-tab" | "home" | "end" | "enter" | "save" | "cancel" | "esc" };

function runPicker(available: DocSet[], enabled: Set<string>): Promise<Set<string> | null> {
  const on = new Set(enabled);
  return new Promise((resolve) => {
    let focus = Math.max(0, available.findIndex((s) => on.has(s.slug)));
    let done = false;
    const wasRaw = process.stdin.isRaw;

    const finish = (result: Set<string> | null) => {
      if (done) return;
      done = true;
      process.stdin.off("data", onData);
      process.stdout.off("resize", draw);
      process.stdout.write("\x1b[?25h\x1b[?1049l");
      if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw));
      resolve(result);
    };

    const toggle = (i: number) => {
      const slug = available[i].slug;
      if (on.has(slug)) on.delete(slug);
      else on.add(slug);
    };

    const handle = (key: Key) => {
      if (key.type === "cancel" || key.type === "esc") {
        finish(null);
        return;
      }
      if (key.type === "save" || key.type === "enter") {
        if (on.size) finish(new Set(on));
        return;
      }
      if (key.type === "up" || key.type === "s-tab") {
        focus = (focus - 1 + available.length) % available.length;
        return;
      }
      if (key.type === "down" || key.type === "tab") {
        focus = (focus + 1) % available.length;
        return;
      }
      if (key.type === "home") {
        focus = 0;
        return;
      }
      if (key.type === "end") {
        focus = available.length - 1;
        return;
      }
      if (key.type !== "text") return;
      const ch = key.data;
      if (ch === " ") toggle(focus);
      else if (ch === "j") focus = (focus + 1) % available.length;
      else if (ch === "k") focus = (focus - 1 + available.length) % available.length;
      else if (ch === "a") {
        if (on.size === available.length) on.clear();
        else for (const s of available) on.add(s.slug);
      }
      else if (ch === "i") {
        for (const s of available) {
          if (on.has(s.slug)) on.delete(s.slug);
          else on.add(s.slug);
        }
      }
    };

    function draw(): void {
      if (done) return;
      const cols = Math.max(40, process.stdout.columns || 80);
      const rows = Math.max(8, process.stdout.rows || 24);
      const inner = cols - 4;
      const hint = on.size
        ? "space toggles. a all. i invert. enter saves. esc cancels."
        : "pick at least one set. space toggles. esc cancels.";
      const maxList = Math.max(1, rows - 5);
      const from = Math.max(0, Math.min(focus - maxList + 1, available.length - maxList));
      const visible = available.slice(from, from + maxList);

      const body: string[] = [MUTED + clip(hint, inner) + RESET, ""];
      let cursorRow = 2;
      visible.forEach((s, i) => {
        const idx = from + i;
        const mark = on.has(s.slug) ? "x" : " ";
        const line = `[${mark}]  ${s.slug}  ${s.title}  ${s.n}`;
        const color = idx === focus ? ACCENT : TEXT;
        if (idx === focus) cursorRow = body.length;
        body.push(color + clip(line, inner) + RESET);
      });

      const maxBody = Math.max(1, rows - 2);
      while (body.length < maxBody) body.push("");
      const top = `${BORDER}┌${RESET}${ACCENT} sets ${RESET}${BORDER}${"─".repeat(Math.max(0, inner - 6))}┐${RESET}`;
      const bot = `${BORDER}└${"─".repeat(inner)}┘${RESET}`;
      const frame = [top, ...body.slice(0, maxBody).map((line) => `${BORDER}│${RESET}${padVisible(line, inner)}${BORDER}│${RESET}`), bot];
      process.stdout.write(`\x1b[?25l\x1b[2J\x1b[H${frame.join("\n")}`);
      process.stdout.write(`\x1b[${cursorRow + 2};3H\x1b[?25h`);
    }

    function onData(buf: Buffer): void {
      if (done) return;
      for (const key of parseKeys(buf.toString("utf8"))) {
        handle(key);
        if (done) return;
      }
      draw();
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write("\x1b[?1049h");
    process.stdin.on("data", onData);
    process.stdout.on("resize", draw);
    draw();
  });
}

function clip(text: string, width: number): string {
  const chars = [...text];
  return chars.length <= width ? text : chars.slice(0, width).join("");
}

function visibleLen(text: string): number {
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

function padVisible(text: string, width: number): string {
  const n = visibleLen(text);
  if (n >= width) return text;
  return text + " ".repeat(width - n);
}

function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "\x1b") {
      if (chunk.startsWith("\x1b[Z", i)) {
        keys.push({ type: "s-tab" });
        i += 3;
        continue;
      }
      if (chunk.startsWith("\x1b[A", i) || chunk.startsWith("\x1bOA", i)) {
        keys.push({ type: "up" });
        i += 3;
        continue;
      }
      if (chunk.startsWith("\x1b[B", i) || chunk.startsWith("\x1bOB", i)) {
        keys.push({ type: "down" });
        i += 3;
        continue;
      }
      if (chunk.startsWith("\x1b[H", i) || chunk.startsWith("\x1b[1~", i)) {
        keys.push({ type: "home" });
        i += chunk.startsWith("\x1b[1~", i) ? 4 : 3;
        continue;
      }
      if (chunk.startsWith("\x1b[F", i) || chunk.startsWith("\x1b[4~", i)) {
        keys.push({ type: "end" });
        i += chunk.startsWith("\x1b[4~", i) ? 4 : 3;
        continue;
      }
      if (chunk.startsWith("\x1b[", i)) {
        let j = i + 2;
        while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j])) j += 1;
        i = j < chunk.length ? j + 1 : chunk.length;
        continue;
      }
      keys.push({ type: "esc" });
      i += 1;
      continue;
    }
    const code = chunk.charCodeAt(i);
    if (code === 3) {
      keys.push({ type: "cancel" });
      i += 1;
      continue;
    }
    if (code === 19) {
      keys.push({ type: "save" });
      i += 1;
      continue;
    }
    if (code === 9) {
      keys.push({ type: "tab" });
      i += 1;
      continue;
    }
    if (code === 13 || code === 10) {
      keys.push({ type: "enter" });
      i += 1;
      continue;
    }
    if (code === 1) {
      keys.push({ type: "home" });
      i += 1;
      continue;
    }
    if (code === 5) {
      keys.push({ type: "end" });
      i += 1;
      continue;
    }
    if (code < 32) {
      i += 1;
      continue;
    }
    const cp = chunk.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    keys.push({ type: "text", data: ch });
    i += ch.length;
  }
  return keys;
}

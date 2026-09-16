import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { getConfig } from "./config.js";

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const PAGE_RE = /^\*PDF page (\d+)(?: \(printed (\d+)\))?\*$/;
const SKIP_FILES = new Set(["README.md"]);

export type Chunk = {
  id: string;
  file: string;
  book: string;
  chapter: string;
  headings: string[];
  page: number | null;
  printed: number | null;
  text: string;
  sourceMtime: number;
};

export function embedText(chunk: Chunk): string {
  const path = chunk.headings.length
    ? [chunk.chapter, ...chunk.headings].join(" > ")
    : chunk.chapter;
  let page = chunk.page ? `PDF page ${chunk.page}` : "";
  if (chunk.printed != null) page += ` (printed ${chunk.printed})`;
  const header = [chunk.book, path, page].filter(Boolean).join("\n");
  return `${header}\n\n${chunk.text}`;
}

export function sourceRoots(): string[] {
  return getConfig().sources.filter((p) => {
    try {
      return existsSync(p) && statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md") && !SKIP_FILES.has(entry.name)) {
        out.push(path);
      }
    }
  };
  walk(root);
  return out;
}

export function markdownFiles(roots?: string[]): [string, string][] {
  const dirs = roots ?? sourceRoots();
  const out: [string, string][] = [];
  for (const root of dirs) {
    for (const path of walkMarkdown(root)) {
      out.push([path, root]);
    }
  }
  return out.sort((a, b) => {
    const rootCmp = a[1].localeCompare(b[1]);
    return rootCmp !== 0 ? rootCmp : a[0].localeCompare(b[0]);
  });
}

export function sourceHash(files?: [string, string][]): string {
  const items = files ?? markdownFiles();
  const h = createHash("sha256");
  for (const [path, root] of items) {
    const rel = relative(root, path);
    h.update(resolve(root));
    h.update(rel);
    h.update(readFileSync(path));
  }
  return h.digest("hex").slice(0, 16);
}

function asPosix(path: string): string {
  return path.split(sep).join("/");
}

function bookAndFile(path: string, root: string, prefix: boolean): [string, string] {
  const rel = asPosix(relative(root, path));
  const parts = rel.split("/");
  const book = parts.length > 1 ? parts[0] : basename(root);
  if (prefix) return [`${basename(root)}/${book}`, `${basename(root)}/${rel}`];
  return [book, rel];
}

function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replaceAll("ä", "a")
    .replaceAll("ö", "o")
    .replaceAll("å", "a")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80) || "section";
}

function splitText(text: string): string[] {
  const cfg = getConfig();
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let buf: string[] = [];
  let size = 0;
  for (const para of paras) {
    const extra = para.length + 2;
    if (buf.length && size + extra > cfg.maxChars) {
      out.push(buf.join("\n\n"));
      const overlap: string[] = [];
      let osize = 0;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (osize + buf[i].length > cfg.overlapChars) break;
        overlap.push(buf[i]);
        osize += buf[i].length;
      }
      buf = overlap.reverse();
      size = buf.reduce((n, x) => n + x.length + 2, 0);
    }
    buf.push(para);
    size += extra;
  }
  if (buf.length) out.push(buf.join("\n\n"));
  return out.length ? out : [text.slice(0, cfg.maxChars)];
}

function flush(
  chunks: Chunk[],
  file: string,
  root: string,
  chapter: string,
  headings: string[],
  page: number | null,
  printed: number | null,
  buf: string[],
  mtime: number,
  prefix: boolean,
): void {
  const cfg = getConfig();
  const text = buf.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < cfg.minChars) return;
  const parts = text.length > cfg.maxChars ? splitText(text) : [text];
  const base = chunks.length;
  const [book, rel] = bookAndFile(file, root, prefix);
  const rootKey = resolve(root);
  for (let i = 0; i < parts.length; i++) {
    const headingSlug = slug(headings.join("-") || chapter);
    chunks.push({
      id: `${rootKey}:${rel}:${headingSlug}:${base + i}`,
      file: rel,
      book,
      chapter,
      headings: [...headings],
      page,
      printed,
      text: parts[i],
      sourceMtime: mtime,
    });
  }
}

function headingStack(
  stack: [number, string][],
  level: number,
  title: string,
): [number, string][] {
  const next = stack.filter(([lvl]) => lvl < level);
  next.push([level, title.trim()]);
  return next;
}

export function chunkFile(path: string, root: string, prefix = false): Chunk[] {
  let chapter = basename(path, ".md");
  let headings: [number, string][] = [];
  let page: number | null = null;
  let printed: number | null = null;
  let chunkPage: number | null = page;
  let chunkPrinted: number | null = printed;
  let buf: string[] = [];
  const chunks: Chunk[] = [];
  const mtime = statSync(path).mtimeMs / 1000;

  const doFlush = () => {
    flush(
      chunks,
      path,
      root,
      chapter,
      headings.filter(([level]) => level !== 1).map(([, title]) => title),
      chunkPage,
      chunkPrinted,
      buf,
      mtime,
      prefix,
    );
    buf = [];
  };

  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const pageMatch = PAGE_RE.exec(line);
    if (pageMatch) {
      page = Number(pageMatch[1]);
      printed = pageMatch[2] ? Number(pageMatch[2]) : null;
      if (!buf.length) {
        chunkPage = page;
        chunkPrinted = printed;
      }
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      doFlush();
      const level = heading[1].length;
      const title = heading[2].trim();
      headings = headingStack(headings, level, title);
      if (level === 1) chapter = title;
      chunkPage = page;
      chunkPrinted = printed;
      continue;
    }
    if (line.trim()) buf.push(line);
    else if (buf.length) buf.push("");
  }
  doFlush();
  return chunks;
}

export function chunkAll(): Chunk[] {
  const files = markdownFiles();
  const roots = new Set(files.map(([, root]) => root));
  const prefix = roots.size > 1;
  const chunks: Chunk[] = [];
  for (const [path, root] of files) {
    chunks.push(...chunkFile(path, root, prefix));
  }
  return chunks;
}

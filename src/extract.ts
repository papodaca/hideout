import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expandUser } from "./config.js";

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

type Bookmark = {
  level: number;
  title: string;
  page: number;
};

type Line = {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
  md: string;
  size: number;
  font: string;
  kind: string;
  printed: number | null;
};

type FontLike = {
  getName?: () => string;
  name?: string;
  isBold?: () => boolean;
  isItalic?: () => boolean;
};

type OutlineItem = {
  title?: string;
  page?: number;
  uri?: string;
  down?: OutlineItem[];
};

type PageLike = {
  getBounds(): number[] | { x?: number; y?: number; w?: number; h?: number };
  toStructuredText(opts?: string): {
    walk(walker: Record<string, unknown>): void;
    destroy?: () => void;
  };
};

type DocLike = {
  countPages(): number;
  loadPage(n: number): PageLike;
  loadOutline(): OutlineItem[] | null;
  getMetaData(key: string): string | undefined | null;
  destroy?: () => void;
};

function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replaceAll("ä", "a")
    .replaceAll("ö", "o")
    .replaceAll("å", "a")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "section";
}

function normalize(text: string): string {
  return text
    .toUpperCase()
    .replaceAll("’", "'")
    .replaceAll("‘", "'")
    .replace(/[^A-Z0-9]+/g, "");
}

function cleanBookmarkTitle(title: string): string {
  title = title.replaceAll("\t", " ").replace(/\s+/g, " ").trim();
  if (title.endsWith("]") && !title.startsWith("[")) title = "[" + title;
  title = title.replace(/:(\S)/g, ": $1");
  return title;
}

function fontName(font: FontLike | string | undefined): string {
  if (!font) return "";
  if (typeof font === "string") return font;
  try {
    if (typeof font.getName === "function") return font.getName();
  } catch {
    // fall through
  }
  if (typeof font.name === "string") return font.name;
  return String(font);
}

function fontBold(font: FontLike | string | undefined): boolean {
  if (font && typeof font === "object" && typeof font.isBold === "function") {
    try {
      return font.isBold();
    } catch {
      // fall through
    }
  }
  return /bold/i.test(fontName(font));
}

function fontItalic(font: FontLike | string | undefined): boolean {
  if (font && typeof font === "object" && typeof font.isItalic === "function") {
    try {
      return font.isItalic();
    } catch {
      // fall through
    }
  }
  const name = fontName(font);
  return /italic|oblique/i.test(name) && !/bold|roman/i.test(name);
}

function asRect(b: unknown): [number, number, number, number] {
  if (Array.isArray(b) && b.length >= 4) {
    return [Number(b[0]), Number(b[1]), Number(b[2]), Number(b[3])];
  }
  if (b && typeof b === "object") {
    const o = b as { x?: number; y?: number; w?: number; h?: number };
    if (o.w != null) return [o.x ?? 0, o.y ?? 0, (o.x ?? 0) + o.w, (o.y ?? 0) + (o.h ?? 0)];
  }
  return [0, 0, 0, 0];
}

function dirXY(dir: unknown): [number, number] {
  if (Array.isArray(dir) && dir.length >= 2) return [Number(dir[0]), Number(dir[1])];
  if (dir && typeof dir === "object") {
    const o = dir as { x?: number; y?: number };
    return [o.x ?? 1, o.y ?? 0];
  }
  return [1, 0];
}

function quadBox(quad: unknown): [number, number, number, number] {
  if (Array.isArray(quad) && quad.length >= 8) {
    const xs = [Number(quad[0]), Number(quad[2]), Number(quad[4]), Number(quad[6])];
    const ys = [Number(quad[1]), Number(quad[3]), Number(quad[5]), Number(quad[7])];
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return asRect(quad);
}

function typicalSize(spans: { text: string; size: number }[]): number {
  const weights = new Map<number, number>();
  for (const span of spans) {
    const text = span.text.trim();
    if (text.length < 2) continue;
    const size = Math.round(span.size * 10) / 10;
    if (size >= 40) continue;
    weights.set(size, (weights.get(size) ?? 0) + text.length);
  }
  if (!weights.size) return 10.0;
  let best = 10.0;
  let bestW = -1;
  for (const [size, w] of weights) {
    if (w > bestW) {
      best = size;
      bestW = w;
    }
  }
  return best;
}

function classify(
  size: number,
  fonts: Set<string>,
  text: string,
  width: number,
  height: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  body: number,
  bold: boolean,
  italic: boolean,
): string {
  const stripped = text.trim();
  if (size >= 72) return "skip";
  if (/^\d{1,4}$/.test(stripped)) {
    const nearEdge = y0 < 56 || y1 > height - 50;
    const narrow = x1 - x0 < 48 && (x0 < 60 || x0 > width - 80);
    if (nearEdge || narrow) return "pagenum";
  }
  if ([...fonts].some((f) => f.includes("Dingbat")) && /^[■●▪•\s]+$/.test(stripped)) {
    return "bullet";
  }
  if (["■", "●", "▪", "•"].includes(stripped)) return "bullet";
  if (size >= Math.max(body * 2.1, 20)) return "h1";
  if (size >= Math.max(body * 1.4, 13)) return "h2";
  if (bold && size >= body * 1.02 && stripped.length < 90) {
    if (stripped.includes(":") && /:\s+[a-zA-Z]/.test(stripped)) return "body";
    return "h3";
  }
  if (italic) return "flavor";
  return "body";
}

function formatSpans(spans: { text: string; font: string }[]): string {
  const parts: string[] = [];
  for (const span of spans) {
    if (span.font.includes("Dingbat") || ["■", "●", "▪", "•"].includes(span.text.trim())) {
      continue;
    }
    parts.push(span.text);
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

type RawSpan = {
  text: string;
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

function collectPageLines(page: PageLike): {
  lines: {
    text: string;
    spans: RawSpan[];
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    dirX: number;
  }[];
} {
  const stext = page.toStructuredText("preserve-spans");
  const lines: {
    text: string;
    spans: RawSpan[];
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    dirX: number;
  }[] = [];
  let spans: RawSpan[] = [];
  let dirX = 1;
  let skip = false;

  stext.walk({
    beginLine: (bbox: unknown, _wmode: unknown, direction: unknown) => {
      const [dx] = dirXY(direction);
      dirX = dx;
      skip = Math.abs(dx) < 0.75;
      spans = [];
      void bbox;
    },
    onChar: (
      utf: string,
      _origin: unknown,
      font: FontLike,
      size: number,
      quad: unknown,
    ) => {
      if (skip) return;
      const [x0, y0, x1, y1] = quadBox(quad);
      const name = fontName(font);
      const last = spans[spans.length - 1];
      if (
        last &&
        last.font === name &&
        Math.abs(last.size - size) < 0.05 &&
        last.bold === fontBold(font) &&
        last.italic === fontItalic(font)
      ) {
        last.text += utf;
        last.x1 = Math.max(last.x1, x1);
        last.y0 = Math.min(last.y0, y0);
        last.y1 = Math.max(last.y1, y1);
        return;
      }
      spans.push({
        text: utf,
        font: name,
        size,
        bold: fontBold(font),
        italic: fontItalic(font),
        x0,
        y0,
        x1,
        y1,
      });
    },
    endLine: () => {
      if (skip || !spans.length) return;
      const text = spans.map((s) => s.text).join("");
      if (!text.trim()) return;
      lines.push({
        text,
        spans: [...spans],
        x0: Math.min(...spans.map((s) => s.x0)),
        y0: Math.min(...spans.map((s) => s.y0)),
        x1: Math.max(...spans.map((s) => s.x1)),
        y1: Math.max(...spans.map((s) => s.y1)),
        dirX,
      });
    },
  });
  stext.destroy?.();
  return { lines };
}

function iterRawLines(
  page: PageLike,
  pdfPage: number,
): [Line[], number | null] {
  const bounds = asRect(page.getBounds());
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];
  const collected = collectPageLines(page);
  const body = typicalSize(collected.lines.flatMap((ln) => ln.spans));
  let printed: number | null = null;
  const lines: Line[] = [];
  for (const raw of collected.lines) {
    const fonts = new Set(raw.spans.map((s) => s.font));
    const size = Math.max(...raw.spans.map((s) => s.size));
    const bold = raw.spans.every((s) => s.bold) || [...fonts].every((f) => /bold/i.test(f));
    const italic =
      raw.spans.every((s) => s.italic) ||
      ([...fonts].every((f) => /italic|oblique/i.test(f)) &&
        ![...fonts].some((f) => /bold|roman/i.test(f)));
    const kind = classify(
      size,
      fonts,
      raw.text,
      width,
      height,
      raw.x0,
      raw.x1,
      raw.y0,
      raw.y1,
      body,
      bold,
      italic,
    );
    if (kind === "pagenum") {
      if (raw.y0 < 56 || raw.y1 > height - 50) {
        const n = Number(raw.text.trim());
        if (Number.isFinite(n)) printed = n;
      }
      continue;
    }
    if (kind === "skip") continue;
    const md = formatSpans(raw.spans);
    if (!md && kind !== "bullet") continue;
    lines.push({
      page: pdfPage,
      x0: raw.x0,
      y0: raw.y0,
      x1: raw.x1,
      y1: raw.y1,
      text: raw.text.trim(),
      md,
      size,
      font: raw.spans[0]?.font ?? "",
      kind,
      printed,
    });
  }
  return [lines, printed];
}

function mergeSameRow(lines: Line[], tol = 3.5): Line[] {
  if (!lines.length) return [];
  const ordered = [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const rows: Line[][] = [[ordered[0]]];
  for (const ln of ordered.slice(1)) {
    const prev = rows[rows.length - 1];
    if (Math.abs(ln.y0 - median(prev.map((r) => r.y0))) <= tol) prev.push(ln);
    else rows.push([ln]);
  }
  const out: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0);
    const bullets = row.filter((ln) => ln.kind === "bullet");
    const rest = row.filter((ln) => ln.kind !== "bullet");
    if (!rest.length) continue;
    if (rest.length === 1 && !bullets.length) {
      out.push(rest[0]);
      continue;
    }
    const kinds = new Set(rest.map((ln) => ln.kind));
    const text = rest
      .map((ln) => ln.md)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    let kind: string;
    if (bullets.length) kind = "list";
    else if (kinds.has("h2") || kinds.has("h1") || kinds.has("h3")) {
      out.push(rest.find((ln) => ["h1", "h2", "h3"].includes(ln.kind))!);
      continue;
    } else kind = rest[0].kind;
    const first = rest[0];
    out.push({
      page: first.page,
      x0: row[0].x0,
      y0: Math.min(...row.map((ln) => ln.y0)),
      x1: row[row.length - 1].x1,
      y1: Math.max(...row.map((ln) => ln.y1)),
      text,
      md: text,
      size: Math.max(...rest.map((ln) => ln.size)),
      font: first.font,
      kind,
      printed: first.printed,
    });
  }
  return out;
}

function mergeWrappedKinds(lines: Line[]): Line[] {
  if (!lines.length) return [];
  const wrapKinds = new Set(["h1", "h2", "h3"]);
  const used = new Set<number>();
  const out: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    let ln = lines[i];
    if (wrapKinds.has(ln.kind)) {
      let text = ln.md;
      let y1 = ln.y1;
      const x0 = ln.x0;
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        if (used.has(j)) {
          j += 1;
          continue;
        }
        const close = nxt.page === ln.page && nxt.y0 - y1 < 12;
        const sameCol = Math.abs(nxt.x0 - x0) < 50;
        if (nxt.kind === ln.kind && close && sameCol) {
          text = (text + " " + nxt.md).replace(/\s+/g, " ").trim();
          y1 = nxt.y1;
          used.add(j);
          j += 1;
          continue;
        }
        break;
      }
      if (text !== ln.md) {
        ln = { ...ln, text, md: text, y1 };
      }
    }
    out.push(ln);
  }
  return out;
}

function twoColumnOrder(lines: Line[], pageWidth: number): Line[] {
  if (!lines.length) return [];
  const mid = pageWidth * 0.48;
  const left = lines.filter((ln) => ln.x0 < mid);
  const right = lines.filter((ln) => ln.x0 >= mid);
  if (!left.length || !right.length || left.length < 3 || right.length < 3) {
    return mergeWrappedKinds(mergeSameRow([...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)));
  }
  return mergeWrappedKinds(mergeSameRow(left).concat(mergeSameRow(right)));
}

function dehyphenate(prev: string, nxt: string): string {
  if (prev.endsWith("-") && /^[a-z]/.test(nxt)) return prev.slice(0, -1) + nxt;
  if (prev.endsWith("-") && /^[A-Z]/.test(nxt)) return prev + nxt;
  return prev + " " + nxt;
}

function joinParts(parts: string[]): string {
  let text = parts[0];
  for (const part of parts.slice(1)) text = dehyphenate(text, part);
  return text.replace(/[ \t]+/g, " ").trim();
}

function headingLevel(
  text: string,
  kind: string,
  bookmarks: Bookmark[],
): [number, string] {
  const n = normalize(text);
  for (const bookmark of bookmarks) {
    if (normalize(bookmark.title) === n) return [2, bookmark.title];
  }
  const title = text.replace(/\s+/g, " ").trim();
  if (kind === "h1") return [1, title];
  if (kind === "h2") return [2, title];
  return [3, title];
}

function isListStart(ln: Line): boolean {
  return ln.kind === "list" || /^\d+\.\s+\S/.test(ln.md);
}

function linesToMarkdown(
  lines: Line[],
  bookmarks: Bookmark[],
  chapterTitle = "",
): string {
  const chunks: string[] = [];
  let buf: string[] = [];
  let bufKind = "body";
  const chapterNorm = normalize(chapterTitle);
  let seenChapterTitle = false;

  const flush = () => {
    if (!buf.length) return;
    const text = joinParts(buf);
    if (bufKind === "flavor") chunks.push("> " + text);
    else if (bufKind === "list") chunks.push(`- ${text}`);
    else chunks.push(text);
    buf = [];
    bufKind = "body";
  };

  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.kind === "page") {
      flush();
      let marker = `*PDF page ${ln.page}`;
      if (ln.printed != null) marker += ` (printed ${ln.printed})`;
      marker += "*";
      chunks.push(marker);
      i += 1;
      continue;
    }
    if (["h1", "h2", "h3"].includes(ln.kind)) {
      flush();
      const [level, title] = headingLevel(ln.text, ln.kind, bookmarks);
      if (chapterNorm && normalize(title) === chapterNorm && !seenChapterTitle) {
        seenChapterTitle = true;
        i += 1;
        continue;
      }
      chunks.push(`${"#".repeat(level)} ${title}`);
      i += 1;
      continue;
    }
    if (isListStart(ln)) {
      flush();
      const parts = [ln.md.replace(/^[■●▪•]+\s*/, "")];
      const numbered = /^\d+\.\s/.test(ln.md);
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        if (["page", "h1", "h2", "h3"].includes(nxt.kind)) break;
        if (isListStart(nxt)) break;
        if (nxt.page === ln.page && nxt.y0 - lines[j - 1].y1 > 16) break;
        parts.push(nxt.md);
        j += 1;
      }
      const item = joinParts(parts);
      chunks.push(numbered ? item : `- ${item}`);
      i = j;
      continue;
    }
    const prev = i ? lines[i - 1] : null;
    let newPara = false;
    if (buf.length && prev && prev.kind !== "page") {
      const gap = ln.y0 - prev.y1;
      const lineH = Math.max(8.0, prev.y1 - prev.y0);
      if (ln.page !== prev.page) newPara = false;
      else if (
        ln.kind !== bufKind &&
        ![ln.kind, bufKind].every((k) => k === "body" || k === "flavor")
      ) {
        newPara = true;
      } else if (gap > lineH * 0.9) newPara = true;
    }
    if (newPara) flush();
    if (!buf.length) bufKind = ["flavor", "list"].includes(ln.kind) ? ln.kind : "body";
    buf.push(ln.md);
    i += 1;
  }
  flush();
  const text = chunks.filter((c) => c && c.trim()).join("\n\n");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function extractPageUnits(page: PageLike, pdfPage: number): [Line[], number | null] {
  const [raw, printed] = iterRawLines(page, pdfPage);
  for (const ln of raw) ln.printed = printed;
  const bounds = asRect(page.getBounds());
  return [twoColumnOrder(raw, bounds[2] - bounds[0]), printed];
}

function outlinePage(item: OutlineItem): number {
  if (typeof item.page === "number" && item.page >= 0) return item.page + 1;
  const m = String(item.uri || "").match(/[#?&]page=(\d+)/i);
  if (m) return Number(m[1]);
  return -1;
}

function flattenOutline(items: OutlineItem[] | null | undefined, level = 1): Bookmark[] {
  const out: Bookmark[] = [];
  if (!items) return out;
  for (const item of items) {
    const page = outlinePage(item);
    if (page >= 1) {
      out.push({
        level,
        title: cleanBookmarkTitle(String(item.title ?? "")),
        page,
      });
    }
    if (item.down?.length) out.push(...flattenOutline(item.down, level + 1));
  }
  return out;
}

function loadBookmarks(doc: DocLike): Bookmark[] {
  return flattenOutline(doc.loadOutline());
}

function pageMarker(page: number, printed: number | null): Line {
  return {
    page,
    x0: 0,
    y0: -1,
    x1: 0,
    y1: -1,
    text: "",
    md: "",
    size: 0,
    font: "",
    kind: "page",
    printed,
  };
}

function emitRange(
  doc: DocLike,
  start: number,
  end: number,
  bookmarks: Bookmark[],
  chapterTitle = "",
): string {
  const stream: Line[] = [];
  for (let p = start; p <= end; p++) {
    const page = doc.loadPage(p - 1);
    const [ordered, printed] = extractPageUnits(page, p);
    stream.push(pageMarker(p, printed));
    stream.push(...ordered);
  }
  let text = linesToMarkdown(stream, bookmarks, chapterTitle);
  text = text.replace(
    /(\w)-\n\n(\*PDF page [^*]+\*)\n\n([a-zåäö][^\n]*)/g,
    "$1$3\n\n$2",
  );
  return text.trim() + "\n";
}

function bookTitle(pdf: string, doc: DocLike): string {
  const meta = doc.getMetaData("info:Title") || "";
  if (String(meta).trim()) return String(meta).trim();
  return basename(pdf, ".pdf").replaceAll("_", " ").trim();
}

function chapterFilename(title: string, index: number): string {
  const cleaned = title.replace(/^\d+\.\s*/, "");
  return `${String(index).padStart(2, "0")}-${slug(cleaned)}.md`;
}

function writeReadme(
  title: string,
  source: string,
  files: [string, string][],
  split: string,
): string {
  const lines = [
    `# ${title}`,
    "",
    `Text extract of \`${basename(source)}\`. Images, maps, and art are omitted. ` +
      `Split by ${split}. Page markers use PDF page numbers; printed numbers ` +
      "are in parentheses when a footer had one.",
    "",
    "## Contents",
    "",
  ];
  for (const [label, fname] of files) {
    lines.push(`- [${label}](${fname})`);
  }
  lines.push("");
  return lines.join("\n");
}

function chapterRanges(
  bookmarks: Bookmark[],
  pageCount: number,
): [Bookmark, number, number][] {
  if (!bookmarks.length) return [];
  const minLevel = Math.min(...bookmarks.map((b) => b.level));
  const heads = bookmarks.filter((b) => b.level === minLevel);
  const ranges: [Bookmark, number, number][] = [];
  heads.forEach((bookmark, i) => {
    const start = Math.max(1, bookmark.page);
    let end = i + 1 < heads.length ? heads[i + 1].page - 1 : pageCount;
    if (end < start) end = start;
    ranges.push([bookmark, start, Math.min(end, pageCount)]);
  });
  return ranges;
}

export async function extractPdf(pdf: string, target: string): Promise<number> {
  let mupdf: { Document: { openDocument: (data: Buffer, magic?: string) => DocLike } };
  try {
    mupdf = (await import("mupdf")) as unknown as {
      Document: { openDocument: (data: Buffer, magic?: string) => DocLike };
    };
  } catch (err) {
    throw new ExtractError(`mupdf is required for extract: ${String(err)}`);
  }

  pdf = expandUser(pdf);
  target = expandUser(target);
  if (!existsSync(pdf)) throw new ExtractError(`not a file: ${pdf}`);
  mkdirSync(target, { recursive: true });

  const { readFileSync } = await import("node:fs");
  let doc: DocLike;
  try {
    doc = mupdf.Document.openDocument(readFileSync(pdf), "application/pdf");
  } catch (err) {
    throw new ExtractError(`could not open ${pdf}: ${String(err)}`);
  }
  try {
    const bookmarks = loadBookmarks(doc);
    const title = bookTitle(pdf, doc);
    const files: [string, string][] = [];
    const pageCount = doc.countPages();
    let split: string;
    if (bookmarks.length) {
      split = "PDF bookmarks";
      const ranges = chapterRanges(bookmarks, pageCount);
      const first = ranges.length ? ranges[0][1] : 1;
      if (first > 1) {
        const front = emitRange(doc, 1, first - 1, bookmarks, "Front matter");
        const fname = "00-front-matter.md";
        writeFileSync(join(target, fname), "# Front matter\n\n" + front, "utf8");
        files.push(["Front matter", fname]);
        console.log(`  ${fname}  PDF 1-${first - 1}  ${front.length.toLocaleString()} chars`);
      }
      ranges.forEach(([bookmark, start, end], idx) => {
        const fname = chapterFilename(bookmark.title, idx + 1);
        const body = emitRange(doc, start, end, bookmarks, bookmark.title);
        writeFileSync(join(target, fname), `# ${bookmark.title}\n\n` + body, "utf8");
        files.push([bookmark.title, fname]);
        console.log(`  ${fname}  PDF ${start}-${end}  ${body.length.toLocaleString()} chars`);
      });
    } else {
      split = "page";
      const width = Math.max(3, String(pageCount).length);
      console.log("no bookmark outline; writing one file per page");
      for (let p = 1; p <= pageCount; p++) {
        const fname = `${String(p).padStart(width, "0")}.md`;
        const body = emitRange(doc, p, p, [], `Page ${p}`);
        writeFileSync(join(target, fname), `# Page ${p}\n\n` + body, "utf8");
        files.push([`Page ${p}`, fname]);
        console.log(`  ${fname}  PDF ${p}  ${body.length.toLocaleString()} chars`);
      }
    }
    writeFileSync(join(target, "README.md"), writeReadme(title, pdf, files, split), "utf8");
    console.log(`  README.md  ${files.length} files, ${pageCount} PDF pages`);
    console.log(`wrote ${target}`);
    return 0;
  } finally {
    doc.destroy?.();
  }
}

import { existsSync } from "node:fs";
import * as readline from "node:readline";
import ora from "ora";
import pc from "picocolors";
import { promptMessages } from "./ask.js";
import { getConfig, reloadConfig, writeConfig } from "./config.js";
import { editConfig } from "./config-ui.js";
import {
  appendPromptHistory,
  closeDb,
  HISTORY_LOAD,
  loadPromptHistory,
} from "./db.js";
import { HideoutError } from "./errors.js";
import { buildIndex, needsRebuild } from "./index.js";
import { apiBase, chat, ensureModels, LlmError, modelsToPull } from "./llm.js";
import { configPath } from "./paths.js";
import { type Hit, rrf } from "./search.js";
import {
  type DocSet,
  listSets,
  loadEnabled,
  parseSetArgs,
  pickSets,
  saveEnabled,
} from "./sets.js";

const BANNER = `██╗  ██╗██╗██████╗ ███████╗ ██████╗ ██╗   ██╗████████╗
██║  ██║██║██╔══██╗██╔════╝██╔═══██╗██║   ██║╚══██╔══╝
███████║██║██║  ██║█████╗  ██║   ██║██║   ██║   ██║   
██╔══██║██║██║  ██║██╔══╝  ██║   ██║██║   ██║   ██║   
██║  ██║██║██████╔╝███████╗╚██████╔╝╚██████╔╝   ██║   
╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝ ╚═════╝  ╚═════╝    ╚═╝   `;

const HELP = `
  /ask <q>     retrieve, then answer (this is the default; a bare line is an ask)
  /clear       clear the screen
  /config      edit model, API urls, headers, and sources
  /help        this list
  /k <n>       number of hits (current session)
  /quit        leave
  /search <q>  print matching excerpts, no model
  /sets        pick which document sets are on (alias /books)
  /sets <ids>  enable those slugs, or /sets all

  ctrl+c cancels the current line. ctrl+d leaves.
`;

const SLASH: [string, string][] = [
  ["/ask", "answer with the local model (default)"],
  ["/clear", "clear the screen"],
  ["/config", "edit model, urls, headers, sources"],
  ["/help", "show commands"],
  ["/k", "set number of hits, e.g. /k 8"],
  ["/quit", "leave"],
  ["/search", "print matching excerpts"],
  ["/sets", "enable or disable document sets"],
  ["/books", "same as /sets"],
];

function accent(text: string): string {
  return `\x1b[1m\x1b[38;2;255;107;74m${text}\x1b[0m`;
}

function muted(text: string): string {
  return `\x1b[38;2;115;115;115m${text}\x1b[0m`;
}

type Toolbar = { k: number; nOn: number; nAll: number };
let toolbar: Toolbar | null = null;

function setToolbar(k: number, available: DocSet[], enabled: Set<string>): void {
  toolbar = { k, nOn: enabled.size, nAll: available.length };
}

function toolbarText(cols: number): string {
  const text = ` k=${toolbar?.k ?? 0}   ${toolbar?.nOn ?? 0}/${toolbar?.nAll ?? 0} sets   /config   /sets   /help   ctrl+d to leave `;
  return text.length > cols ? text.slice(0, cols) : text;
}

const PROMPT_CELLS = cellLen("❯ ");

let barWrite: (s: string) => void = (s) => {
  process.stdout.write(s);
};
let hookedWrite: typeof process.stdout.write | null = null;
let restoreQueued = false;
let paintingBar = false;

function barAnsi(): string {
  const cols = process.stdout.columns || 80;
  const text = toolbarText(Math.max(1, cols));
  return `\x1b[48;2;22;22;22m\x1b[38;2;115;115;115m\x1b[2K${text}\x1b[0m`;
}

function hideBar(): void {
  if (!process.stdout.isTTY) return;
  barWrite("\x1b[2K\r");
}

function showBarBelowPrompt(): void {
  if (!toolbar || !process.stdout.isTTY) return;
  barWrite(`\n${barAnsi()}\x1b[1A\r\x1b[${PROMPT_CELLS + 1}G`);
}

function restoreBar(): void {
  if (!atPrompt || !toolbar || !process.stdout.isTTY || paintingBar) return;
  paintingBar = true;
  try {
    barWrite(`\x1b7\x1b[s\x1b[1B\r${barAnsi()}\x1b[u\x1b8`);
  } finally {
    paintingBar = false;
  }
}

function scheduleRestoreBar(): void {
  if (!atPrompt || restoreQueued || paintingBar) return;
  restoreQueued = true;
  process.nextTick(() => {
    restoreQueued = false;
    restoreBar();
  });
}

function hookStdoutForBar(): void {
  if (hookedWrite) return;
  const orig = process.stdout.write.bind(process.stdout);
  barWrite = (s) => {
    orig(s);
  };
  hookedWrite = process.stdout.write;
  process.stdout.write = ((
    chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ) => {
    const result = orig(chunk as never, encoding as never, cb as never);
    scheduleRestoreBar();
    return result;
  }) as typeof process.stdout.write;
}

function unhookStdoutForBar(): void {
  if (!hookedWrite) return;
  process.stdout.write = hookedWrite;
  hookedWrite = null;
  barWrite = (s) => {
    process.stdout.write(s);
  };
}

function onPromptKey(_s: string, key: readline.Key): void {
  if (!atPrompt) return;
  if (key.name === "return" || key.name === "enter") return;
  scheduleRestoreBar();
}

function onPromptResize(): void {
  if (!atPrompt) return;
  scheduleRestoreBar();
  setTimeout(() => {
    if (atPrompt) restoreBar();
  }, 0);
}

function onPromptInput(): void {
  if (!atPrompt) return;
  scheduleRestoreBar();
}

async function withStatusHidden<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  hideBar();
  try {
    return await fn();
  } catch (err) {
    reportError(err);
    return undefined;
  }
}

function makeSpinner(text: string) {
  return ora({
    text,
    spinner: "dots",
    discardStdin: false,
    stream: process.stderr,
  });
}

function reportError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(pc.red(msg));
  console.log();
}

function formatDetails(n: number, nOn: number, nAll: number, k: number): string {
  const dot = muted("·");
  return [
    `${dot}  ${pc.cyan(String(n))} ${muted("chunks")}`,
    `${dot}  ${pc.cyan(`${nOn}/${nAll}`)} ${muted("sets")}`,
    `${dot}  ${pc.cyan(`k=${k}`)}`,
  ].join("  ");
}

function cellLen(text: string): number {
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    n += code >= 0x1100 && eastAsian(code) ? 2 : 1;
  }
  return n;
}

function eastAsian(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  );
}

function chopCells(token: string, width: number): string[] {
  const out: string[] = [];
  let buf = "";
  let n = 0;
  for (const ch of token) {
    const w = cellLen(ch);
    if (n + w > width && buf) {
      out.push(buf);
      buf = ch;
      n = w;
    } else {
      buf += ch;
      n += w;
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : [""];
}

class WordWrap {
  width: number;
  indent: string;
  indentWidth: number;
  file: NodeJS.WritableStream | null;
  col = 0;
  atLineStart = true;
  pendingSpace = false;
  wrapped = false;
  word: string[] = [];
  out: string[] = [];

  constructor(width: number, opts: { indent?: string; file?: NodeJS.WritableStream | null } = {}) {
    this.width = Math.max(8, width);
    this.indent = opts.indent ?? "";
    this.indentWidth = cellLen(this.indent);
    this.file = opts.file ?? null;
  }

  emit(s: string): void {
    if (this.file) this.file.write(s);
    else this.out.push(s);
  }

  newline(wrapped = false): void {
    this.emit("\n");
    this.col = 0;
    this.atLineStart = true;
    this.pendingSpace = false;
    this.wrapped = wrapped;
  }

  ensureIndent(): void {
    if (this.atLineStart && this.indent) {
      this.emit(this.indent);
      this.col = this.indentWidth;
      this.atLineStart = false;
    }
  }

  feed(piece: string): void {
    for (const ch of piece) {
      if (ch === "\n") {
        this.flushWord();
        this.newline();
      } else if (ch === "\r") {
        continue;
      } else if (/\s/.test(ch)) {
        this.flushWord();
        if (this.atLineStart) {
          if (this.wrapped) continue;
          this.ensureIndent();
          this.emit(" ");
          this.col += 1;
          this.atLineStart = false;
        } else {
          this.pendingSpace = true;
        }
      } else {
        this.word.push(ch);
      }
    }
  }

  flushWord(): void {
    if (!this.word.length) return;
    const token = this.word.join("");
    this.word = [];
    const n = cellLen(token);
    const usable = Math.max(1, this.width - this.indentWidth);

    if (n > usable) {
      if (!this.atLineStart) this.newline(true);
      this.ensureIndent();
      for (const chunk of chopCells(token, usable)) {
        const cn = cellLen(chunk);
        if (!this.atLineStart && this.col + cn > this.width) {
          this.newline(true);
          this.ensureIndent();
        }
        this.emit(chunk);
        this.col += cn;
        this.atLineStart = false;
        if (this.col >= this.width) this.newline(true);
      }
      return;
    }

    const extra = this.atLineStart || !this.pendingSpace ? 0 : 1;
    if (!this.atLineStart && this.col + extra + n > this.width) this.newline(true);
    this.ensureIndent();
    if (this.pendingSpace && !this.atLineStart) {
      this.emit(" ");
      this.col += 1;
    }
    this.pendingSpace = false;
    this.emit(token);
    this.col += n;
    this.atLineStart = false;
    if (this.col >= this.width) this.newline(true);
  }

  finish(): string {
    this.flushWord();
    return this.file ? "" : this.out.join("");
  }
}

function wrapText(text: string, width: number, indent = ""): string {
  const w = new WordWrap(width, { indent });
  w.feed(text);
  return w.finish();
}

function wrapWidth(): number {
  return Math.max(24, (process.stdout.columns || 80) - 1);
}

function printBanner(k: number, available: DocSet[], enabled: Set<string>): void {
  const n = available.filter((s) => enabled.has(s.slug)).reduce((sum, s) => sum + s.n, 0);
  const nOn = enabled.size;
  const nAll = available.length;
  const details = formatDetails(n, nOn, nAll, k);
  const hint = `${muted("type a question, or ")}${pc.cyan("/help")}`;
  setToolbar(k, available, enabled);
  const line = (text: string) => {
    process.stdout.write(`${text}\x1b[K\n`);
  };
  if (!getConfig().banner) {
    line(`${pc.bold("Hideout")}  ${details}`);
    line(hint);
    line("");
    return;
  }
  const lines = BANNER.split("\n");
  const artWidth = Math.max(...lines.map((row) => cellLen(row)));
  line("");
  if ((process.stdout.columns || 80) >= artWidth + 2) {
    for (const row of lines) line(accent(row));
    line(muted("─".repeat(artWidth)));
  } else {
    line(accent("HIDEOUT"));
  }
  line(details);
  line(hint);
  line("");
}

function printHits(hits: Hit[]): void {
  if (!hits.length) {
    console.log(pc.dim("no hits"));
    console.log();
    return;
  }
  hits.forEach((hit, i) => {
    const c = hit.chunk;
    const section = [c.chapter, ...c.headings].join(" > ");
    const meta = [c.file];
    if (c.page) {
      let page = `PDF p.${c.page}`;
      if (c.printed != null) page += ` / printed ${c.printed}`;
      meta.push(page);
    }
    meta.push(hit.score.toFixed(3));
    console.log();
    console.log(
      `  ${accent(String(i + 1))}  ${pc.cyan(c.book)}  ${pc.dim("·")}  ${section}`,
    );
    console.log(pc.dim(`     ${meta.join(" · ")}`));
    console.log();
    console.log(wrapText(c.text, wrapWidth(), "     "));
  });
  console.log();
}

function printSources(hits: Hit[]): void {
  if (!hits.length) return;
  console.log();
  console.log(pc.dim("sources"));
  hits.forEach((hit, i) => {
    const c = hit.chunk;
    const section = [c.chapter, ...c.headings].join(" > ");
    const bits = [c.file, section];
    if (c.page) bits.push(`PDF p.${c.page}`);
    console.log(
      `  ${pc.dim(`${i + 1}.`)} ${pc.cyan(c.book)} ${pc.dim(`· ${bits.join(" · ")}`)}`,
    );
  });
  console.log();
}

function completer(line: string): [string[], string] {
  if (line.includes(" ") || !line.startsWith("/")) return [[], line];
  const hits = SLASH.filter(([cmd]) => cmd.startsWith(line)).map(([cmd]) => cmd);
  return [hits, line];
}

async function makeRl(): Promise<readline.Interface> {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const hist = tty ? await loadPromptHistory() : [];
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: tty ? completer : undefined,
    history: hist,
    historySize: Math.max(200, hist.length, HISTORY_LOAD),
    removeHistoryDuplicates: true,
    terminal: tty,
    prompt: `${accent("❯")} `,
  });
}

let atPrompt = false;

function readLine(rl: readline.Interface): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      atPrompt = false;
      unhookStdoutForBar();
      process.stdin.off("keypress", onPromptKey);
      process.stdin.off("data", onPromptInput);
      process.stdout.off("resize", onPromptResize);
      rl.off("line", onLine);
      rl.off("close", onClose);
      rl.off("SIGINT", onSigint);
      resolve(value);
    };
    const onLine = (line: string) => finish(line);
    const onClose = () => finish(null);
    const onSigint = () => {
      const state = rl as readline.Interface & { line: string; cursor: number };
      state.line = "";
      state.cursor = 0;
      if (process.stdout.isTTY) process.stdout.write("\x1b[1B\x1b[2K\r");
      console.log(pc.dim("^C"));
      finish("");
    };
    rl.once("line", onLine);
    rl.once("close", onClose);
    rl.once("SIGINT", onSigint);
    process.stdin.on("keypress", onPromptKey);
    process.stdin.on("data", onPromptInput);
    process.stdout.on("resize", onPromptResize);
    atPrompt = true;
    hookStdoutForBar();
    rl.prompt();
    showBarBelowPrompt();
  });
}

async function ensureModelsUi(): Promise<void> {
  const jobs = await modelsToPull();
  if (!jobs.length) return;
  const spin = makeSpinner("pulling models").start();
  try {
    await ensureModels((msg) => spin.start(pc.dim(msg)), jobs);
  } finally {
    spin.stop();
  }
}

async function ensureIndexUi(): Promise<void> {
  if (!(await needsRebuild())) return;
  console.log(pc.dim("markdown changed; rebuilding index…"));
  await buildIndex(true);
  console.log();
}

function activeBooks(available: DocSet[], enabled: Set<string>): Set<string> | null {
  const slugs = new Set(available.map((s) => s.slug));
  if (!enabled.size) return new Set();
  if ([...slugs].every((s) => enabled.has(s))) return null;
  return enabled;
}

function printSets(available: DocSet[], enabled: Set<string>): void {
  console.log();
  for (const s of available) {
    const mark = enabled.has(s.slug) ? "x" : " ";
    console.log(`  [${mark}]  ${pc.cyan(s.slug)}  ${s.title}  ${pc.dim(String(s.n))}`);
  }
  console.log();
}

async function doSets(
  available: DocSet[],
  enabled: Set<string>,
  rest: string,
): Promise<Set<string>> {
  if (rest) {
    const [picked, err] = parseSetArgs(rest, available);
    if (err || !picked) {
      console.log(pc.dim(err ?? "usage: /sets slug [slug ...]"));
      console.log();
      return enabled;
    }
    saveEnabled(picked);
    printSets(available, picked);
    return picked;
  }
  const picked = await pickSets(available, enabled);
  if (picked == null) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      printSets(available, enabled);
      console.log(pc.dim("run in a terminal for the picker, or /sets slug ..."));
      console.log();
    }
    return enabled;
  }
  saveEnabled(picked);
  printSets(available, picked);
  return picked;
}

function printConfig(): void {
  const cfg = getConfig();
  console.log();
  const row = (label: string, value: string) => {
    console.log(`  ${pc.dim(label)}  ${value}`);
  };
  row("model", cfg.chatModel);
  row("banner", cfg.banner ? "on" : "off");
  row("llm", cfg.chatUrl);
  if (Object.keys(cfg.chatHeaders).length) {
    row("llm headers", Object.keys(cfg.chatHeaders).map((n) => `${n} (set)`).join(", "));
  }
  row("embed", cfg.embedUrl);
  if (Object.keys(cfg.embedHeaders).length) {
    row("embed headers", Object.keys(cfg.embedHeaders).map((n) => `${n} (set)`).join(", "));
  }
  if (!cfg.sources.length) console.log(`  ${pc.dim("sources  (none)")}`);
  else {
    for (const path of cfg.sources) {
      const mark = existsSync(path) ? "ok" : "missing";
      console.log(`  ${pc.dim(`[${mark}]`)}  ${path}`);
    }
  }
  console.log();
}

async function doConfig(
  available: DocSet[],
  enabled: Set<string>,
): Promise<[DocSet[], Set<string>]> {
  const old = getConfig();
  const edited = await editConfig(old);
  if (edited == null) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      printConfig();
      console.log(pc.dim(`run in a terminal to edit, or change ${configPath()}`));
      console.log();
    }
    return [available, enabled];
  }
  const oldSources = new Set(old.sources.map((p) => p));
  const newSources = new Set(edited.sources.map((p) => p));
  writeConfig(edited);
  reloadConfig();
  printConfig();
  try {
    await ensureModelsUi();
  } catch (err) {
    if (err instanceof LlmError) {
      console.log(pc.red(err.message));
      console.log();
    } else throw err;
  }
  const sameSources =
    oldSources.size === newSources.size && [...oldSources].every((p) => newSources.has(p));
  const embedChanged =
    apiBase(edited.embedUrl) !== apiBase(old.embedUrl) ||
    JSON.stringify(edited.embedHeaders) !== JSON.stringify(old.embedHeaders) ||
    edited.embedModel !== old.embedModel;
  if (!sameSources || embedChanged) {
    try {
      console.log(pc.dim("rebuilding index…"));
      await buildIndex(true);
    } catch (err) {
      const msg =
        err instanceof LlmError || err instanceof HideoutError
          ? err.message
          : String(err);
      console.log(pc.red(msg));
      console.log();
      return [available, enabled];
    }
    available = await listSets();
    enabled = loadEnabled(available);
    printSets(available, enabled);
  }
  return [available, enabled];
}

async function doSearch(query: string, k: number, books: Set<string> | null): Promise<void> {
  const spin = makeSpinner("searching").start();
  try {
    const hits = await rrf(query, { k, books });
    spin.stop();
    printHits(hits);
  } catch (err) {
    spin.stop();
    reportError(err);
    return;
  }
}

async function doAsk(query: string, k: number, books: Set<string> | null): Promise<void> {
  const spin = makeSpinner("retrieving").start();
  let hits: Hit[];
  try {
    hits = await rrf(query, { k, books });
  } catch (err) {
    spin.stop();
    reportError(err);
    return;
  }
  if (!hits.length) {
    spin.stop();
    console.log(pc.dim("no hits"));
    console.log();
    return;
  }
  spin.text = "waiting";
  try {
    const stream = new WordWrap(wrapWidth(), { file: process.stdout });
    let first = true;
    for await (const piece of chat(promptMessages(query, hits), true)) {
      if (first) {
        spin.stop();
        console.log();
        first = false;
      }
      stream.feed(piece);
    }
    if (first) {
      spin.stop();
      console.log();
    }
    stream.finish();
  } catch (err) {
    spin.stop();
    reportError(err);
    return;
  }
  console.log();
  printSources(hits);
}

export async function run(k = 6): Promise<number> {
  try {
    return await runLoop(k);
  } finally {
    await closeDb();
  }
}

async function runLoop(k: number): Promise<number> {
  try {
    await ensureModelsUi();
  } catch (err) {
    if (err instanceof LlmError) {
      console.log(pc.red(err.message));
      console.log();
    } else throw err;
  }
  try {
    await ensureIndexUi();
  } catch (err) {
    const msg =
      err instanceof LlmError || err instanceof HideoutError ? err.message : String(err);
    console.log(pc.red(msg));
    return 1;
  }

  let available = await listSets();
  let enabled = loadEnabled(available);
  let rl = await makeRl();

  async function withExternalPrompt<T>(fn: () => Promise<T>): Promise<T | undefined> {
    rl.close();
    try {
      return await fn();
    } catch (err) {
      reportError(err);
      return undefined;
    } finally {
      if (process.stdin.isTTY) process.stdin.resume();
      rl = await makeRl();
    }
  }

  try {
    printBanner(k, available, enabled);

    while (true) {
      const raw = await readLine(rl);
      if (raw == null) {
        hideBar();
        console.log();
        return 0;
      }
      const line = raw.trim();
      if (!line) {
        hideBar();
        continue;
      }
      if (process.stdin.isTTY) await appendPromptHistory(line);

      const low = line.toLowerCase();
      const books = activeBooks(available, enabled);
      if (["/q", "/quit", "/exit"].includes(low)) {
        hideBar();
        return 0;
      }
      if (["/help", "/?"].includes(low)) {
        await withStatusHidden(() => {
          console.log();
          console.log(HELP);
        });
        continue;
      }
      if (low === "/clear") {
        hideBar();
        console.clear();
        printBanner(k, available, enabled);
        continue;
      }
      if (low === "/config") {
        hideBar();
        await withExternalPrompt(async () => {
          [available, enabled] = await doConfig(available, enabled);
          setToolbar(k, available, enabled);
        });
        continue;
      }
      if (low === "/sets" || low === "/books" || low.startsWith("/sets ") || low.startsWith("/books ")) {
        const rest = line.includes(" ") ? line.slice(line.indexOf(" ") + 1) : "";
        if (rest) {
          await withStatusHidden(async () => {
            enabled = await doSets(available, enabled, rest);
            setToolbar(k, available, enabled);
          });
        } else {
          hideBar();
          await withExternalPrompt(async () => {
            enabled = await doSets(available, enabled, rest);
            setToolbar(k, available, enabled);
          });
        }
        continue;
      }
      if (low === "/k" || low.startsWith("/k ")) {
        const rest = line.slice(2).trim();
        await withStatusHidden(() => {
          if (!/^\d+$/.test(rest) || Number(rest) < 1) {
            console.log(pc.dim("usage: /k 8"));
            console.log();
            return;
          }
          k = Number(rest);
          setToolbar(k, available, enabled);
          console.log(pc.dim(`k=${k}`));
          console.log();
        });
        continue;
      }
      if (low === "/ask" || low.startsWith("/ask ")) {
        const query = line.slice(4).trim();
        await withStatusHidden(async () => {
          if (!query) {
            console.log(pc.dim("usage: /ask who is Cuckoo"));
            console.log();
            return;
          }
          await doAsk(query, k, books);
        });
        continue;
      }
      if (low === "/search" || low.startsWith("/search ")) {
        const query = line.slice(7).trim();
        await withStatusHidden(async () => {
          if (!query) {
            console.log(pc.dim("usage: /search Hovgårdsfjärden"));
            console.log();
            return;
          }
          await doSearch(query, k, books);
        });
        continue;
      }
      await withStatusHidden(() => doAsk(line, k, books));
    }
  } finally {
    hideBar();
    rl.close();
  }
}

import {
  type Config,
  DEFAULT_BASE_URL,
  formatHeaderText,
  getConfig,
  parseBoolText,
  parseHeaderText,
  parseSourceText,
} from "./config.js";
import { listModels } from "./llm.js";

const ACCENT = "\x1b[1m\x1b[38;2;255;107;74m";
const MUTED = "\x1b[38;2;115;115;115m";
const TEXT = "\x1b[38;2;229;229;229m";
const BORDER = "\x1b[38;2;68;68;68m";
const RESET = "\x1b[0m";

type Field = {
  id: string;
  label: string;
  multiline: boolean;
  checkbox?: boolean;
  value: string;
};

type Key =
  | { type: "text"; data: string }
  | {
      type:
        | "tab"
        | "s-tab"
        | "up"
        | "down"
        | "left"
        | "right"
        | "home"
        | "end"
        | "enter"
        | "backspace"
        | "delete"
        | "save"
        | "cancel"
        | "esc";
    };

export async function editConfig(cfg?: Config): Promise<Config | null> {
  const current = cfg ?? getConfig();
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const models = await listModels();
  return runForm(current, models);
}

function runForm(cfg: Config, models: string[]): Promise<Config | null> {
  const fields: Field[] = [
    { id: "model", label: "chat model", multiline: false, value: cfg.chatModel },
    {
      id: "banner",
      label: "banner  (wordmark)",
      multiline: false,
      checkbox: true,
      value: cfg.banner ? "true" : "false",
    },
    { id: "llm_url", label: "llm url", multiline: false, value: cfg.chatUrl },
    {
      id: "llm_headers",
      label: "llm headers  (Name: value, one per line)",
      multiline: true,
      value: formatHeaderText(cfg.chatHeaders),
    },
    { id: "embed_url", label: "embed url", multiline: false, value: cfg.embedUrl },
    {
      id: "embed_headers",
      label: "embed headers  (Name: value, one per line)",
      multiline: true,
      value: formatHeaderText(cfg.embedHeaders),
    },
    {
      id: "sources",
      label: "sources  (one directory per line)",
      multiline: true,
      value: cfg.sources.join("\n"),
    },
  ];

  return new Promise((resolve) => {
    let focus = 0;
    let cursor = [...fields[0].value].length;
    let done = false;
    const wasRaw = process.stdin.isRaw;

    const finish = (result: Config | null) => {
      if (done) return;
      done = true;
      process.stdin.off("data", onData);
      process.stdout.off("resize", draw);
      process.stdout.write("\x1b[?25h\x1b[?1049l");
      if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw));
      resolve(result);
    };

    const collect = (): Config | null => {
      const name = fields[0].value.trim();
      if (!name) return null;
      const chatUrl = fields[2].value.trim() || DEFAULT_BASE_URL;
      return {
        ...cfg,
        chatModel: name,
        banner: parseBoolText(fields[1].value, cfg.banner),
        chatUrl,
        embedUrl: fields[4].value.trim() || chatUrl,
        chatHeaders: parseHeaderText(fields[3].value),
        embedHeaders: parseHeaderText(fields[5].value),
        sources: parseSourceText(fields[6].value),
      };
    };

    let cycleHits: string[] = [];
    let cycleAt = -1;

    const resetCycle = () => {
      cycleHits = [];
      cycleAt = -1;
    };

    let modelsKey = `${fields[2].value.trim()}\n${fields[3].value}`;
    let modelsLoading = false;
    let modelsGen = 0;

    const refreshModels = async () => {
      const key = `${fields[2].value.trim()}\n${fields[3].value}`;
      if (key === modelsKey) return;
      const gen = ++modelsGen;
      modelsKey = key;
      modelsLoading = true;
      resetCycle();
      draw();
      const url = fields[2].value.trim() || DEFAULT_BASE_URL;
      const next = await listModels({ url, headers: parseHeaderText(fields[3].value) });
      if (done || gen !== modelsGen) return;
      models = next;
      modelsLoading = false;
      resetCycle();
      draw();
    };

    const setFocus = (index: number) => {
      const prev = fields[focus].id;
      focus = (index + fields.length) % fields.length;
      cursor = fields[focus].checkbox ? 1 : [...fields[focus].value].length;
      resetCycle();
      if (prev === "llm_url" || prev === "llm_headers" || fields[focus].id === "model") {
        void refreshModels();
      }
    };

    const toggleCheck = () => {
      if (!fields[focus].checkbox) return;
      fields[focus].value = fields[focus].value === "true" ? "false" : "true";
    };

    const insert = (ch: string) => {
      resetCycle();
      const chars = [...fields[focus].value];
      chars.splice(cursor, 0, ...[...ch]);
      fields[focus].value = chars.join("");
      cursor += [...ch].length;
    };

    const backspace = () => {
      resetCycle();
      if (cursor <= 0) return;
      const chars = [...fields[focus].value];
      chars.splice(cursor - 1, 1);
      fields[focus].value = chars.join("");
      cursor -= 1;
    };

    const del = () => {
      resetCycle();
      const chars = [...fields[focus].value];
      if (cursor >= chars.length) return;
      chars.splice(cursor, 1);
      fields[focus].value = chars.join("");
    };

    const moveH = (delta: number) => {
      const n = [...fields[focus].value].length;
      cursor = Math.max(0, Math.min(n, cursor + delta));
    };

    const moveV = (delta: number) => {
      const field = fields[focus];
      if (!field.multiline) {
        setFocus(focus + delta);
        return;
      }
      const { line, col, lines } = lineCol(field.value, cursor);
      const next = Math.max(0, Math.min(lines.length - 1, line + delta));
      const nextCol = Math.min(col, [...lines[next] ?? ""].length);
      cursor = offsetAt(lines, next, nextCol);
    };

    const goHome = () => {
      if (!fields[focus].multiline) {
        cursor = 0;
        return;
      }
      const { line, lines } = lineCol(fields[focus].value, cursor);
      cursor = offsetAt(lines, line, 0);
    };

    const goEnd = () => {
      const chars = [...fields[focus].value];
      if (!fields[focus].multiline) {
        cursor = chars.length;
        return;
      }
      const { line, lines } = lineCol(fields[focus].value, cursor);
      cursor = offsetAt(lines, line, [...lines[line] ?? ""].length);
    };

    const completeModel = (dir: 1 | -1): boolean => {
      const typed = fields[0].value;
      const q = typed.trim().toLowerCase();
      const hits = models.filter((m) => !q || m.toLowerCase().includes(q));
      if (!hits.length) return false;
      const same =
        cycleHits.length === hits.length && cycleHits.every((h, i) => h === hits[i]);
      if (!same) {
        cycleHits = hits;
        cycleAt = -1;
        const shared = commonPrefix(hits);
        if (dir === 1 && shared.length > typed.length && shared.toLowerCase().startsWith(q)) {
          fields[0].value = shared;
          cursor = [...shared].length;
          return true;
        }
      }
      if (cycleAt >= 0 && cycleHits[cycleAt] === typed) {
        cycleAt = (cycleAt + dir + cycleHits.length) % cycleHits.length;
      } else {
        const exact = cycleHits.findIndex((h) => h === typed);
        cycleAt =
          exact >= 0
            ? (exact + dir + cycleHits.length) % cycleHits.length
            : dir === 1
              ? 0
              : cycleHits.length - 1;
      }
      fields[0].value = cycleHits[cycleAt];
      cursor = [...fields[0].value].length;
      return true;
    };

    const handle = (key: Key) => {
      if (key.type === "cancel" || key.type === "esc") {
        finish(null);
        return;
      }
      if (key.type === "save") {
        const result = collect();
        if (result) finish(result);
        return;
      }
      if (key.type === "tab") {
        if (fields[focus].id === "model" && !modelsLoading && models.length && completeModel(1)) return;
        setFocus(focus + 1);
        return;
      }
      if (key.type === "s-tab") {
        if (fields[focus].id === "model" && cycleAt >= 0 && completeModel(-1)) return;
        setFocus(focus - 1);
        return;
      }
      if (key.type === "enter") {
        if (fields[focus].checkbox) {
          toggleCheck();
          return;
        }
        if (fields[focus].multiline) insert("\n");
        else {
          const result = collect();
          if (result) finish(result);
        }
        return;
      }
      if (fields[focus].checkbox) {
        if (key.type === "text" && key.data === " ") toggleCheck();
        else if (key.type === "up") setFocus(focus - 1);
        else if (key.type === "down") setFocus(focus + 1);
        return;
      }
      if (key.type === "backspace") backspace();
      else if (key.type === "delete") del();
      else if (key.type === "left") moveH(-1);
      else if (key.type === "right") moveH(1);
      else if (key.type === "up") moveV(-1);
      else if (key.type === "down") moveV(1);
      else if (key.type === "home") goHome();
      else if (key.type === "end") goEnd();
      else if (key.type === "text") insert(key.data);
    };

    function draw(): void {
      if (done) return;
      const cols = Math.max(40, process.stdout.columns || 80);
      const rows = Math.max(16, process.stdout.rows || 24);
      const inner = cols - 4;
      const [hHead, hEmb, hSrc] = multiHeights(rows);
      const heights: Record<string, number> = {
        llm_headers: hHead,
        embed_headers: hEmb,
        sources: hSrc,
      };

      let hint = "tab switches fields. ctrl+s saves. esc cancels.";
      if (modelsLoading) {
        hint = "fetching models…";
      } else if (fields[focus].id === "model" && models.length) {
        hint = "tab completes the model. down moves on. ctrl+s saves. esc cancels.";
        const q = fields[0].value.trim().toLowerCase();
        const hits = models.filter((m) => m.toLowerCase().includes(q)).slice(0, 4);
        if (hits.length) hint = `${hits.join("  ·  ")}   ·   ${hint}`;
      } else if (fields[focus].id === "model") {
        hint = "no models from this llm url. ctrl+s saves. esc cancels.";
      } else if (fields[focus].checkbox) {
        hint = "space toggles. " + hint;
      }

      const lines: { text: string }[] = [];
      const push = (text: string) => {
        lines.push({ text });
      };
      push(MUTED + clip(hint, inner) + RESET);
      push("");

      let cursorPos: { row: number; col: number } | null = null;
      for (const field of fields) {
        const on = fields[focus] === field;
        if (field.checkbox) {
          const mark = field.value === "true" ? "x" : " ";
          const rowIndex = lines.length;
          push((on ? ACCENT : MUTED) + clip(`[${mark}]  ${field.label}`, inner) + RESET);
          if (on) cursorPos = { row: rowIndex, col: 1 };
          continue;
        }
        push((on ? ACCENT : MUTED) + clip(field.label, inner) + RESET);
        const viewH = field.multiline ? heights[field.id] ?? 4 : 1;
        const view = fieldView(field.value, on ? cursor : -1, inner, viewH);
        for (let i = 0; i < view.rows.length; i++) {
          const rowIndex = lines.length;
          push(TEXT + view.rows[i] + RESET);
          if (view.cursor && view.cursor.row === i) {
            cursorPos = { row: rowIndex, col: view.cursor.col };
          }
        }
      }

      const maxBody = Math.max(1, rows - 2);
      const body = lines.slice(0, maxBody);
      while (body.length < maxBody) body.push({ text: "" });
      const top = `${BORDER}┌${RESET}${ACCENT} config ${RESET}${BORDER}${"─".repeat(Math.max(0, inner - 8))}┐${RESET}`;
      const bot = `${BORDER}└${"─".repeat(inner)}┘${RESET}`;
      const frame = [top];
      for (const line of body) {
        frame.push(`${BORDER}│${RESET}${padVisible(line.text, inner)}${BORDER}│${RESET}`);
      }
      frame.push(bot);
      process.stdout.write(`\x1b[?25l\x1b[2J\x1b[H${frame.join("\n")}`);
      if (cursorPos && cursorPos.row < body.length) {
        const screenRow = cursorPos.row + 2;
        const screenCol = Math.min(inner, cursorPos.col) + 2;
        process.stdout.write(`\x1b[${screenRow};${screenCol}H\x1b[?25h`);
      } else {
        process.stdout.write("\x1b[?25h");
      }
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

function commonPrefix(items: string[]): string {
  if (!items.length) return "";
  let prefix = items[0];
  for (const item of items.slice(1)) {
    let n = 0;
    while (
      n < prefix.length &&
      n < item.length &&
      prefix[n].toLowerCase() === item[n].toLowerCase()
    ) {
      n += 1;
    }
    prefix = prefix.slice(0, n);
    if (!prefix) break;
  }
  return prefix;
}

function multiHeights(rows: number): [number, number, number] {
  const leftover = Math.max(9, rows - 18);
  const a = Math.max(2, Math.floor((leftover * 4) / 14));
  const b = Math.max(2, Math.floor((leftover * 4) / 14));
  const c = Math.max(3, leftover - a - b);
  return [a, b, c];
}

function lineCol(text: string, cursor: number): { line: number; col: number; lines: string[] } {
  const lines = text.split("\n");
  let left = cursor;
  for (let i = 0; i < lines.length; i++) {
    const n = [...lines[i]].length;
    if (left <= n) return { line: i, col: left, lines };
    left -= n + 1;
  }
  const last = lines.length - 1;
  return { line: Math.max(0, last), col: [...(lines[last] ?? "")].length, lines };
}

function offsetAt(lines: string[], line: number, col: number): number {
  let off = 0;
  for (let i = 0; i < line; i++) off += [...lines[i]].length + 1;
  return off + col;
}

function fieldView(
  text: string,
  cursor: number,
  width: number,
  height: number,
): { rows: string[]; cursor?: { row: number; col: number } } {
  const lines = text.split("\n");
  if (cursor < 0) {
    return { rows: padRows(lines.slice(0, height).map((l) => clip(l, width)), height) };
  }
  const pos = lineCol(text, cursor);
  const from = Math.max(0, pos.line - height + 1);
  const slice = lines.slice(from, from + height);
  const hScroll = pos.col >= width ? pos.col - width + 1 : 0;
  const rows = padRows(
    slice.map((l) => {
      const chars = [...l];
      return chars.slice(hScroll, hScroll + width).join("");
    }),
    height,
  );
  return {
    rows,
    cursor: { row: pos.line - from, col: pos.col - hScroll },
  };
}

function padRows(rows: string[], height: number): string[] {
  const out = rows.slice(0, height);
  while (out.length < height) out.push("");
  return out;
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
      if (chunk.startsWith("\x1b[A", i)) {
        keys.push({ type: "up" });
        i += 3;
        continue;
      }
      if (chunk.startsWith("\x1b[B", i)) {
        keys.push({ type: "down" });
        i += 3;
        continue;
      }
      if (chunk.startsWith("\x1b[C", i)) {
        keys.push({ type: "right" });
        i += 3;
        continue;
      }
      if (chunk.startsWith("\x1b[D", i)) {
        keys.push({ type: "left" });
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
      if (chunk.startsWith("\x1b[3~", i)) {
        keys.push({ type: "delete" });
        i += 4;
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
    if (code === 127 || code === 8) {
      keys.push({ type: "backspace" });
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

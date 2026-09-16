#!/usr/bin/env node
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ask } from "./ask.js";
import { ensureConfig, getConfig, reloadConfig } from "./config.js";
import { closeDb } from "./db.js";
import { HideoutError } from "./errors.js";
import { ExtractError, extractPdf } from "./extract.js";
import { buildIndex, needsRebuild } from "./index.js";
import { ensureModels, LlmError } from "./llm.js";
import { configPath, dataDir, indexDir, pgliteDir } from "./paths.js";
import { formatHit, rrf } from "./search.js";
import { run as runTui } from "./tui.js";

function bootstrap(): void {
  const seeds: string[] = [];
  for (const name of ["markdown", "docs"]) {
    const candidate = resolve(process.cwd(), name);
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        seeds.push(candidate);
      }
    } catch {
      // skip
    }
  }
  ensureConfig(seeds.length ? seeds : null);
  reloadConfig();
}

function printPaths(): number {
  const cfg = getConfig();
  console.log(`config  ${configPath()}`);
  console.log(`data    ${dataDir()}`);
  console.log(`index   ${indexDir()}`);
  console.log(`pglite  ${pgliteDir()}`);
  console.log(`llm     ${cfg.chatUrl}`);
  console.log(`embed   ${cfg.embedUrl}`);
  if (Object.keys(cfg.chatHeaders).length) {
    console.log(
      "llm headers  " + Object.keys(cfg.chatHeaders).map((n) => `${n} (set)`).join(", "),
    );
  }
  if (Object.keys(cfg.embedHeaders).length) {
    console.log(
      "embed headers  " + Object.keys(cfg.embedHeaders).map((n) => `${n} (set)`).join(", "),
    );
  }
  if (!cfg.sources.length) {
    console.log("sources  (none)");
    return 0;
  }
  console.log("sources");
  for (const path of cfg.sources) {
    let mark = "missing";
    try {
      if (existsSync(path) && statSync(path).isDirectory()) mark = "ok";
    } catch {
      mark = "missing";
    }
    console.log(`  [${mark}] ${path}`);
  }
  return 0;
}

function needSources(): boolean {
  const cfg = getConfig();
  if (cfg.sources.some((path) => {
    try {
      return existsSync(path) && statSync(path).isDirectory();
    } catch {
      return false;
    }
  })) {
    return true;
  }
  console.error(`no sources configured. edit ${configPath()}`);
  return false;
}

async function ensureLlm(): Promise<number> {
  let printed = false;
  const status = (msg: string) => {
    printed = true;
    const width = 80;
    const shown = msg.length <= width ? msg : msg.slice(0, width - 1) + "…";
    process.stderr.write(`\r${shown.padEnd(width)}`);
  };
  try {
    await ensureModels(status);
  } catch (err) {
    if (printed) process.stderr.write("\n");
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (printed) process.stderr.write("\n");
  return 0;
}

function helpText(): string {
  return `usage: hideout [command]

Ask a local model about markdown libraries (hybrid FTS + embeddings).

commands:
  tui                 interactive ask prompt (default)
  index [--force]     chunk markdown and rebuild the local index
  search <query>      retrieve matching excerpts
  ask [query]         retrieve, then answer with the local model
  config              print config and data paths
  extract <pdf> <dir> convert a PDF to markdown

options:
  -k <n>              number of chunks to show
  --json              search: print hits as JSON
  --book <slug>       limit to a book folder; repeat to include several
  -h, --help          show this help
`;
}

async function readAskQuery(): Promise<string> {
  process.stdout.write("ask> ");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const line = await new Promise<string>((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
  return line.trim();
}

async function dispatch(
  cmd: string | undefined,
  args: {
    force: boolean;
    k: number;
    json: boolean;
    books?: string[];
    query: string[];
    pdf?: string;
    target?: string;
  },
): Promise<number> {
  if (cmd === "config") return printPaths();

  if (cmd === "extract") {
    if (!args.pdf || !args.target) {
      console.error("usage: hideout extract <pdf> <dir>");
      return 2;
    }
    try {
      return await extractPdf(args.pdf, args.target);
    } catch (err) {
      console.error(err instanceof ExtractError ? err.message : String(err));
      return 2;
    }
  }

  if (!needSources() && cmd !== "index") return 2;

  if (cmd == null || cmd === "tui") {
    return runTui(args.k);
  }

  if (cmd === "index" || cmd === "search" || cmd === "ask") {
    if ((await ensureLlm()) !== 0) return 2;
  }

  if (cmd === "index") {
    if (!needSources()) return 2;
    const n = await buildIndex(args.force);
    console.log(`index ready: ${n} chunks`);
    return 0;
  }

  if (await needsRebuild()) {
    console.error("markdown changed; rebuilding index…");
    await buildIndex(true);
  }

  if (cmd === "search") {
    const query = args.query.join(" ");
    if (!query) {
      console.error("usage: hideout search <query>");
      return 2;
    }
    const hits = await rrf(query, { k: args.k, books: args.books });
    if (args.json) {
      const payload = hits.map((hit) => ({
        score: hit.score,
        book: hit.chunk.book,
        file: hit.chunk.file,
        chapter: hit.chunk.chapter,
        headings: hit.chunk.headings,
        page: hit.chunk.page,
        printed: hit.chunk.printed,
        text: hit.chunk.text,
      }));
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    if (!hits.length) {
      console.log("no hits");
      return 1;
    }
    hits.forEach((hit, i) => {
      console.log(`--- ${i + 1} ---`);
      console.log(formatHit(hit));
      console.log();
    });
    return 0;
  }

  if (cmd === "ask") {
    let query = args.query.join(" ").trim();
    if (!query) {
      query = await readAskQuery();
      if (!query) return 1;
    }
    const [answer, hits] = await ask(query, { k: args.k, books: args.books });
    console.log(answer);
    if (hits.length) {
      console.log("\nSources:");
      for (const hit of hits) {
        const c = hit.chunk;
        const section = [c.chapter, ...c.headings].join(" > ");
        const page = c.page ? `p.${c.page}` : "p.?";
        console.log(`  - ${c.book} · ${c.file} · ${section} · PDF ${page}`);
      }
    }
    return 0;
  }

  console.error(helpText());
  return 2;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  bootstrap();
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(helpText());
    return 0;
  }

  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
  const rest = cmd ? argv.slice(1) : argv;

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: false,
      options: {
        force: { type: "boolean" },
        k: { type: "string", short: "k" },
        json: { type: "boolean" },
        book: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const kDefault = cmd === "ask" ? 8 : 6;
  const k = parsed.values.k ? Number(parsed.values.k) : kDefault;
  const positionals = parsed.positionals;
  let pdf: string | undefined;
  let target: string | undefined;
  let query = positionals;
  if (cmd === "extract") {
    pdf = positionals[0];
    target = positionals[1];
    query = [];
  }

  try {
    return await dispatch(cmd, {
      force: Boolean(parsed.values.force),
      k: Number.isFinite(k) && k > 0 ? k : kDefault,
      json: Boolean(parsed.values.json),
      books: parsed.values.book as string[] | undefined,
      query,
      pdf,
      target,
    });
  } catch (err) {
    if (err instanceof HideoutError) {
      console.error(err.message);
      return err.exitCode;
    }
    if (err instanceof LlmError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  } finally {
    await closeDb();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return /(?:cli\.[cm]?[jt]s|hideout)$/.test(entry);
  }
}

if (isDirectRun()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

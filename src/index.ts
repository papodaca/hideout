import ora from "ora";
import { type Chunk, chunkAll, embedText, markdownFiles, sourceHash } from "./chunk.js";
import {
  asVector,
  connect,
  countChunks,
  ensureDb,
  getMeta,
  missingEmbeddings,
  removeLegacy,
  resetChunks,
  setEmbeddingDim,
  setMeta,
  tryBm25,
  tryHnsw,
} from "./db.js";
import { HideoutError } from "./errors.js";
import { embed } from "./llm.js";
import { configPath } from "./paths.js";

const BATCH = 16;

export type ChunkRow = {
  chunk_id: string;
  file: string;
  book: string;
  chapter: string;
  headings: unknown;
  page: number | null;
  printed: number | null;
  text: string;
};

export async function needsRebuild(): Promise<boolean> {
  await ensureDb();
  if ((await countChunks()) === 0 || (await missingEmbeddings()) > 0) return true;
  const saved = await getMeta("source_hash");
  return saved !== sourceHash(markdownFiles());
}

export async function buildIndex(force = false): Promise<number> {
  if (!force && !(await needsRebuild())) {
    const n = await countChunks();
    console.log(`index is current (${n} chunks)`);
    return n;
  }
  const files = markdownFiles();
  if (!files.length) {
    throw new HideoutError(
      `no markdown in configured sources; edit sources in ${configPath()}`,
    );
  }
  const chunks = chunkAll();
  if (!chunks.length) {
    throw new HideoutError("no markdown chunks found in configured sources");
  }

  const total = chunks.length;
  const spin = process.stderr.isTTY
    ? ora({
        text: `embedded 0/${total}`,
        spinner: "dots",
        discardStdin: false,
        stream: process.stderr,
      }).start()
    : null;
  const vectors: number[][] = [];
  try {
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      vectors.push(...(await embed(batch.map((c) => embedText(c)), false)));
      const done = Math.min(i + BATCH, total);
      if (spin) spin.text = `embedded ${done}/${total}`;
      else console.log(`embedded ${done}/${total}`);
    }
    spin?.succeed(`embedded ${total}/${total}`);
  } catch (err) {
    spin?.fail();
    throw err;
  }

  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) throw new HideoutError("embed returned empty vectors");

  const pg = await connect();
  await resetChunks(pg);
  await setEmbeddingDim(pg, dim);
  await pg.transaction(async (tx) => {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const vec = vectors[i];
      await tx.query(
        `
                INSERT INTO chunks (
                    chunk_id, file, book, chapter, headings,
                    page, printed, text, embedding
                )
                VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::vector)
                `,
        [
          c.id,
          c.file,
          c.book,
          c.chapter,
          JSON.stringify(c.headings),
          c.page,
          c.printed,
          c.text,
          asVector(vec),
        ],
      );
    }
    await setMeta("source_hash", sourceHash(files), tx);
    await setMeta("chunks", String(chunks.length), tx);
    await setMeta("vectors", "pgvector", tx);
  });
  await tryHnsw(pg);
  await tryBm25(pg);
  removeLegacy();
  return chunks.length;
}

export function rowToChunk(row: ChunkRow): Chunk {
  let headings = row.headings;
  if (typeof headings === "string") headings = JSON.parse(headings);
  return {
    id: row.chunk_id,
    file: row.file,
    book: row.book,
    chapter: row.chapter,
    headings: Array.isArray(headings) ? headings.map(String) : [],
    page: row.page,
    printed: row.printed,
    text: row.text,
    sourceMtime: 0,
  };
}

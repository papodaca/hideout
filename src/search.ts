import type { Chunk } from "./chunk.js";
import { connect } from "./db.js";
import { type ChunkRow, rowToChunk } from "./index.js";
import { embed } from "./llm.js";
import { vectorQuery } from "./vectors.js";

const RRF_K = 60;
const FTS_WEIGHT = 1.2;
const VEC_WEIGHT = 1.0;

export type Hit = {
  chunk: Chunk;
  score: number;
  ftsRank: number | undefined;
  vecRank: number | undefined;
};

function bm25Query(text: string): string | null {
  const tokens = text.match(/[A-Za-zÅÄÖåäö0-9']+/g) ?? [];
  const kept = tokens.filter((tok) => tok.length >= 2);
  if (!kept.length) return null;
  return kept.join(" ");
}

export async function rowidsInBooks(books: Iterable<string>): Promise<Set<number>> {
  const names = [...books];
  if (!names.length) return new Set();
  const pg = await connect();
  const params = names.map((n) => n);
  const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
  const rows = (
    await pg.query<{ id: number }>(
      `SELECT id FROM chunks WHERE book IN (${placeholders})`,
      params,
    )
  ).rows;
  return new Set(rows.map((r) => Number(r.id)));
}

export async function ftsSearch(
  query: string,
  limit = 20,
  rowids?: Set<number> | null,
): Promise<[number, number][]> {
  const match = bm25Query(query);
  if (!match) return [];
  if (rowids != null && rowids.size === 0) return [];
  const pg = await connect();
  let rows: { id: number; rank: number }[];
  if (rowids == null) {
    rows = (
      await pg.query<{ id: number; rank: number }>(
        `
            SELECT c.id, c.search_text <@> to_bm25query($1, 'chunks_bm25_idx') AS rank
            FROM chunks c
            ORDER BY c.search_text <@> to_bm25query($1, 'chunks_bm25_idx')
            LIMIT $2
            `,
        [match, limit],
      )
    ).rows;
  } else {
    const ids = [...rowids];
    const params: unknown[] = [match, ...ids, limit];
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
    const lim = ids.length + 2;
    rows = (
      await pg.query<{ id: number; rank: number }>(
        `
            SELECT c.id, c.search_text <@> to_bm25query($1, 'chunks_bm25_idx') AS rank
            FROM chunks c
            WHERE c.id IN (${placeholders})
            ORDER BY c.search_text <@> to_bm25query($1, 'chunks_bm25_idx')
            LIMIT $${lim}
            `,
        params,
      )
    ).rows;
  }
  return rows.map((r) => [Number(r.id), Number(r.rank)]);
}

export async function vectorSearch(
  query: string,
  limit = 20,
  rowids?: Set<number> | null,
  books?: Iterable<string> | null,
): Promise<[number, number][]> {
  if (rowids != null && rowids.size === 0) return [];
  const vector = (await embed([query], true))[0].map(Number);
  const hits = await vectorQuery(vector, { limit, books });
  if (rowids == null) return hits;
  return hits.filter(([rowid]) => rowids.has(rowid));
}

export async function rrf(
  query: string,
  opts: { k?: number; pool?: number; books?: Iterable<string> | null } = {},
): Promise<Hit[]> {
  const k = opts.k ?? 8;
  const pool = opts.pool ?? 24;
  let allowed: Set<number> | undefined;
  if (opts.books != null) {
    allowed = await rowidsInBooks(opts.books);
    if (!allowed.size) return [];
  }
  const fts = await ftsSearch(query, pool, allowed);
  const vec = await vectorSearch(query, pool, allowed, opts.books);
  const ftsRank = new Map(fts.map(([rowid], i) => [rowid, i]));
  const vecRank = new Map(vec.map(([rowid], i) => [rowid, i]));
  const scores = new Map<number, number>();
  for (const [rowid, rank] of ftsRank) {
    scores.set(rowid, (scores.get(rowid) ?? 0) + FTS_WEIGHT / (RRF_K + rank));
  }
  for (const [rowid, rank] of vecRank) {
    scores.set(rowid, (scores.get(rowid) ?? 0) + VEC_WEIGHT / (RRF_K + rank));
  }
  const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  if (!ordered.length) return [];
  const pg = await connect();
  const hits: Hit[] = [];
  for (const [rowid, score] of ordered) {
    const row = (
      await pg.query<ChunkRow>("SELECT * FROM chunks WHERE id = $1", [rowid])
    ).rows[0];
    if (!row) continue;
    hits.push({
      chunk: rowToChunk(row),
      score,
      ftsRank: ftsRank.get(rowid),
      vecRank: vecRank.get(rowid),
    });
  }
  return hits;
}

export function formatHit(hit: Hit, snippet = 700): string {
  const c = hit.chunk;
  const section = [c.chapter, ...c.headings].join(" > ");
  const meta = [c.file];
  if (c.page) {
    let page = `PDF p.${c.page}`;
    if (c.printed != null) page += ` / printed ${c.printed}`;
    meta.push(page);
  }
  meta.push(`score ${hit.score.toFixed(3)}`);
  const body = c.text.length <= snippet ? c.text : c.text.slice(0, snippet - 1).replace(/\s+$/, "") + "…";
  return `${c.book} · ${section}\n${meta.join(" · ")}\n\n${body}`;
}

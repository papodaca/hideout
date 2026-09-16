import { asVector, connect } from "./db.js";

export async function vectorQuery(
  vector: number[],
  opts: { limit: number; books?: Iterable<string> | null },
): Promise<[number, number][]> {
  const pg = await connect();
  const q = asVector(vector);
  if (opts.books != null) {
    const names = [...opts.books].filter(Boolean);
    if (!names.length) return [];
    const params: unknown[] = [q, ...names, opts.limit];
    const placeholders = names.map((_, i) => `$${i + 2}`).join(", ");
    const rows = (
      await pg.query<{ id: number; score: number }>(
        `
            SELECT id, 1 - (embedding <=> $1::vector) AS score
            FROM chunks
            WHERE embedding IS NOT NULL AND book IN (${placeholders})
            ORDER BY embedding <=> $1::vector
            LIMIT $${params.length}
            `,
        params,
      )
    ).rows;
    return rows.map((r) => [Number(r.id), Number(r.score)]);
  }
  const rows = (
    await pg.query<{ id: number; score: number }>(
      `
            SELECT id, 1 - (embedding <=> $1::vector) AS score
            FROM chunks
            WHERE embedding IS NOT NULL
            ORDER BY embedding <=> $1::vector
            LIMIT $2
            `,
      [q, opts.limit],
    )
  ).rows;
  return rows.map((r) => [Number(r.id), Number(r.score)]);
}

from __future__ import annotations

from collections.abc import Collection

from hideout.db import as_vector, connect


def vector_query(
    vector: list[float],
    *,
    limit: int,
    books: Collection[str] | None = None,
) -> list[tuple[int, float]]:
    conn = connect()
    q = as_vector(vector)
    if books is not None:
        names = [name for name in books if name]
        if not names:
            return []
        rows = conn.execute(
            """
            SELECT id, 1 - (embedding <=> %s) AS score
            FROM chunks
            WHERE embedding IS NOT NULL AND book = ANY(%s)
            ORDER BY embedding <=> %s
            LIMIT %s
            """,
            (q, names, q, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT id, 1 - (embedding <=> %s) AS score
            FROM chunks
            WHERE embedding IS NOT NULL
            ORDER BY embedding <=> %s
            LIMIT %s
            """,
            (q, q, limit),
        ).fetchall()
    return [(int(r["id"]), float(r["score"])) for r in rows]

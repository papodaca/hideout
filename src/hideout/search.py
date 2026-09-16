from __future__ import annotations

import re
from collections.abc import Collection
from dataclasses import dataclass

from hideout.chunk import Chunk
from hideout.db import connect
from hideout.index import row_to_chunk
from hideout.ollama import embed
from hideout.vectors import vector_query

RRF_K = 60
FTS_WEIGHT = 1.2
VEC_WEIGHT = 1.0


@dataclass
class Hit:
    chunk: Chunk
    score: float
    fts_rank: int | None
    vec_rank: int | None


def _bm25_query(text: str) -> str | None:
    tokens = re.findall(r"[A-Za-zÅÄÖåäö0-9']+", text)
    kept = [tok for tok in tokens if len(tok) >= 2]
    if not kept:
        return None
    return " ".join(kept)


def rowids_in_books(books: Collection[str]) -> set[int]:
    if not books:
        return set()
    conn = connect()
    rows = conn.execute(
        "SELECT id FROM chunks WHERE book = ANY(%s)",
        (list(books),),
    ).fetchall()
    return {int(r["id"]) for r in rows}


def fts_search(
    query: str,
    limit: int = 20,
    rowids: set[int] | None = None,
) -> list[tuple[int, float]]:
    match = _bm25_query(query)
    if not match:
        return []
    if rowids is not None and not rowids:
        return []
    conn = connect()
    q = match
    if rowids is None:
        rows = conn.execute(
            """
            SELECT c.id, c.search_text <@> to_bm25query(%s, 'chunks_bm25_idx') AS rank
            FROM chunks c
            ORDER BY c.search_text <@> to_bm25query(%s, 'chunks_bm25_idx')
            LIMIT %s
            """,
            (q, q, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT c.id, c.search_text <@> to_bm25query(%s, 'chunks_bm25_idx') AS rank
            FROM chunks c
            WHERE c.id = ANY(%s)
            ORDER BY c.search_text <@> to_bm25query(%s, 'chunks_bm25_idx')
            LIMIT %s
            """,
            (q, list(rowids), q, limit),
        ).fetchall()
    return [(int(r["id"]), float(r["rank"])) for r in rows]


def vector_search(
    query: str,
    limit: int = 20,
    rowids: set[int] | None = None,
    books: Collection[str] | None = None,
) -> list[tuple[int, float]]:
    if rowids is not None and not rowids:
        return []
    vector = [float(x) for x in embed([query], query=True)[0]]
    hits = vector_query(vector, limit=limit, books=books)
    if rowids is None:
        return hits
    allowed = rowids
    return [(rowid, score) for rowid, score in hits if rowid in allowed]


def rrf(
    query: str,
    k: int = 8,
    pool: int = 24,
    books: Collection[str] | None = None,
) -> list[Hit]:
    allowed: set[int] | None = None
    if books is not None:
        allowed = rowids_in_books(books)
        if not allowed:
            return []
    fts = fts_search(query, limit=pool, rowids=allowed)
    vec = vector_search(query, limit=pool, rowids=allowed, books=books)
    fts_rank = {rowid: i for i, (rowid, _) in enumerate(fts)}
    vec_rank = {rowid: i for i, (rowid, _) in enumerate(vec)}
    scores: dict[int, float] = {}
    for rowid, rank in fts_rank.items():
        scores[rowid] = scores.get(rowid, 0.0) + FTS_WEIGHT / (RRF_K + rank)
    for rowid, rank in vec_rank.items():
        scores[rowid] = scores.get(rowid, 0.0) + VEC_WEIGHT / (RRF_K + rank)
    ordered = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:k]
    if not ordered:
        return []
    conn = connect()
    hits: list[Hit] = []
    for rowid, score in ordered:
        row = conn.execute("SELECT * FROM chunks WHERE id = %s", (rowid,)).fetchone()
        if row is None:
            continue
        hits.append(
            Hit(
                chunk=row_to_chunk(row),
                score=score,
                fts_rank=fts_rank.get(rowid),
                vec_rank=vec_rank.get(rowid),
            )
        )
    return hits


def format_hit(hit: Hit, *, snippet: int = 700) -> str:
    c = hit.chunk
    section = " > ".join([c.chapter, *c.headings])
    page = f"PDF p.{c.page}" if c.page else "PDF p.?"
    if c.printed is not None:
        page += f" / printed {c.printed}"
    body = c.text if len(c.text) <= snippet else c.text[: snippet - 1].rstrip() + "…"
    return f"{c.book} · {section}\n{c.file} · {page} · score {hit.score:.3f}\n\n{body}"

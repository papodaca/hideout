from __future__ import annotations

import json
from typing import Any

from psycopg.types.json import Jsonb

from hideout.chunk import Chunk, chunk_all, markdown_files, source_hash
from hideout.db import (
    as_vector,
    connect,
    count_chunks,
    ensure_db,
    get_meta,
    missing_embeddings,
    remove_legacy,
    reset_chunks,
    set_embedding_dim,
    set_meta,
    try_hnsw,
)
from hideout.ollama import embed

BATCH = 16


def needs_rebuild() -> bool:
    ensure_db()
    if count_chunks() == 0 or missing_embeddings():
        return True
    saved = get_meta("source_hash")
    return saved != source_hash(markdown_files())


def build_index(*, force: bool = False) -> int:
    if not force and not needs_rebuild():
        n = count_chunks()
        print(f"index is current ({n} chunks)")
        return n
    files = markdown_files()
    if not files:
        raise SystemExit(
            "no markdown in configured sources; edit "
            "sources in $XDG_CONFIG_HOME/hideout/config.toml"
        )
    chunks = chunk_all()
    if not chunks:
        raise SystemExit("no markdown chunks found in configured sources")

    vectors: list[list[float]] = []
    for i in range(0, len(chunks), BATCH):
        batch = chunks[i : i + BATCH]
        vectors.extend(embed([c.embed_text() for c in batch], query=False))
        print(f"embedded {min(i + BATCH, len(chunks))}/{len(chunks)}")

    dim = len(vectors[0]) if vectors else 0
    if dim == 0:
        raise SystemExit("embed returned empty vectors")

    conn = connect()
    reset_chunks(conn)
    set_embedding_dim(conn, dim)
    with conn.transaction():
        for c, vec in zip(chunks, vectors, strict=True):
            conn.execute(
                """
                INSERT INTO chunks (
                    chunk_id, file, book, chapter, headings,
                    page, printed, text, embedding
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    c.id,
                    c.file,
                    c.book,
                    c.chapter,
                    Jsonb(c.headings),
                    c.page,
                    c.printed,
                    c.text,
                    as_vector(vec),
                ),
            )
        set_meta("source_hash", source_hash(files), conn)
        set_meta("chunks", str(len(chunks)), conn)
        set_meta("vectors", "pgvector", conn)
    try_hnsw(conn)
    remove_legacy()
    return len(chunks)


def row_to_chunk(row: Any) -> Chunk:
    headings = row["headings"]
    if isinstance(headings, str):
        headings = json.loads(headings)
    return Chunk(
        id=row["chunk_id"],
        file=row["file"],
        book=row["book"],
        chapter=row["chapter"],
        headings=list(headings),
        page=row["page"],
        printed=row["printed"],
        text=row["text"],
    )

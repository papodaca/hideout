from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from hideout.chunk import Chunk, chunk_all, markdown_files, source_hash
from hideout.ollama import embed
from hideout.paths import index_dir
from hideout.vectors import create_vectors, destroy_vectors, insert_vectors, vec_path

BATCH = 16
DB_NAME = "chunks.sqlite"
META_NAME = "meta.json"
LEGACY_EMB_NAME = "embeddings.npy"


def _paths() -> tuple[Path, Path, Path]:
    root = index_dir()
    root.mkdir(parents=True, exist_ok=True)
    return root / DB_NAME, vec_path(), root / META_NAME


def needs_rebuild() -> bool:
    db, vec, meta = _paths()
    if not (db.is_file() and vec.exists() and meta.is_file()):
        return True
    current = source_hash(markdown_files())
    saved = json.loads(meta.read_text()).get("source_hash")
    return saved != current


def build_index(*, force: bool = False) -> int:
    if not force and not needs_rebuild():
        n = _count()
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

    db, _, meta = _paths()
    if db.exists():
        db.unlink()
    legacy = index_dir() / LEGACY_EMB_NAME
    if legacy.exists():
        legacy.unlink()
    destroy_vectors()

    conn = sqlite3.connect(db)
    try:
        _init_schema(conn)
        conn.executemany(
            """
            INSERT INTO chunks(id, file, book, chapter, headings, page, printed, text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    c.id,
                    c.file,
                    c.book,
                    c.chapter,
                    json.dumps(c.headings, ensure_ascii=False),
                    c.page,
                    c.printed,
                    c.text,
                )
                for c in chunks
            ],
        )
        conn.execute(
            """
            INSERT INTO chunks_fts(rowid, text, headings, chapter, file, book)
            SELECT rowid, text, headings, chapter, file, book FROM chunks
            """
        )
        conn.commit()
        rows = conn.execute("SELECT rowid, book FROM chunks ORDER BY rowid").fetchall()
    finally:
        conn.close()

    create_vectors(dim)
    insert_vectors(
        (int(rowid), str(book), [float(x) for x in vec])
        for (rowid, book), vec in zip(rows, vectors, strict=True)
    )
    meta.write_text(
        json.dumps(
            {
                "source_hash": source_hash(files),
                "chunks": len(chunks),
                "dim": dim,
                "vectors": "zvec",
            },
            indent=2,
        )
        + "\n"
    )
    return len(chunks)


def _count() -> int:
    db, _, _ = _paths()
    conn = sqlite3.connect(db)
    try:
        return int(conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])
    finally:
        conn.close()


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE chunks (
            rowid INTEGER PRIMARY KEY,
            id TEXT UNIQUE NOT NULL,
            file TEXT NOT NULL,
            book TEXT NOT NULL,
            chapter TEXT NOT NULL,
            headings TEXT NOT NULL,
            page INTEGER,
            printed INTEGER,
            text TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
            text,
            headings,
            chapter,
            file,
            book,
            content='chunks',
            content_rowid='rowid',
            tokenize = "unicode61 remove_diacritics 2"
        );
        """
    )


def connect() -> sqlite3.Connection:
    db, _, _ = _paths()
    if not db.is_file():
        raise SystemExit("no index yet; run: python -m hideout index")
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    return conn


def row_to_chunk(row: sqlite3.Row) -> Chunk:
    return Chunk(
        id=row["id"],
        file=row["file"],
        book=row["book"],
        chapter=row["chapter"],
        headings=json.loads(row["headings"]),
        page=row["page"],
        printed=row["printed"],
        text=row["text"],
    )

from __future__ import annotations

import shutil
from collections.abc import Collection, Iterable
from pathlib import Path

from hideout.paths import index_dir

VEC_NAME = "zvec"
VECTOR_FIELD = "embedding"
BOOK_FIELD = "book"

_collection = None


def vec_path() -> Path:
    return index_dir() / VEC_NAME


def close_vectors() -> None:
    global _collection
    _collection = None


def destroy_vectors() -> None:
    close_vectors()
    path = vec_path()
    if not path.exists():
        return
    try:
        import zvec

        zvec.open(str(path)).destroy()
    except Exception:
        shutil.rmtree(path, ignore_errors=True)


def create_vectors(dim: int):
    import zvec

    destroy_vectors()
    schema = zvec.CollectionSchema(
        name="chunks",
        fields=[
            zvec.FieldSchema(
                name=BOOK_FIELD,
                data_type=zvec.DataType.STRING,
                index_param=zvec.InvertIndexParam(),
            ),
        ],
        vectors=[
            zvec.VectorSchema(
                name=VECTOR_FIELD,
                data_type=zvec.DataType.VECTOR_FP32,
                dimension=dim,
                index_param=zvec.HnswIndexParam(metric_type=zvec.MetricType.COSINE),
            ),
        ],
    )
    global _collection
    _collection = zvec.create_and_open(str(vec_path()), schema)
    return _collection


def open_vectors(*, write: bool = False):
    import zvec

    global _collection
    if _collection is not None:
        return _collection
    path = vec_path()
    if not path.exists():
        raise SystemExit("no index yet; run: python -m hideout index")
    _collection = zvec.open(
        str(path),
        option=zvec.CollectionOption(read_only=not write, enable_mmap=True),
    )
    return _collection


def insert_vectors(rows: Iterable[tuple[int, str, list[float]]]) -> None:
    import zvec

    coll = open_vectors(write=True)
    docs = [
        zvec.Doc(
            id=str(rowid),
            vectors={VECTOR_FIELD: vector},
            fields={BOOK_FIELD: book},
        )
        for rowid, book, vector in rows
    ]
    if not docs:
        return
    coll.insert(docs)
    coll.optimize()
    coll.flush()
    close_vectors()


def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def book_filter(books: Collection[str]) -> str | None:
    names = [name for name in books if name]
    if not names:
        return None
    return f"{BOOK_FIELD} in ({', '.join(_quote(name) for name in names)})"


def vector_query(
    vector: list[float],
    *,
    limit: int,
    books: Collection[str] | None = None,
) -> list[tuple[int, float]]:
    import zvec

    coll = open_vectors(write=False)
    filt = book_filter(books) if books is not None else None
    hits = coll.query(
        queries=zvec.Query(field_name=VECTOR_FIELD, vector=vector),
        topk=limit,
        filter=filt,
        include_vector=False,
    )
    out: list[tuple[int, float]] = []
    for doc in hits:
        try:
            rowid = int(doc.id)
        except (TypeError, ValueError):
            continue
        out.append((rowid, float(doc.score)))
    return out

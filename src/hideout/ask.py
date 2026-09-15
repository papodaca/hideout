from __future__ import annotations

from collections.abc import Callable, Collection

from hideout.config import get_config
from hideout.ollama import chat
from hideout.search import Hit, format_hit, rrf


def prompt_messages(question: str, hits: list[Hit]) -> list[dict]:
    blocks = []
    for i, hit in enumerate(hits, start=1):
        c = hit.chunk
        section = " > ".join([c.chapter, *c.headings])
        page = f"PDF page {c.page}" if c.page else "unknown page"
        if c.printed is not None:
            page += f", printed {c.printed}"
        blocks.append(
            f"[{i}] {c.book} | {c.file} | {section} | {page}\n{c.text}"
        )
    context = "\n\n----\n\n".join(blocks)
    return [
        {"role": "system", "content": get_config().system_prompt},
        {
            "role": "user",
            "content": f"Excerpts:\n\n{context}\n\nQuestion: {question}",
        },
    ]


def ask(
    question: str,
    k: int = 8,
    on_token: Callable[[str], None] | None = None,
    books: Collection[str] | None = None,
) -> tuple[str, list[Hit]]:
    hits = rrf(question, k=k, books=books)
    if not hits:
        msg = "No matching excerpts in the index."
        if on_token:
            on_token(msg)
        return msg, []
    parts: list[str] = []
    for piece in chat(prompt_messages(question, hits), stream=True):
        parts.append(piece)
        if on_token:
            on_token(piece)
    return "".join(parts).strip(), hits


def print_hits(hits: list[Hit]) -> None:
    for i, hit in enumerate(hits, start=1):
        print(f"--- {i} ---")
        print(format_hit(hit))
        print()

from __future__ import annotations

import hashlib
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from hideout.config import get_config

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
PAGE_RE = re.compile(
    r"^\*PDF page (\d+)(?: \(printed (\d+)\))?\*$"
)
SKIP_FILES = {"README.md"}


@dataclass
class Chunk:
    id: str
    file: str
    book: str
    chapter: str
    headings: list[str]
    page: int | None
    printed: int | None
    text: str
    source_mtime: float = 0.0

    def embed_text(self) -> str:
        path = " > ".join([self.chapter, *self.headings]) if self.headings else self.chapter
        page = f"PDF page {self.page}" if self.page else ""
        if self.printed is not None:
            page += f" (printed {self.printed})"
        header = "\n".join(p for p in (self.book, path, page) if p)
        return f"{header}\n\n{self.text}"

    def as_dict(self) -> dict:
        return asdict(self)


def source_roots() -> list[Path]:
    return [p for p in get_config().sources if p.is_dir()]


def markdown_files(roots: list[Path] | None = None) -> list[tuple[Path, Path]]:
    roots = roots if roots is not None else source_roots()
    out: list[tuple[Path, Path]] = []
    for root in roots:
        for path in root.rglob("*.md"):
            if path.name in SKIP_FILES:
                continue
            out.append((path, root))
    return sorted(out, key=lambda item: (str(item[1]), str(item[0])))


def source_hash(files: list[tuple[Path, Path]] | None = None) -> str:
    items = files if files is not None else markdown_files()
    h = hashlib.sha256()
    for path, root in items:
        rel = path.relative_to(root)
        h.update(str(root.resolve()).encode())
        h.update(str(rel).encode())
        h.update(path.read_bytes())
    return h.hexdigest()[:16]


def _book_and_file(path: Path, root: Path, *, prefix: bool) -> tuple[str, str]:
    rel = path.relative_to(root)
    book = rel.parts[0] if len(rel.parts) > 1 else root.name
    rel_posix = rel.as_posix()
    if prefix:
        return f"{root.name}/{book}", f"{root.name}/{rel_posix}"
    return book, rel_posix


def _flush(
    chunks: list[Chunk],
    file: Path,
    root: Path,
    chapter: str,
    headings: list[str],
    page: int | None,
    printed: int | None,
    buf: list[str],
    mtime: float,
    *,
    prefix: bool,
) -> None:
    cfg = get_config()
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(buf)).strip()
    if len(text) < cfg.min_chars:
        return
    parts = _split_text(text) if len(text) > cfg.max_chars else [text]
    base = len(chunks)
    book, rel = _book_and_file(file, root, prefix=prefix)
    root_key = str(root.resolve())
    for i, part in enumerate(parts):
        slug = _slug("-".join(headings) or chapter)
        chunk_id = f"{root_key}:{rel}:{slug}:{base + i}"
        chunks.append(
            Chunk(
                id=chunk_id,
                file=rel,
                book=book,
                chapter=chapter,
                headings=list(headings),
                page=page,
                printed=printed,
                text=part,
                source_mtime=mtime,
            )
        )


def _split_text(text: str) -> list[str]:
    cfg = get_config()
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    out: list[str] = []
    buf: list[str] = []
    size = 0
    for para in paras:
        extra = len(para) + 2
        if buf and size + extra > cfg.max_chars:
            out.append("\n\n".join(buf))
            overlap: list[str] = []
            osize = 0
            for prev in reversed(buf):
                if osize + len(prev) > cfg.overlap_chars:
                    break
                overlap.append(prev)
                osize += len(prev)
            buf = list(reversed(overlap))
            size = sum(len(x) + 2 for x in buf)
        buf.append(para)
        size += extra
    if buf:
        out.append("\n\n".join(buf))
    return out or [text[: cfg.max_chars]]


def _slug(text: str) -> str:
    text = text.lower().replace("ä", "a").replace("ö", "o").replace("å", "a")
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:80] or "section"


def _heading_stack(stack: list[tuple[int, str]], level: int, title: str) -> list[tuple[int, str]]:
    stack = [item for item in stack if item[0] < level]
    stack.append((level, title.strip()))
    return stack


def chunk_file(path: Path, root: Path, *, prefix: bool = False) -> list[Chunk]:
    chapter = path.stem
    headings: list[tuple[int, str]] = []
    page: int | None = None
    printed: int | None = None
    chunk_page = page
    chunk_printed = printed
    buf: list[str] = []
    chunks: list[Chunk] = []
    mtime = path.stat().st_mtime

    def flush() -> None:
        nonlocal buf
        _flush(
            chunks,
            path,
            root,
            chapter,
            [title for level, title in headings if level != 1],
            chunk_page,
            chunk_printed,
            buf,
            mtime,
            prefix=prefix,
        )
        buf = []

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()
        page_match = PAGE_RE.match(line)
        if page_match:
            page = int(page_match.group(1))
            printed = int(page_match.group(2)) if page_match.group(2) else None
            if not buf:
                chunk_page, chunk_printed = page, printed
            continue
        heading = HEADING_RE.match(line)
        if heading:
            flush()
            level = len(heading.group(1))
            title = heading.group(2).strip()
            headings = _heading_stack(headings, level, title)
            if level == 1:
                chapter = title
            chunk_page, chunk_printed = page, printed
            continue
        if line.strip():
            buf.append(line)
        elif buf:
            buf.append("")

    flush()
    return chunks


def chunk_all() -> list[Chunk]:
    files = markdown_files()
    roots = {root for _, root in files}
    prefix = len(roots) > 1
    chunks: list[Chunk] = []
    for path, root in files:
        chunks.extend(chunk_file(path, root, prefix=prefix))
    return chunks

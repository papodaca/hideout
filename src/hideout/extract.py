from __future__ import annotations

import re
import statistics
from dataclasses import dataclass
from pathlib import Path


class ExtractError(RuntimeError):
    pass


@dataclass
class Bookmark:
    level: int
    title: str
    page: int


@dataclass
class Line:
    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    md: str
    size: float
    font: str
    kind: str
    printed: int | None = None

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2


def slug(text: str) -> str:
    text = text.lower().replace("ä", "a").replace("ö", "o").replace("å", "a")
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text or "section"


def normalize(text: str) -> str:
    text = text.upper().replace("’", "'").replace("‘", "'")
    return re.sub(r"[^A-Z0-9]+", "", text)


def clean_bookmark_title(title: str) -> str:
    title = re.sub(r"\s+", " ", title.replace("\t", " ")).strip()
    if title.endswith("]") and not title.startswith("["):
        title = "[" + title
    title = re.sub(r":(\S)", r": \1", title)
    return title


def _typical_size(page) -> float:
    weights: dict[float, int] = {}
    data = page.get_text("dict")
    for block in data["blocks"]:
        if block.get("type") != 0:
            continue
        for raw in block["lines"]:
            for span in raw["spans"]:
                text = span["text"].strip()
                if len(text) < 2:
                    continue
                size = round(float(span["size"]), 1)
                if size >= 40:
                    continue
                weights[size] = weights.get(size, 0) + len(text)
    if not weights:
        return 10.0
    return max(weights, key=weights.get)


def _classify(
    size: float,
    fonts: set[str],
    text: str,
    width: float,
    height: float,
    x0: float,
    x1: float,
    y0: float,
    y1: float,
    body: float,
) -> str:
    stripped = text.strip()
    if size >= 72:
        return "skip"
    if re.fullmatch(r"\d{1,4}", stripped):
        near_edge = y0 < 56 or y1 > height - 50
        narrow = (x1 - x0) < 48 and (x0 < 60 or x0 > width - 80)
        if near_edge or narrow:
            return "pagenum"
    if any("Dingbat" in font for font in fonts) and re.fullmatch(r"[■●▪•\s]+", stripped):
        return "bullet"
    if stripped in {"■", "●", "▪", "•"}:
        return "bullet"
    if size >= max(body * 2.1, 20):
        return "h1"
    if size >= max(body * 1.4, 13):
        return "h2"
    bold = all("Bold" in font or "bold" in font for font in fonts)
    if bold and size >= body * 1.02 and len(stripped) < 90:
        if ":" in stripped and re.search(r":\s+[a-zA-Z]", stripped):
            return "body"
        return "h3"
    italic = all(
        "Italic" in font or "Oblique" in font or "italic" in font for font in fonts
    ) and not any("Bold" in font or "Roman" in font for font in fonts)
    if italic:
        return "flavor"
    return "body"


def _format_spans(spans: list[dict]) -> str:
    parts: list[str] = []
    for span in spans:
        text = span["text"]
        if "Dingbat" in span["font"] or text.strip() in {"■", "●", "▪", "•"}:
            continue
        parts.append(text)
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def iter_raw_lines(page, pdf_page: int) -> tuple[list[Line], int | None]:
    data = page.get_text("dict")
    width = page.rect.width
    height = page.rect.height
    body = _typical_size(page)
    printed: int | None = None
    lines: list[Line] = []
    for block in data["blocks"]:
        if block.get("type") != 0:
            continue
        for raw in block["lines"]:
            dx, dy = raw.get("dir", (1.0, 0.0))
            if abs(dx) < 0.75:
                continue
            spans = [span for span in raw["spans"] if span["text"]]
            if not spans:
                continue
            text = "".join(span["text"] for span in spans)
            if not text.strip():
                continue
            x0, y0, x1, y1 = raw["bbox"]
            size = max(span["size"] for span in spans)
            fonts = {span["font"] for span in spans}
            kind = _classify(size, fonts, text, width, height, x0, x1, y0, y1, body)
            if kind == "pagenum":
                if y0 < 56 or y1 > height - 50:
                    try:
                        printed = int(text.strip())
                    except ValueError:
                        pass
                continue
            if kind == "skip":
                continue
            md = _format_spans(spans)
            if not md and kind != "bullet":
                continue
            lines.append(
                Line(
                    page=pdf_page,
                    x0=x0,
                    y0=y0,
                    x1=x1,
                    y1=y1,
                    text=text.strip(),
                    md=md,
                    size=size,
                    font=spans[0]["font"],
                    kind=kind,
                    printed=printed,
                )
            )
    return lines, printed


def merge_same_row(lines: list[Line], tol: float = 3.5) -> list[Line]:
    if not lines:
        return []
    ordered = sorted(lines, key=lambda ln: (ln.y0, ln.x0))
    rows: list[list[Line]] = [[ordered[0]]]
    for ln in ordered[1:]:
        prev = rows[-1]
        if abs(ln.y0 - statistics.median(r.y0 for r in prev)) <= tol:
            prev.append(ln)
        else:
            rows.append([ln])
    out: list[Line] = []
    for row in rows:
        row.sort(key=lambda ln: ln.x0)
        bullets = [ln for ln in row if ln.kind == "bullet"]
        rest = [ln for ln in row if ln.kind != "bullet"]
        if not rest:
            continue
        if len(rest) == 1 and not bullets:
            out.append(rest[0])
            continue
        kinds = {ln.kind for ln in rest}
        text = re.sub(r"\s+", " ", " ".join(ln.md for ln in rest if ln.md)).strip()
        if bullets:
            kind = "list"
        elif "h2" in kinds or "h1" in kinds or "h3" in kinds:
            head = next(ln for ln in rest if ln.kind in {"h1", "h2", "h3"})
            out.append(head)
            continue
        else:
            kind = rest[0].kind
        first = rest[0]
        out.append(
            Line(
                page=first.page,
                x0=row[0].x0,
                y0=min(ln.y0 for ln in row),
                x1=row[-1].x1,
                y1=max(ln.y1 for ln in row),
                text=text,
                md=text,
                size=max(ln.size for ln in rest),
                font=first.font,
                kind=kind,
                printed=first.printed,
            )
        )
    return out


def merge_wrapped_kinds(lines: list[Line]) -> list[Line]:
    if not lines:
        return []
    wrap_kinds = {"h1", "h2", "h3"}
    used: set[int] = set()
    out: list[Line] = []
    for i, ln in enumerate(lines):
        if i in used:
            continue
        if ln.kind in wrap_kinds:
            text = ln.md
            y1 = ln.y1
            x0 = ln.x0
            j = i + 1
            while j < len(lines):
                nxt = lines[j]
                if j in used:
                    j += 1
                    continue
                close = nxt.page == ln.page and (nxt.y0 - y1) < 12
                same_col = abs(nxt.x0 - x0) < 50
                if nxt.kind == ln.kind and close and same_col:
                    text = re.sub(r"\s+", " ", text + " " + nxt.md).strip()
                    y1 = nxt.y1
                    used.add(j)
                    j += 1
                    continue
                break
            if text != ln.md:
                ln = Line(
                    page=ln.page,
                    x0=ln.x0,
                    y0=ln.y0,
                    x1=ln.x1,
                    y1=y1,
                    text=text,
                    md=text,
                    size=ln.size,
                    font=ln.font,
                    kind=ln.kind,
                    printed=ln.printed,
                )
        out.append(ln)
    return out


def two_column_order(lines: list[Line], page_width: float) -> list[Line]:
    if not lines:
        return []
    mid = page_width * 0.48
    left = [ln for ln in lines if ln.x0 < mid]
    right = [ln for ln in lines if ln.x0 >= mid]
    if not left or not right or len(left) < 3 or len(right) < 3:
        return merge_wrapped_kinds(
            merge_same_row(sorted(lines, key=lambda ln: (ln.y0, ln.x0)))
        )
    return merge_wrapped_kinds(merge_same_row(left) + merge_same_row(right))


def dehyphenate(prev: str, nxt: str) -> str:
    if prev.endswith("-") and nxt[:1].islower():
        return prev[:-1] + nxt
    if prev.endswith("-") and nxt[:1].isupper():
        return prev + nxt
    return prev + " " + nxt


def join_parts(parts: list[str]) -> str:
    text = parts[0]
    for part in parts[1:]:
        text = dehyphenate(text, part)
    return re.sub(r"[ \t]+", " ", text).strip()


def heading_level(text: str, kind: str, bookmarks: list[Bookmark]) -> tuple[int, str]:
    n = normalize(text)
    for bookmark in bookmarks:
        if normalize(bookmark.title) == n:
            return 2, bookmark.title
    title = re.sub(r"\s+", " ", text).strip()
    if kind == "h1":
        return 1, title
    if kind == "h2":
        return 2, title
    return 3, title


def is_list_start(ln: Line) -> bool:
    return ln.kind == "list" or bool(re.match(r"^\d+\.\s+\S", ln.md))


def lines_to_markdown(lines: list[Line], bookmarks: list[Bookmark], chapter_title: str = "") -> str:
    chunks: list[str] = []
    buf: list[str] = []
    buf_kind = "body"
    chapter_norm = normalize(chapter_title)
    seen_chapter_title = False

    def flush() -> None:
        nonlocal buf, buf_kind
        if not buf:
            return
        text = join_parts(buf)
        if buf_kind == "flavor":
            chunks.append("> " + text)
        elif buf_kind == "list":
            chunks.append(f"- {text}")
        else:
            chunks.append(text)
        buf = []
        buf_kind = "body"

    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.kind == "page":
            flush()
            marker = f"*PDF page {ln.page}"
            if ln.printed is not None:
                marker += f" (printed {ln.printed})"
            marker += "*"
            chunks.append(marker)
            i += 1
            continue

        if ln.kind in {"h1", "h2", "h3"}:
            flush()
            level, title = heading_level(ln.text, ln.kind, bookmarks)
            if chapter_norm and normalize(title) == chapter_norm and not seen_chapter_title:
                seen_chapter_title = True
                i += 1
                continue
            chunks.append(f"{'#' * level} {title}")
            i += 1
            continue

        if is_list_start(ln):
            flush()
            parts = [re.sub(r"^[■●▪•]+\s*", "", ln.md)]
            numbered = bool(re.match(r"^\d+\.\s", ln.md))
            j = i + 1
            while j < len(lines):
                nxt = lines[j]
                if nxt.kind in {"page", "h1", "h2", "h3"}:
                    break
                if is_list_start(nxt):
                    break
                if nxt.page == ln.page and nxt.y0 - lines[j - 1].y1 > 16:
                    break
                parts.append(nxt.md)
                j += 1
            item = join_parts(parts)
            chunks.append(item if numbered else f"- {item}")
            i = j
            continue

        prev = lines[i - 1] if i else None
        new_para = False
        if buf and prev and prev.kind != "page":
            gap = ln.y0 - prev.y1
            line_h = max(8.0, prev.y1 - prev.y0)
            if ln.page != prev.page:
                new_para = False
            elif ln.kind != buf_kind and not ({ln.kind, buf_kind} <= {"body", "flavor"}):
                new_para = True
            elif gap > line_h * 0.9:
                new_para = True
        if new_para:
            flush()
        if not buf:
            buf_kind = ln.kind if ln.kind in {"flavor", "list"} else "body"
        buf.append(ln.md)
        i += 1
    flush()
    text = "\n\n".join(c for c in chunks if c and c.strip())
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def extract_page_units(page, pdf_page: int) -> tuple[list[Line], int | None]:
    raw, printed = iter_raw_lines(page, pdf_page)
    for ln in raw:
        ln.printed = printed
    return two_column_order(raw, page.rect.width), printed


def load_bookmarks(doc) -> list[Bookmark]:
    out: list[Bookmark] = []
    for item in doc.get_toc() or []:
        if not isinstance(item, (list, tuple)) or len(item) < 3:
            continue
        level, title, page = item[0], item[1], item[2]
        try:
            page_no = int(page)
        except (TypeError, ValueError):
            continue
        if page_no < 1:
            continue
        out.append(Bookmark(int(level), clean_bookmark_title(str(title)), page_no))
    return out


def _page_marker(page: int, printed: int | None) -> Line:
    return Line(
        page=page,
        x0=0,
        y0=-1,
        x1=0,
        y1=-1,
        text="",
        md="",
        size=0,
        font="",
        kind="page",
        printed=printed,
    )


def emit_range(doc, start: int, end: int, bookmarks: list[Bookmark], chapter_title: str = "") -> str:
    stream: list[Line] = []
    for p in range(start, end + 1):
        ordered, printed = extract_page_units(doc[p - 1], p)
        stream.append(_page_marker(p, printed))
        stream.extend(ordered)
    text = lines_to_markdown(stream, bookmarks, chapter_title)
    text = re.sub(
        r"(\w)-\n\n(\*PDF page [^*]+\*)\n\n([a-zåäö][^\n]*)",
        r"\1\3\n\n\2",
        text,
    )
    return text.strip() + "\n"


def book_title(pdf: Path, doc) -> str:
    meta = (doc.metadata or {}).get("title") or ""
    if str(meta).strip():
        return str(meta).strip()
    return pdf.stem.replace("_", " ").strip()


def chapter_filename(title: str, index: int) -> str:
    cleaned = re.sub(r"^\d+\.\s*", "", title)
    return f"{index:02d}-{slug(cleaned)}.md"


def write_readme(
    title: str,
    source: Path,
    files: list[tuple[str, str]],
    split: str,
) -> str:
    lines = [
        f"# {title}",
        "",
        f"Text extract of `{source.name}`. Images, maps, and art are omitted. "
        f"Split by {split}. Page markers use PDF page numbers; printed numbers "
        "are in parentheses when a footer had one.",
        "",
        "## Contents",
        "",
    ]
    for label, fname in files:
        lines.append(f"- [{label}]({fname})")
    lines.append("")
    return "\n".join(lines)


def _chapter_ranges(bookmarks: list[Bookmark], page_count: int) -> list[tuple[Bookmark, int, int]]:
    if not bookmarks:
        return []
    min_level = min(b.level for b in bookmarks)
    heads = [b for b in bookmarks if b.level == min_level]
    ranges: list[tuple[Bookmark, int, int]] = []
    for i, bookmark in enumerate(heads):
        start = max(1, bookmark.page)
        if i + 1 < len(heads):
            end = heads[i + 1].page - 1
        else:
            end = page_count
        if end < start:
            end = start
        ranges.append((bookmark, start, min(end, page_count)))
    return ranges


def extract_pdf(pdf: Path, target: Path) -> int:
    try:
        import pymupdf
    except ImportError as exc:
        raise ExtractError("pymupdf is required for extract. Re-run ./install.sh") from exc

    pdf = pdf.expanduser()
    target = target.expanduser()
    if not pdf.is_file():
        raise ExtractError(f"not a file: {pdf}")
    target.mkdir(parents=True, exist_ok=True)

    try:
        doc = pymupdf.open(pdf)
    except Exception as exc:
        raise ExtractError(f"could not open {pdf}: {exc}") from exc
    try:
        bookmarks = load_bookmarks(doc)
        title = book_title(pdf, doc)
        files: list[tuple[str, str]] = []
        if bookmarks:
            split = "PDF bookmarks"
            ranges = _chapter_ranges(bookmarks, doc.page_count)
            first = ranges[0][1] if ranges else 1
            if first > 1:
                front = emit_range(doc, 1, first - 1, bookmarks, "Front matter")
                fname = "00-front-matter.md"
                (target / fname).write_text("# Front matter\n\n" + front, encoding="utf-8")
                files.append(("Front matter", fname))
                print(f"  {fname}  PDF 1-{first - 1}  {len(front):,} chars")
            for i, (bookmark, start, end) in enumerate(ranges, start=1):
                fname = chapter_filename(bookmark.title, i)
                body = emit_range(doc, start, end, bookmarks, bookmark.title)
                (target / fname).write_text(f"# {bookmark.title}\n\n" + body, encoding="utf-8")
                files.append((bookmark.title, fname))
                print(f"  {fname}  PDF {start}-{end}  {len(body):,} chars")
        else:
            split = "page"
            width = max(3, len(str(doc.page_count)))
            print("no bookmark outline; writing one file per page")
            for p in range(1, doc.page_count + 1):
                fname = f"{p:0{width}d}.md"
                body = emit_range(doc, p, p, [], f"Page {p}")
                heading = f"# Page {p}\n\n"
                (target / fname).write_text(heading + body, encoding="utf-8")
                files.append((f"Page {p}", fname))
                print(f"  {fname}  PDF {p}  {len(body):,} chars")

        (target / "README.md").write_text(
            write_readme(title, pdf, files, split),
            encoding="utf-8",
        )
        print(f"  README.md  {len(files)} files, {doc.page_count} PDF pages")
        print(f"wrote {target}")
        return 0
    finally:
        doc.close()

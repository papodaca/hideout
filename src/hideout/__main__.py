from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _bootstrap() -> None:
    from hideout.config import ensure_config, reload_config

    seeds: list[Path] = []
    for name in ("markdown", "docs"):
        candidate = Path.cwd() / name
        if candidate.is_dir():
            seeds.append(candidate.resolve())
    ensure_config(seeds or None)
    reload_config()


def _print_paths() -> int:
    from hideout.config import get_config
    from hideout.paths import config_path, data_dir, index_dir

    cfg = get_config()
    print(f"config  {config_path()}")
    print(f"data    {data_dir()}")
    print(f"index   {index_dir()}")
    print(f"llm     {cfg.chat_url}")
    print(f"embed   {cfg.embed_url}")
    if cfg.chat_headers:
        print("llm headers  " + ", ".join(f"{name} (set)" for name in cfg.chat_headers))
    if cfg.embed_headers:
        print("embed headers  " + ", ".join(f"{name} (set)" for name in cfg.embed_headers))
    if not cfg.sources:
        print("sources  (none)")
        return 0
    print("sources")
    for path in cfg.sources:
        mark = "ok" if path.is_dir() else "missing"
        print(f"  [{mark}] {path}")
    return 0


def _need_sources() -> bool:
    from hideout.config import get_config
    from hideout.paths import config_path

    cfg = get_config()
    if any(path.is_dir() for path in cfg.sources):
        return True
    print(f"no sources configured. edit {config_path()}", file=sys.stderr)
    return False


def _ensure_ollama() -> int:
    from hideout.ollama import OllamaError, ensure_models

    printed = False

    def status(msg: str) -> None:
        nonlocal printed
        printed = True
        width = 80
        shown = msg if len(msg) <= width else msg[: width - 1] + "…"
        print(f"\r{shown:<{width}}", end="", file=sys.stderr, flush=True)

    try:
        ensure_models(on_status=status)
    except OllamaError as exc:
        if printed:
            print(file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 2
    if printed:
        print(file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    _bootstrap()

    parser = argparse.ArgumentParser(
        prog="hideout",
        description="Ask a local model about markdown libraries (hybrid FTS + embeddings).",
    )
    sub = parser.add_subparsers(dest="cmd", required=False)

    p_tui = sub.add_parser("tui", help="interactive ask prompt (default)")
    p_tui.add_argument("-k", type=int, default=6, help="number of chunks to show")

    p_index = sub.add_parser("index", help="chunk markdown and rebuild the local index")
    p_index.add_argument("--force", action="store_true", help="rebuild even if sources are unchanged")

    p_search = sub.add_parser("search", help="retrieve matching excerpts")
    p_search.add_argument("query", nargs="+")
    p_search.add_argument("-k", type=int, default=6, help="number of chunks to show")
    p_search.add_argument("--json", action="store_true")
    p_search.add_argument(
        "--book",
        action="append",
        dest="books",
        metavar="SLUG",
        help="limit to a book folder; repeat to include several",
    )

    p_ask = sub.add_parser("ask", help="retrieve, then answer with the local model")
    p_ask.add_argument("query", nargs="*")
    p_ask.add_argument("-k", type=int, default=8)
    p_ask.add_argument(
        "--book",
        action="append",
        dest="books",
        metavar="SLUG",
        help="limit to a book folder; repeat to include several",
    )

    sub.add_parser("config", help="print config and data paths")

    p_extract = sub.add_parser("extract", help="convert a PDF to markdown")
    p_extract.add_argument("pdf", type=Path, help="path to a PDF")
    p_extract.add_argument("target", type=Path, help="directory to write markdown into")

    args = parser.parse_args(argv)

    if args.cmd == "config":
        return _print_paths()

    if args.cmd == "extract":
        from hideout.extract import ExtractError, extract_pdf

        try:
            return extract_pdf(args.pdf, args.target)
        except ExtractError as exc:
            print(str(exc), file=sys.stderr)
            return 2

    if not _need_sources() and args.cmd != "index":
        return 2

    from hideout.index import build_index, needs_rebuild
    from hideout.search import format_hit, rrf

    if args.cmd in (None, "tui"):
        from hideout.tui import run

        return run(k=getattr(args, "k", 6))

    if args.cmd in {"index", "search", "ask"}:
        if _ensure_ollama() != 0:
            return 2

    if args.cmd == "index":
        if not _need_sources():
            return 2
        n = build_index(force=args.force)
        print(f"index ready: {n} chunks")
        return 0

    if needs_rebuild():
        print("markdown changed; rebuilding index…", file=sys.stderr)
        build_index(force=True)

    if args.cmd == "search":
        query = " ".join(args.query)
        hits = rrf(query, k=args.k, books=args.books)
        if args.json:
            payload = [
                {
                    "score": hit.score,
                    "book": hit.chunk.book,
                    "file": hit.chunk.file,
                    "chapter": hit.chunk.chapter,
                    "headings": hit.chunk.headings,
                    "page": hit.chunk.page,
                    "printed": hit.chunk.printed,
                    "text": hit.chunk.text,
                }
                for hit in hits
            ]
            json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
            print()
            return 0
        if not hits:
            print("no hits")
            return 1
        for i, hit in enumerate(hits, start=1):
            print(f"--- {i} ---")
            print(format_hit(hit))
            print()
        return 0

    if args.cmd == "ask":
        from hideout.ask import ask

        query = " ".join(args.query).strip()
        if not query:
            print("ask> ", end="", flush=True)
            query = sys.stdin.readline().strip()
            if not query:
                return 1
        answer, hits = ask(query, k=args.k, books=args.books)
        print(answer)
        if hits:
            print("\nSources:")
            for hit in hits:
                c = hit.chunk
                section = " > ".join([c.chapter, *c.headings])
                page = f"p.{c.page}" if c.page else "p.?"
                print(f"  - {c.book} · {c.file} · {section} · PDF {page}")
        return 0

    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

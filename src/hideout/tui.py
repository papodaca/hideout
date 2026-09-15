from __future__ import annotations

import sys
from typing import Callable

from prompt_toolkit import PromptSession
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.formatted_text import HTML
from prompt_toolkit.history import FileHistory
from prompt_toolkit.styles import Style
from rich.cells import cell_len, chop_cells
from rich.console import Console
from rich.markup import escape
from rich.text import Text

from hideout.index import build_index, needs_rebuild
from hideout.ollama import OllamaError
from hideout.paths import data_dir, history_path
from hideout.search import Hit, rrf
from hideout.sets import DocSet, list_sets, load_enabled, parse_set_args, pick_sets, save_enabled

ACCENT = "#ff6b4a"
HELP = """\
  /ask <q>     retrieve, then answer (this is the default; a bare line is an ask)
  /clear       clear the screen
  /help        this list
  /k <n>       number of hits (current session)
  /quit        leave
  /search <q>  print matching excerpts, no model
  /sets        checkbox UI to enable books (alias /books)
  /sets <ids>  enable those slugs, or /sets all

  ctrl+c cancels the current line. ctrl+d leaves.
"""

SLASH = (
    ("/ask", "answer with the local model (default)"),
    ("/clear", "clear the screen"),
    ("/help", "show commands"),
    ("/k", "set number of hits, e.g. /k 8"),
    ("/quit", "leave"),
    ("/search", "print matching excerpts"),
    ("/sets", "enable or disable document sets"),
    ("/books", "same as /sets"),
)

STYLE = Style.from_dict(
    {
        "prompt": ACCENT,
        "bottom-toolbar": "noreverse bg:#161616 #737373",
    }
)


class SlashCompleter(Completer):
    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        if " " in text or not text.startswith("/"):
            return
        for cmd, meta in SLASH:
            if cmd.startswith(text):
                yield Completion(cmd, start_position=-len(text), display_meta=meta)


class WordWrap:
    """Wrap at spaces. Only fold a token if it is wider than the line."""

    def __init__(self, width: int, *, indent: str = "", file=None) -> None:
        self.width = max(8, width)
        self.indent = indent
        self.indent_width = cell_len(indent)
        self.file = file
        self.col = 0
        self.at_line_start = True
        self.pending_space = False
        self.wrapped = False
        self.word: list[str] = []
        self.out: list[str] = []

    def emit(self, s: str) -> None:
        if self.file is not None:
            self.file.write(s)
        else:
            self.out.append(s)

    def newline(self, *, wrapped: bool = False) -> None:
        self.emit("\n")
        self.col = 0
        self.at_line_start = True
        self.pending_space = False
        self.wrapped = wrapped

    def ensure_indent(self) -> None:
        if self.at_line_start and self.indent:
            self.emit(self.indent)
            self.col = self.indent_width
            self.at_line_start = False

    def feed(self, piece: str) -> None:
        for ch in piece:
            if ch == "\n":
                self.flush_word()
                self.newline()
            elif ch == "\r":
                continue
            elif ch.isspace():
                self.flush_word()
                if self.at_line_start:
                    if self.wrapped:
                        continue
                    self.ensure_indent()
                    self.emit(" ")
                    self.col += 1
                    self.at_line_start = False
                else:
                    self.pending_space = True
            else:
                self.word.append(ch)
        if self.file is not None:
            self.file.flush()

    def flush_word(self) -> None:
        if not self.word:
            return
        token = "".join(self.word)
        self.word.clear()
        n = cell_len(token)
        usable = max(1, self.width - self.indent_width)

        if n > usable:
            if not self.at_line_start:
                self.newline(wrapped=True)
            self.ensure_indent()
            for chunk in chop_cells(token, width=usable):
                cn = cell_len(chunk)
                if not self.at_line_start and self.col + cn > self.width:
                    self.newline(wrapped=True)
                    self.ensure_indent()
                self.emit(chunk)
                self.col += cn
                self.at_line_start = False
                if self.col >= self.width:
                    self.newline(wrapped=True)
            return

        extra = 0 if (self.at_line_start or not self.pending_space) else 1
        if not self.at_line_start and self.col + extra + n > self.width:
            self.newline(wrapped=True)
        self.ensure_indent()
        if self.pending_space and not self.at_line_start:
            self.emit(" ")
            self.col += 1
        self.pending_space = False
        self.emit(token)
        self.col += n
        self.at_line_start = False
        if self.col >= self.width:
            self.newline(wrapped=True)

    def finish(self) -> str:
        self.flush_word()
        if self.file is not None:
            self.file.flush()
            return ""
        return "".join(self.out)


def wrap_text(text: str, width: int, *, indent: str = "") -> str:
    w = WordWrap(width, indent=indent)
    w.feed(text)
    return w.finish()


def _wrap_width(console: Console) -> int:
    return max(24, console.width - 1)


def _banner(console: Console, k: int, available: list[DocSet], enabled: set[str]) -> None:
    n = sum(s.n for s in available if s.slug in enabled)
    n_on = len(enabled)
    n_all = len(available)
    console.print(
        f"[bold]Hideout[/]  [dim]·  {n} chunks  ·  "
        f"{n_on}/{n_all} sets  ·  k={k}[/]"
    )
    console.print("[dim]type a question, or /help[/]")
    console.print()


def _toolbar(k: int, n_on: int, n_all: int) -> Callable[[], HTML]:
    def _get() -> HTML:
        return HTML(
            f" k={k}   {n_on}/{n_all} sets   /search   /sets   /help   ctrl+d to leave "
        )

    return _get


def print_hits(console: Console, hits: list[Hit]) -> None:
    if not hits:
        console.print("[dim]no hits[/]")
        console.print()
        return
    for i, hit in enumerate(hits, start=1):
        c = hit.chunk
        section = " > ".join([c.chapter, *c.headings])
        page = f"PDF p.{c.page}" if c.page else "PDF p.?"
        if c.printed is not None:
            page += f" / printed {c.printed}"
        console.print()
        console.print(
            f"  [bold {ACCENT}]{i}[/]  [cyan]{escape(c.book)}[/]"
            f"  [dim]·[/]  {escape(section)}"
        )
        console.print(
            f"     [dim]{escape(c.file)} · {escape(page)} · {hit.score:.3f}[/]"
        )
        console.print()
        body = wrap_text(c.text, _wrap_width(console), indent="     ")
        console.print(body, markup=False, highlight=False, overflow="ignore", no_wrap=True)
    console.print()


def _print_sources(console: Console, hits: list[Hit]) -> None:
    if not hits:
        return
    console.print()
    console.print("[dim]sources[/]")
    for i, hit in enumerate(hits, start=1):
        c = hit.chunk
        section = " > ".join([c.chapter, *c.headings])
        page = f"p.{c.page}" if c.page else "p.?"
        console.print(
            f"  [dim]{i}.[/] [cyan]{escape(c.book)}[/] [dim]· {escape(c.file)} · "
            f"{escape(section)} · PDF {page}[/]"
        )
    console.print()


def _read_line_simple() -> str:
    try:
        return input("❯ ")
    except EOFError:
        raise
    except KeyboardInterrupt:
        print()
        return ""


def _make_session() -> PromptSession:
    data_dir().mkdir(parents=True, exist_ok=True)
    return PromptSession(
        history=FileHistory(str(history_path())),
        auto_suggest=AutoSuggestFromHistory(),
        completer=SlashCompleter(),
        complete_while_typing=True,
        style=STYLE,
        enable_history_search=True,
    )


def _prompt(
    session: PromptSession | None,
    k: int,
    available: list[DocSet],
    enabled: set[str],
) -> str:
    if session is None:
        return _read_line_simple()
    return session.prompt(
        HTML(f'<b><style fg="{ACCENT}">❯</style></b> '),
        bottom_toolbar=_toolbar(k, len(enabled), len(available)),
    )


def _ensure_index(console: Console) -> None:
    if not needs_rebuild():
        return
    console.print("[dim]markdown changed; rebuilding index…[/]")
    build_index(force=True)
    console.print()


def _active_books(available: list[DocSet], enabled: set[str]) -> set[str] | None:
    slugs = {s.slug for s in available}
    if not enabled:
        return set()
    if enabled >= slugs:
        return None
    return enabled


def _print_sets(console: Console, available: list[DocSet], enabled: set[str]) -> None:
    console.print()
    for s in available:
        mark = "x" if s.slug in enabled else " "
        line = Text()
        line.append(f"  [{mark}]  ")
        line.append(s.slug, style="cyan")
        line.append(f"  {s.title}  ")
        line.append(str(s.n), style="dim")
        console.print(line)
    console.print()


def _do_sets(
    console: Console,
    available: list[DocSet],
    enabled: set[str],
    rest: str,
) -> set[str]:
    if rest:
        picked, err = parse_set_args(rest, available)
        if err:
            console.print(f"[dim]{escape(err)}[/]")
            console.print()
            return enabled
        save_enabled(picked)
        _print_sets(console, available, picked)
        return picked
    picked = pick_sets(available, enabled)
    if picked is None:
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            _print_sets(console, available, enabled)
            console.print("[dim]run in a terminal for the checkbox UI, or /sets slug ...[/]")
            console.print()
        return enabled
    save_enabled(picked)
    _print_sets(console, available, picked)
    return picked


def _do_search(
    console: Console,
    query: str,
    k: int,
    books: set[str] | None,
) -> None:
    try:
        with console.status("[dim]searching[/]", spinner="dots"):
            hits = rrf(query, k=k, books=books)
    except OllamaError as exc:
        console.print(f"[red]{escape(str(exc))}[/]")
        console.print()
        return
    print_hits(console, hits)


def _do_ask(
    console: Console,
    query: str,
    k: int,
    books: set[str] | None,
) -> None:
    from hideout.ask import prompt_messages
    from hideout.ollama import chat

    try:
        with console.status("[dim]retrieving[/]", spinner="dots"):
            hits = rrf(query, k=k, books=books)
    except OllamaError as exc:
        console.print(f"[red]{escape(str(exc))}[/]")
        console.print()
        return
    if not hits:
        console.print("[dim]no hits[/]")
        console.print()
        return
    console.print()
    try:
        stream = WordWrap(_wrap_width(console), file=console.file)
        for piece in chat(prompt_messages(query, hits), stream=True):
            stream.feed(piece)
        stream.finish()
    except OllamaError as exc:
        console.print(f"[red]{escape(str(exc))}[/]")
        console.print()
        return
    console.print()
    _print_sources(console, hits)


def run(k: int = 6) -> int:
    console = Console()
    try:
        _ensure_index(console)
    except SystemExit as exc:
        msg = exc.args[0] if exc.args else "index failed"
        console.print(f"[red]{escape(str(msg))}[/]")
        return 1

    available = list_sets()
    enabled = load_enabled(available)

    session: PromptSession | None = None
    if sys.stdin.isatty() and sys.stdout.isatty():
        session = _make_session()

    _banner(console, k, available, enabled)

    while True:
        try:
            raw = _prompt(session, k, available, enabled)
        except KeyboardInterrupt:
            console.print("[dim]^C[/]")
            continue
        except EOFError:
            console.print()
            return 0

        line = raw.strip()
        if not line:
            continue

        low = line.lower()
        books = _active_books(available, enabled)
        if low in {"/q", "/quit", "/exit"}:
            return 0
        if low in {"/help", "/?"}:
            console.print()
            console.print(HELP)
            continue
        if low == "/clear":
            console.clear()
            _banner(console, k, available, enabled)
            continue
        if low in {"/sets", "/books"} or low.startswith("/sets ") or low.startswith("/books "):
            rest = line.split(None, 1)[1] if " " in line else ""
            enabled = _do_sets(console, available, enabled, rest)
            continue
        if low == "/k" or low.startswith("/k "):
            rest = line[2:].strip()
            if not rest.isdigit() or int(rest) < 1:
                console.print("[dim]usage: /k 8[/]")
                console.print()
                continue
            k = int(rest)
            console.print(f"[dim]k={k}[/]")
            console.print()
            continue
        if low == "/ask" or low.startswith("/ask "):
            query = line[4:].strip()
            if not query:
                console.print("[dim]usage: /ask who is Cuckoo[/]")
                console.print()
                continue
            _do_ask(console, query, k, books)
            continue
        if low == "/search" or low.startswith("/search "):
            query = line[7:].strip()
            if not query:
                console.print("[dim]usage: /search Hovgårdsfjärden[/]")
                console.print()
                continue
            _do_search(console, query, k, books)
            continue

        _do_ask(console, line, k, books)


if __name__ == "__main__":
    raise SystemExit(run())

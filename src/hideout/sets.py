from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

from hideout.chunk import source_roots
from hideout.index import connect
from hideout.paths import data_dir, sets_path


@dataclass(frozen=True)
class DocSet:
    slug: str
    title: str
    n: int


def _heading_from(readme: Path) -> str | None:
    if not readme.is_file():
        return None
    for line in readme.read_text(encoding="utf-8").splitlines():
        if line.startswith("# "):
            return (
                line[2:]
                .strip()
                .replace("\u2014", "-")
                .replace("\u2013", "-")
            )
    return None


def _title_for(slug: str) -> str:
    parts = Path(*slug.split("/"))
    for root in source_roots():
        heading = _heading_from(root / parts / "README.md")
        if heading:
            return heading
        if slug == root.name:
            heading = _heading_from(root / "README.md")
            if heading:
                return heading
    return slug.replace("_", " ").replace("/", " / ")


def list_sets() -> list[DocSet]:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT book, COUNT(*) AS n FROM chunks GROUP BY book ORDER BY book"
        ).fetchall()
    finally:
        conn.close()
    return [DocSet(slug=r["book"], title=_title_for(r["book"]), n=int(r["n"])) for r in rows]


def load_enabled(available: list[DocSet]) -> set[str]:
    slugs = {s.slug for s in available}
    path = sets_path()
    if not slugs:
        return set()
    if not path.is_file():
        return set(slugs)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set(slugs)
    enabled = {str(x) for x in (data.get("enabled") or [])} & slugs
    return enabled or set(slugs)


def save_enabled(enabled: set[str]) -> None:
    data_dir().mkdir(parents=True, exist_ok=True)
    sets_path().write_text(
        json.dumps({"enabled": sorted(enabled)}, indent=2) + "\n",
        encoding="utf-8",
    )


def parse_set_args(rest: str, available: list[DocSet]) -> tuple[set[str] | None, str | None]:
    """Return (enabled, error). 'all' enables every set."""
    slugs = {s.slug for s in available}
    parts = [p for p in rest.replace(",", " ").split() if p]
    if not parts:
        return None, "usage: /sets slug [slug ...]  (or /sets all)"
    if len(parts) == 1 and parts[0].lower() == "all":
        return set(slugs), None
    unknown = [p for p in parts if p not in slugs]
    if unknown:
        known = ", ".join(sorted(slugs))
        return None, f"unknown set: {', '.join(unknown)}\n  known: {known}"
    return set(parts), None


def pick_sets(available: list[DocSet], enabled: set[str]) -> set[str] | None:
    """Full-screen checkbox list. None means cancelled."""
    if not available:
        return set()
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        return None
    return _sets_app(available, enabled).run()


def _sets_app(available: list[DocSet], enabled: set[str], **kwargs):
    from prompt_toolkit.application import Application
    from prompt_toolkit.key_binding import KeyBindings
    from prompt_toolkit.layout import Layout
    from prompt_toolkit.layout.containers import HSplit
    from prompt_toolkit.layout.dimension import Dimension as D
    from prompt_toolkit.styles import Style
    from prompt_toolkit.widgets import Box, CheckboxList, Frame, Label

    values = [(s.slug, f"{s.title}   {s.n} chunks") for s in available]
    defaults = [s.slug for s in available if s.slug in enabled]
    cb = CheckboxList(
        values=values,
        default_values=defaults or [available[0].slug],
        select_character="x",
    )

    kb = KeyBindings()

    @kb.add("enter", eager=True)
    def _save(event) -> None:
        if not cb.current_values:
            return
        event.app.exit(result=set(cb.current_values))

    @kb.add("escape", eager=True)
    @kb.add("c-c", eager=True)
    def _cancel(event) -> None:
        event.app.exit(result=None)

    body = HSplit(
        [
            Label("space checks a set. enter saves. esc cancels."),
            cb,
        ],
        padding=1,
        height=D(min=len(available) + 4),
    )
    root = Box(Frame(body, title="document sets"), padding=1)
    style = Style.from_dict(
        {
            "frame.border": "#444444",
            "frame.label": "#ff6b4a",
            "checkbox": "#e5e5e5",
            "checkbox-selected": "bg:#1c1c1c",
            "checkbox-checked": "#ff6b4a",
            "label": "#737373",
        }
    )
    return Application(
        layout=Layout(root, focused_element=cb),
        key_bindings=kb,
        style=style,
        full_screen=kwargs.pop("full_screen", True),
        mouse_support=kwargs.pop("mouse_support", True),
        **kwargs,
    )

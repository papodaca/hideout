from __future__ import annotations

import sys
from dataclasses import replace

from hideout.config import (
    DEFAULT_BASE_URL,
    Config,
    format_header_text,
    get_config,
    parse_header_text,
    parse_source_text,
)


def edit_config(cfg: Config | None = None) -> Config | None:
    """Full-screen editor for models, API endpoints, and sources. None means cancelled."""
    cfg = cfg or get_config()
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        return None
    return _config_app(cfg).run()


def _line(text: str, completer=None):
    from prompt_toolkit.layout.dimension import Dimension as D
    from prompt_toolkit.widgets import TextArea

    return TextArea(
        text=text,
        multiline=False,
        height=D.exact(1),
        completer=completer,
        complete_while_typing=bool(completer),
        focus_on_click=True,
    )


def _box(text: str, *, min_height: int, preferred: int):
    from prompt_toolkit.layout.dimension import Dimension as D
    from prompt_toolkit.widgets import TextArea

    return TextArea(
        text=text,
        multiline=True,
        scrollbar=True,
        height=D(min=min_height, preferred=preferred),
        focus_on_click=True,
        wrap_lines=False,
    )


def _config_app(cfg: Config, **kwargs):
    from prompt_toolkit.application import Application
    from prompt_toolkit.completion import WordCompleter
    from prompt_toolkit.key_binding import KeyBindings
    from prompt_toolkit.key_binding.bindings.focus import focus_next, focus_previous
    from prompt_toolkit.layout import Layout
    from prompt_toolkit.layout.containers import HSplit
    from prompt_toolkit.styles import Style
    from prompt_toolkit.widgets import Box, Frame, Label

    from hideout.ollama import list_models

    models = list_models()
    completer = (
        WordCompleter(models, ignore_case=True, match_middle=True, sentence=True)
        if models
        else None
    )
    model = _line(cfg.chat_model, completer)
    llm_url = _line(cfg.chat_url)
    embed_url = _line(cfg.embed_url)
    llm_headers = _box(format_header_text(cfg.chat_headers), min_height=3, preferred=4)
    embed_headers = _box(format_header_text(cfg.embed_headers), min_height=3, preferred=4)
    sources = _box(
        "\n".join(str(path) for path in cfg.sources),
        min_height=4,
        preferred=6,
    )
    single = {model.window, llm_url.window, embed_url.window}

    def collect() -> Config | None:
        name = model.text.strip()
        if not name:
            return None
        chat_url = llm_url.text.strip() or DEFAULT_BASE_URL
        embed = embed_url.text.strip() or chat_url
        return replace(
            cfg,
            chat_model=name,
            chat_url=chat_url,
            embed_url=embed,
            chat_headers=parse_header_text(llm_headers.text),
            embed_headers=parse_header_text(embed_headers.text),
            sources=parse_source_text(sources.text),
        )

    kb = KeyBindings()
    kb.add("tab")(focus_next)
    kb.add("s-tab")(focus_previous)

    @kb.add("c-s", eager=True)
    def _save(event) -> None:
        result = collect()
        if result is None:
            return
        event.app.exit(result=result)

    @kb.add("enter", eager=True)
    def _enter(event) -> None:
        if event.app.layout.current_window in single:
            result = collect()
            if result is not None:
                event.app.exit(result=result)
            return
        event.app.current_buffer.newline(copy_margin=False)

    @kb.add("escape", eager=True)
    @kb.add("c-c", eager=True)
    def _cancel(event) -> None:
        event.app.exit(result=None)

    hint = "tab switches fields. ctrl+s saves. esc cancels."
    if models:
        hint = f"{len(models)} models for tab-complete. " + hint

    body = HSplit(
        [
            Label(hint),
            Label("chat model"),
            model,
            Label("llm url"),
            llm_url,
            Label("llm headers  (Name: value, one per line)"),
            llm_headers,
            Label("embed url"),
            embed_url,
            Label("embed headers  (Name: value, one per line)"),
            embed_headers,
            Label("sources  (one directory per line)"),
            sources,
        ],
        padding=0,
    )
    root = Box(Frame(body, title="config"), padding=1)
    style = Style.from_dict(
        {
            "frame.border": "#444444",
            "frame.label": "#ff6b4a",
            "label": "#737373",
            "text-area": "#e5e5e5",
        }
    )
    return Application(
        layout=Layout(root, focused_element=model),
        key_bindings=kb,
        style=style,
        full_screen=kwargs.pop("full_screen", True),
        mouse_support=kwargs.pop("mouse_support", True),
        **kwargs,
    )

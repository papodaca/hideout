from __future__ import annotations

import tomllib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from hideout.paths import config_dir, config_path

DEFAULT_CHAT_MODEL = "ornith-1.5:9b"
DEFAULT_EMBED_MODEL = "nomic-embed-text"
DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"
DEFAULT_SYSTEM = """\
You answer only from the excerpts. If they do not contain the answer, say so.
After each claim, cite book, file, section, and page from the excerpt labels.
Be direct. No preamble. Do not invent scenes, stats, or facts that are not in the excerpts.\
"""
MAX_CHARS = 2800
MIN_CHARS = 80
OVERLAP_CHARS = 200


@dataclass(frozen=True)
class Config:
    sources: list[Path]
    chat_model: str = DEFAULT_CHAT_MODEL
    embed_model: str = DEFAULT_EMBED_MODEL
    ollama_host: str = DEFAULT_OLLAMA_HOST
    system_prompt: str = DEFAULT_SYSTEM
    max_chars: int = MAX_CHARS
    min_chars: int = MIN_CHARS
    overlap_chars: int = OVERLAP_CHARS


def _toml_string(value: str) -> str:
    return '"""\n' + value.strip() + '\n"""'


def default_toml(sources: list[Path] | None = None) -> str:
    lines = [
        "# Hideout",
        "#",
        f"# This file: {config_path()}",
        "# Index and history live under $XDG_DATA_HOME/hideout/",
        "# (default: ~/.local/share/hideout/).",
        "",
        f'chat_model = "{DEFAULT_CHAT_MODEL}"',
        f'embed_model = "{DEFAULT_EMBED_MODEL}"',
        f'ollama_host = "{DEFAULT_OLLAMA_HOST}"',
        "",
        "system_prompt = " + _toml_string(DEFAULT_SYSTEM),
        "",
        "# Markdown directories to index. Each subfolder is a document set.",
        "sources = [",
    ]
    for src in sources or []:
        lines.append(f'  "{src}",')
    lines.append("]")
    lines.append("")
    return "\n".join(lines)


def ensure_config(seed_sources: list[Path] | None = None) -> Path:
    path = config_path()
    if path.is_file():
        return path
    config_dir().mkdir(parents=True, exist_ok=True)
    path.write_text(default_toml(seed_sources), encoding="utf-8")
    return path


def _as_path_list(raw: object) -> list[Path]:
    if raw is None:
        return []
    if isinstance(raw, str):
        items = [raw]
    elif isinstance(raw, list):
        items = [str(x) for x in raw]
    else:
        return []
    out: list[Path] = []
    seen: set[Path] = set()
    for item in items:
        p = Path(item).expanduser()
        try:
            p = p.resolve()
        except OSError:
            p = p.expanduser().absolute()
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


def load_config(path: Path | None = None) -> Config:
    cfg_path = path or config_path()
    if not cfg_path.is_file():
        return Config(sources=[])
    data = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    return Config(
        sources=_as_path_list(data.get("sources")),
        chat_model=str(data.get("chat_model") or DEFAULT_CHAT_MODEL),
        embed_model=str(data.get("embed_model") or DEFAULT_EMBED_MODEL),
        ollama_host=str(data.get("ollama_host") or DEFAULT_OLLAMA_HOST),
        system_prompt=str(data.get("system_prompt") or DEFAULT_SYSTEM).strip(),
        max_chars=int(data.get("max_chars") or MAX_CHARS),
        min_chars=int(data.get("min_chars") or MIN_CHARS),
        overlap_chars=int(data.get("overlap_chars") or OVERLAP_CHARS),
    )


@lru_cache(maxsize=1)
def get_config() -> Config:
    return load_config()


def reload_config() -> Config:
    get_config.cache_clear()
    return get_config()

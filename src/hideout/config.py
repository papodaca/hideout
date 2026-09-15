from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from hideout.paths import config_dir, config_path

DEFAULT_CHAT_MODEL = "ornith-1.5:9b"
DEFAULT_EMBED_MODEL = "nomic-embed-text"
DEFAULT_BASE_URL = "http://127.0.0.1:11434"
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
    chat_url: str = DEFAULT_BASE_URL
    embed_url: str = DEFAULT_BASE_URL
    chat_headers: dict[str, str] = field(default_factory=dict)
    embed_headers: dict[str, str] = field(default_factory=dict)
    system_prompt: str = DEFAULT_SYSTEM
    max_chars: int = MAX_CHARS
    min_chars: int = MIN_CHARS
    overlap_chars: int = OVERLAP_CHARS


def _toml_string(value: str) -> str:
    return '"""\n' + value.strip() + '\n"""'


def default_toml(sources: list[Path] | None = None) -> str:
    return dump_toml(Config(sources=list(sources or [])))


def _toml_quoted(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def dump_toml(cfg: Config) -> str:
    lines = [
        "# Hideout",
        "#",
        f"# This file: {config_path()}",
        "# Index and history live under $XDG_DATA_HOME/hideout/",
        "# (default: ~/.local/share/hideout/).",
        "",
        f"chat_model = {_toml_quoted(cfg.chat_model)}",
        f"embed_model = {_toml_quoted(cfg.embed_model)}",
        f"chat_url = {_toml_quoted(cfg.chat_url)}",
        f"embed_url = {_toml_quoted(cfg.embed_url)}",
        "",
        "system_prompt = " + _toml_string(cfg.system_prompt),
        "",
        "# Markdown directories to index. Each subfolder is a document set.",
        "sources = [",
    ]
    for src in cfg.sources:
        lines.append(f"  {_toml_quoted(str(src))},")
    lines.append("]")
    lines.append("")
    _dump_header_table(lines, "chat_headers", cfg.chat_headers)
    _dump_header_table(lines, "embed_headers", cfg.embed_headers)
    return "\n".join(lines).rstrip() + "\n"


def _dump_header_table(lines: list[str], name: str, headers: dict[str, str]) -> None:
    if not headers:
        return
    lines.append(f"[{name}]")
    for key in sorted(headers):
        lines.append(f"{_toml_quoted(key)} = {_toml_quoted(headers[key])}")
    lines.append("")


def write_config(cfg: Config) -> None:
    config_dir().mkdir(parents=True, exist_ok=True)
    config_path().write_text(dump_toml(cfg), encoding="utf-8")


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


def parse_source_text(text: str) -> list[Path]:
    lines = [line.strip() for line in text.splitlines()]
    lines = [line for line in lines if line and not line.startswith("#")]
    return _as_path_list(lines)


def parse_header_text(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            name, _, value = line.partition(":")
        elif "=" in line:
            name, _, value = line.partition("=")
        else:
            continue
        name = name.strip()
        if name:
            out[name] = value.strip()
    return out


def format_header_text(headers: dict[str, str]) -> str:
    return "\n".join(f"{key}: {headers[key]}" for key in headers)


def _as_header_map(raw: object) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in raw.items():
        name = str(key).strip()
        if name:
            out[name] = str(value)
    return out


def load_config(path: Path | None = None) -> Config:
    cfg_path = path or config_path()
    if not cfg_path.is_file():
        return Config(sources=[])
    data = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    legacy = str(data.get("ollama_host") or DEFAULT_BASE_URL)
    chat_url = str(data.get("chat_url") or data.get("llm_url") or legacy)
    embed_url = str(data.get("embed_url") or chat_url)
    return Config(
        sources=_as_path_list(data.get("sources")),
        chat_model=str(data.get("chat_model") or DEFAULT_CHAT_MODEL),
        embed_model=str(data.get("embed_model") or DEFAULT_EMBED_MODEL),
        chat_url=chat_url,
        embed_url=embed_url,
        chat_headers=_as_header_map(data.get("chat_headers")),
        embed_headers=_as_header_map(data.get("embed_headers")),
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

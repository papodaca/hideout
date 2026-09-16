from __future__ import annotations

import os
from pathlib import Path

APP = "hideout"


def _home() -> Path:
    return Path.home()


def config_dir() -> Path:
    raw = os.environ.get("XDG_CONFIG_HOME", "").strip()
    base = Path(raw) if raw else _home() / ".config"
    return base / APP


def data_dir() -> Path:
    raw = os.environ.get("XDG_DATA_HOME", "").strip()
    base = Path(raw) if raw else _home() / ".local" / "share"
    return base / APP


def config_path() -> Path:
    return config_dir() / "config.toml"


def index_dir() -> Path:
    return data_dir() / "index"


def pglite_dir() -> Path:
    return data_dir() / "pglite"


def history_path() -> Path:
    return data_dir() / "history"


def sets_path() -> Path:
    return data_dir() / "sets.json"

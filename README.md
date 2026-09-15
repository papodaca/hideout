# Hideout

A terminal for asking questions against markdown libraries. Hybrid search (SQLite FTS + a local zvec index) via a local model.

## Install

Python 3.11 or newer has to be on PATH. Ask and search need an OpenAI-compatible `/v1/chat/completions` and `/v1/embeddings` server. Ollama exposes those at `http://127.0.0.1:11434/v1`.

```
curl -L https://github.com/papodaca/hideout/raw/refs/heads/main/install.sh | bash
```

From a clone, run `./install.sh` instead. It installs the tree you have checked out.

Either path creates `~/.venv/hideout` and links `hideout` into `~/.local/bin`. If that directory is not on PATH, the script adds it to your shell rc. Re-run to refresh.

```
hideout
hideout extract book.pdf markdown/book
hideout index
hideout search "your query"
```

`extract` splits a PDF by its bookmark outline. If the file has no bookmarks, it writes one markdown file per page.

Type a question at the prompt. `/search` prints raw hits. `/config` edits the chat model, API urls, headers, and source directories. `/help` lists commands.

The venv lives at `~/.venv/hideout` if you want to activate it yourself. `HIDEOUT_PYTHON`, `HIDEOUT_VENV`, and `HIDEOUT_BIN_DIR` override the interpreter, venv path, and link location.

## Paths

Config: `$XDG_CONFIG_HOME/hideout/config.toml` (default `~/.config/hideout/config.toml`)

Index, set toggles, and prompt history: `$XDG_DATA_HOME/hideout/` (default `~/.local/share/hideout/`)

First run writes a config if none exists. If `./markdown` or `./docs` is present, those get added as sources. Otherwise point `sources` at one or more markdown directories. Subfolders become document sets you can toggle with `/sets`.

```toml
chat_model = "ornith-1.5:9b"
embed_model = "nomic-embed-text"
chat_url = "http://127.0.0.1:11434/v1"
embed_url = "http://127.0.0.1:11434/v1"
banner = true

sources = [
  "/path/to/your/markdown",
]

# [chat_headers]
# "Authorization" = "Bearer ..."
#
# [embed_headers]
# "Authorization" = "Bearer ..."
```

# Hideout

A terminal for asking questions against markdown libraries. Hybrid search (FTS + embeddings) via a local Ollama model.

## Paths

Config: `$XDG_CONFIG_HOME/hideout/config.toml` (default `~/.config/hideout/config.toml`)

Index, set toggles, and prompt history: `$XDG_DATA_HOME/hideout/` (default `~/.local/share/hideout/`)

First run writes a config if none exists. If `./markdown` or `./docs` is present, those get added as sources. Otherwise point `sources` at one or more markdown directories. Subfolders become document sets you can toggle with `/sets`.

```toml
chat_model = "ornith-1.5:9b"
embed_model = "nomic-embed-text"
chat_url = "http://127.0.0.1:11434"
embed_url = "http://127.0.0.1:11434"

sources = [
  "/path/to/your/markdown",
]

# [chat_headers]
# "Authorization" = "Bearer ..."
#
# [embed_headers]
# "Authorization" = "Bearer ..."
```

## Run

From this repo, venv on:

```
pip install -e .
python -m hideout
python -m hideout index
python -m hideout search "your query"
```

Type a question at the prompt. `/search` prints raw hits. `/config` edits the chat model, API urls, headers, and source directories. `/help` lists commands.

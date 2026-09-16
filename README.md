# Hideout

A terminal for asking questions against markdown libraries. Hybrid search (BM25 + pgvector) in one local PGlite database, via a local model.

## Install

Node.js 20+ has to be on PATH. Ask and search need an OpenAI-compatible `/v1/chat/completions` and `/v1/embeddings` server. Ollama exposes those at `http://127.0.0.1:11434/v1`.

```
npx @papodaca/hideout
```

From a clone:

```
npm install && npm run build && node dist/cli.js
```

That also puts `hideout` on PATH if you `npm link`, or you can run `npx @papodaca/hideout` after publish.

```
hideout
hideout extract book.pdf markdown/book
hideout index
hideout search "your query"
```

`extract` splits a PDF by its bookmark outline. If the file has no bookmarks, it writes one markdown file per page.

Type a question at the prompt. `/search` prints raw hits. `/config` edits the chat model, API urls, headers, and source directories. `/help` lists commands.

## Paths

Config: `$XDG_CONFIG_HOME/hideout/config.json` (default `~/.config/hideout/config.json`)

Index (PGlite + pgvector), set toggles, and prompt history: `$XDG_DATA_HOME/hideout/` (default `~/.local/share/hideout/`). First launch applies schema migrations. Prompt history lives in the PGlite database; the TUI loads the last 50 lines so up-arrow works.

First run writes a config if none exists. If `./markdown` or `./docs` is present, those get added as sources. Otherwise point `sources` at one or more markdown directories. Subfolders become document sets you can toggle with `/sets`.

```json
{
  "chat_model": "ornith-1.5:9b",
  "embed_model": "nomic-embed-text",
  "chat_url": "http://127.0.0.1:11434/v1",
  "embed_url": "http://127.0.0.1:11434/v1",
  "banner": true,
  "sources": [
    "/path/to/your/markdown"
  ],
  "chat_headers": {
    "Authorization": "Bearer ${API_KEY}"
  },
  "embed_headers": {
    "Authorization": "Bearer ${API_KEY}"
  }
}
```

Header values expand `${ENV_VAR}` from the environment.

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Iterator

from hideout.config import get_config


class OllamaError(RuntimeError):
    pass


def _post(path: str, payload: dict, timeout: int = 120) -> dict:
    host = get_config().ollama_host.rstrip("/")
    req = urllib.request.Request(
        f"{host}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.URLError as exc:
        raise OllamaError(
            f"Ollama is not reachable at {host}. Start it, then retry."
        ) from exc


def embed(texts: list[str], *, query: bool = False) -> list[list[float]]:
    prefix = "search_query: " if query else "search_document: "
    payload = {
        "model": get_config().embed_model,
        "input": [prefix + t for t in texts],
    }
    data = _post("/api/embed", payload, timeout=180)
    vectors = data.get("embeddings")
    if not vectors:
        raise OllamaError(f"embed failed: {data}")
    return vectors


def chat(messages: list[dict], *, stream: bool = True) -> Iterator[str]:
    cfg = get_config()
    payload = {
        "model": cfg.chat_model,
        "messages": messages,
        "stream": stream,
        "think": False,
        "options": {"temperature": 0.2},
    }
    host = cfg.ollama_host.rstrip("/")
    req = urllib.request.Request(
        f"{host}/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=300)
    except urllib.error.URLError as exc:
        raise OllamaError(
            f"Ollama is not reachable at {host}. Start it, then retry."
        ) from exc
    if not stream:
        data = json.loads(resp.read().decode())
        yield data.get("message", {}).get("content", "")
        return
    with resp:
        for raw in resp:
            line = raw.decode().strip()
            if not line:
                continue
            event = json.loads(line)
            piece = event.get("message", {}).get("content") or ""
            if piece:
                yield piece
            if event.get("done"):
                break

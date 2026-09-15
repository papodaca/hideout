from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Iterator

from hideout.config import get_config


class OllamaError(RuntimeError):
    pass


def _headers(extra: dict[str, str] | None) -> dict[str, str]:
    hdrs = {"Content-Type": "application/json"}
    if extra:
        for key, value in extra.items():
            hdrs[str(key)] = str(value)
    return hdrs


def _open(
    url: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str],
    method: str,
    timeout: int,
):
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.URLError as exc:
        raise OllamaError(
            f"API is not reachable at {url}. Check chat_url / embed_url and retry."
        ) from exc


def list_models() -> list[str]:
    cfg = get_config()
    url = cfg.chat_url.rstrip("/") + "/api/tags"
    try:
        with _open(
            url,
            headers=_headers(cfg.chat_headers),
            method="GET",
            timeout=5,
        ) as resp:
            data = json.loads(resp.read().decode())
    except (OllamaError, TimeoutError, json.JSONDecodeError, OSError):
        return []
    names: list[str] = []
    for item in data.get("models") or []:
        name = item.get("name") if isinstance(item, dict) else None
        if name:
            names.append(str(name))
    return sorted(set(names))


def _post(
    base: str,
    path: str,
    payload: dict,
    headers: dict[str, str],
    timeout: int = 120,
) -> dict:
    url = base.rstrip("/") + path
    with _open(
        url,
        data=json.dumps(payload).encode(),
        headers=_headers(headers),
        method="POST",
        timeout=timeout,
    ) as resp:
        return json.loads(resp.read().decode())


def embed(texts: list[str], *, query: bool = False) -> list[list[float]]:
    cfg = get_config()
    prefix = "search_query: " if query else "search_document: "
    payload = {
        "model": cfg.embed_model,
        "input": [prefix + t for t in texts],
    }
    data = _post(cfg.embed_url, "/api/embed", payload, cfg.embed_headers, timeout=180)
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
    url = cfg.chat_url.rstrip("/") + "/api/chat"
    resp = _open(
        url,
        data=json.dumps(payload).encode(),
        headers=_headers(cfg.chat_headers),
        method="POST",
        timeout=300,
    )
    if not stream:
        data = json.loads(resp.read().decode())
        resp.close()
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

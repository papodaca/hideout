from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Iterator

from hideout.config import get_config


class OllamaError(RuntimeError):
    pass


def api_base(url: str) -> str:
    url = url.rstrip("/")
    if url.endswith("/v1"):
        return url
    return url + "/v1"


def _endpoint(base: str, path: str) -> str:
    return api_base(base) + path


def _headers(extra: dict[str, str] | None) -> dict[str, str]:
    hdrs = {"Content-Type": "application/json"}
    if extra:
        for key, value in extra.items():
            hdrs[str(key)] = str(value)
    return hdrs


def _http_message(exc: urllib.error.HTTPError) -> str:
    try:
        body = exc.read().decode(errors="replace").strip()
    except OSError:
        body = ""
    if not body:
        return exc.reason or str(exc.code)
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return body[:400]
    err = data.get("error")
    if isinstance(err, dict) and err.get("message"):
        return str(err["message"])
    if isinstance(err, str):
        return err
    return body[:400]


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
    except urllib.error.HTTPError as exc:
        raise OllamaError(f"{exc.code} {_http_message(exc)} ({url})") from exc
    except urllib.error.URLError as exc:
        raise OllamaError(
            f"API is not reachable at {url}. Check chat_url / embed_url and retry."
        ) from exc


def list_models() -> list[str]:
    cfg = get_config()
    url = _endpoint(cfg.chat_url, "/models")
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
    for item in data.get("data") or []:
        name = item.get("id") if isinstance(item, dict) else None
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
    url = _endpoint(base, path)
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
    data = _post(cfg.embed_url, "/embeddings", payload, cfg.embed_headers, timeout=180)
    rows = [row for row in (data.get("data") or []) if isinstance(row, dict)]
    rows.sort(key=lambda row: int(row.get("index") or 0))
    vectors = [row["embedding"] for row in rows if "embedding" in row]
    if len(vectors) != len(texts):
        raise OllamaError(f"embed failed: {data}")
    return vectors


def _choice_text(event: dict) -> str:
    choices = event.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        return ""
    choice = choices[0]
    delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    content = delta.get("content")
    if content is None:
        content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                parts.append(str(part.get("text") or ""))
        return "".join(parts)
    return ""


def _iter_sse(resp) -> Iterator[str]:
    for raw in resp:
        line = raw.decode().strip()
        if not line:
            continue
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line or line == "[DONE]":
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        piece = _choice_text(event)
        if piece:
            yield piece


def chat(messages: list[dict], *, stream: bool = True) -> Iterator[str]:
    cfg = get_config()
    payload = {
        "model": cfg.chat_model,
        "messages": messages,
        "stream": stream,
        "temperature": 0.2,
    }
    url = _endpoint(cfg.chat_url, "/chat/completions")
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
        yield _choice_text(data)
        return
    with resp:
        yield from _iter_sse(resp)

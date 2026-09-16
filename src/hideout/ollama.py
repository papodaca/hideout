from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator

from hideout.config import get_config


class OllamaError(RuntimeError):
    pass


def api_base(url: str) -> str:
    url = url.rstrip("/")
    if url.endswith("/v1"):
        return url
    return url + "/v1"


def native_api_base(url: str) -> str:
    url = url.rstrip("/")
    if url.endswith("/v1"):
        return url[: -len("/v1")].rstrip("/")
    return url


def _canonical_model(name: str) -> str:
    name = name.strip()
    return name if ":" in name else f"{name}:latest"


def model_installed(name: str, names: list[str]) -> bool:
    want = _canonical_model(name)
    return any(_canonical_model(have) == want for have in names)


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


def list_native_models(base: str, headers: dict[str, str] | None) -> list[str] | None:
    url = native_api_base(base).rstrip("/") + "/api/tags"
    try:
        with _open(
            url,
            headers=_headers(headers),
            method="GET",
            timeout=5,
        ) as resp:
            data = json.loads(resp.read().decode())
    except (OllamaError, TimeoutError, json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict) or "models" not in data:
        return None
    names: list[str] = []
    for item in data.get("models") or []:
        name = item.get("name") if isinstance(item, dict) else None
        if name:
            names.append(str(name))
    return names


def _needed_models() -> list[tuple[str, dict[str, str], str]]:
    cfg = get_config()
    seen: set[tuple[str, str]] = set()
    out: list[tuple[str, dict[str, str], str]] = []
    for url, headers, model in (
        (cfg.chat_url, cfg.chat_headers, cfg.chat_model),
        (cfg.embed_url, cfg.embed_headers, cfg.embed_model),
    ):
        name = model.strip()
        if not name:
            continue
        key = (native_api_base(url), name)
        if key in seen:
            continue
        seen.add(key)
        out.append((url, headers, name))
    return out


def models_to_pull() -> list[tuple[str, dict[str, str], str]]:
    missing: list[tuple[str, dict[str, str], str]] = []
    cache: dict[str, list[str] | None] = {}
    for url, headers, name in _needed_models():
        base = native_api_base(url)
        if base not in cache:
            cache[base] = list_native_models(url, headers)
        installed = cache[base]
        if installed is None:
            continue
        if not model_installed(name, installed):
            missing.append((url, headers, name))
    return missing


def pull_model(
    name: str,
    *,
    base: str,
    headers: dict[str, str] | None = None,
    on_status: Callable[[str], None] | None = None,
) -> None:
    url = native_api_base(base).rstrip("/") + "/api/pull"
    payload = {"model": name, "name": name, "stream": True}
    resp = _open(
        url,
        data=json.dumps(payload).encode(),
        headers=_headers(headers),
        method="POST",
        timeout=3600,
    )
    with resp:
        while True:
            raw = resp.readline()
            if not raw:
                break
            line = raw.decode().strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            err = event.get("error")
            if err:
                raise OllamaError(f"could not pull {name}: {err}")
            status = str(event.get("status") or "").strip()
            if not status:
                continue
            total = event.get("total")
            done = event.get("completed")
            if total:
                pct = int(100 * int(done or 0) / int(total))
                msg = f"pulling {name}: {status} {pct}%"
            else:
                msg = f"pulling {name}: {status}"
            if on_status:
                on_status(msg)


def ensure_models(
    on_status: Callable[[str], None] | None = None,
    jobs: list[tuple[str, dict[str, str], str]] | None = None,
) -> None:
    for url, headers, name in jobs if jobs is not None else models_to_pull():
        if on_status:
            on_status(f"pulling {name}")
        pull_model(name, base=url, headers=headers, on_status=on_status)


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

"""Small server-side Meta Responses adapter; no SDK or runtime dependency."""
from __future__ import annotations

import json
import os
from pathlib import Path
import urllib.error
import urllib.request


class ProviderError(RuntimeError):
    """Safe error code, deliberately excluding provider bodies and credentials."""


def load_env(path: Path) -> None:
    """Read plain KEY=value entries without evaluating shell expressions."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if key.startswith("export "):
            key = key[7:].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key.replace("_", "a").isalnum():
            os.environ.setdefault(key, value)


def parse_output(data: dict) -> dict:
    if data.get("status") != "completed":
        raise ProviderError("model_incomplete")
    try:
        chunks = [part["text"] for item in data.get("output", [])
                  if item.get("type") == "message"
                  for part in item.get("content", [])
                  if part.get("type") == "output_text"]
        raw = "".join(chunks).strip()
        if raw.startswith("```json\n") and raw.endswith("```"):
            raw = raw[8:-3].strip()
        elif raw.startswith("```\n") and raw.endswith("```"):
            raw = raw[4:-3].strip()
        result = json.loads(raw)
    except (AttributeError, KeyError, TypeError, ValueError) as exc:
        raise ProviderError("model_invalid_json") from exc
    if not isinstance(result, dict):
        raise ProviderError("model_invalid_json")
    return result


class MetaProvider:
    mode = "live"

    def __init__(self, api_key: str, model: str = "muse-spark-1.3", timeout: float = 30):
        if not api_key:
            raise ProviderError("missing_api_key")
        self._api_key = api_key
        self.model = model
        self.timeout = timeout

    def complete(self, instructions: str, payload: dict) -> dict:
        body = json.dumps({
            "model": self.model,
            "instructions": instructions + "\nReturn only one JSON object; no Markdown or commentary.",
            "input": json.dumps(payload, ensure_ascii=False),
            "store": False,
            "max_output_tokens": 4096,
        }).encode("utf-8")
        request = urllib.request.Request(
            "https://api.meta.ai/v1/responses", data=body,
            headers={"Authorization": "Bearer " + self._api_key,
                     "Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read(1_048_577)
                if len(raw) > 1_048_576:
                    raise ProviderError("model_response_too_large")
                data = json.loads(raw)
        except urllib.error.HTTPError as exc:
            # Never expose the response body: it may echo private input or headers.
            code = "model_rate_limited" if exc.code == 429 else "model_http_error"
            raise ProviderError(code) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ProviderError("model_unavailable") from None
        except (ValueError, UnicodeError):
            raise ProviderError("model_invalid_response") from None
        if not isinstance(data, dict):
            raise ProviderError("model_invalid_response")
        return parse_output(data)

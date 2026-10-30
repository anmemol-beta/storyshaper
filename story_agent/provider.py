"""Small server-side Meta Responses adapter; no SDK or runtime dependency."""
from __future__ import annotations

import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request


class ProviderError(RuntimeError):
    """Safe error code, deliberately excluding provider bodies and credentials."""

    def __init__(self, code: str, *, metrics: dict | None = None):
        super().__init__(code)
        self.metrics = metrics


def _usage_metrics(data: dict) -> dict:
    """Copy numeric counters only; absent or malformed usage is unknown, not zero."""
    usage = data.get("usage")
    usage = usage if isinstance(usage, dict) else {}
    output_details = usage.get("output_tokens_details")
    input_details = usage.get("input_tokens_details")
    counters = {
        "inputTokens": usage.get("input_tokens"),
        "outputTokens": usage.get("output_tokens"),
        "reasoningTokens": output_details.get("reasoning_tokens") if isinstance(output_details, dict) else None,
        "cachedInputTokens": input_details.get("cached_tokens") if isinstance(input_details, dict) else None,
    }
    return {key: value if type(value) is int and value >= 0 else None
            for key, value in counters.items()}


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


# None omits the setting, so the model uses its own default effort.
EFFORTS = (None, "minimal", "low", "medium", "high", "xhigh", "max")


class MetaProvider:
    mode = "live"

    def __init__(self, api_key: str, model: str = "muse-spark-1.3", timeout: float = 30,
                 compose_reasoning_effort: str | None = "low",
                 review_reasoning_effort: str | None = "low"):
        if not api_key:
            raise ProviderError("missing_api_key")
        self._api_key = api_key
        self.model = model
        self.timeout = timeout
        if compose_reasoning_effort not in EFFORTS:
            raise ValueError("Unsupported compose reasoning effort")
        if review_reasoning_effort not in EFFORTS:
            raise ValueError("Unsupported review reasoning effort")
        self.compose_reasoning_effort = compose_reasoning_effort
        self.review_reasoning_effort = review_reasoning_effort

    def complete(self, instructions: str, payload: dict) -> dict:
        result, _ = self.complete_with_metrics(instructions, payload)
        return result

    def complete_with_metrics(self, instructions: str, payload: dict) -> tuple[dict, dict]:
        """Return content and safe per-call measurements, including usage when supplied."""
        started = time.perf_counter()
        input_text = json.dumps(payload, ensure_ascii=False)
        policy = instructions + "\nReturn only one JSON object; no Markdown or commentary."
        effort = {"compose": self.compose_reasoning_effort, "interpret_compose": self.compose_reasoning_effort,
                  "review": self.review_reasoning_effort}.get(payload.get("phase"))
        request_body = {
            "model": self.model,
            "instructions": policy,
            "input": input_text,
            "store": False,
            # This budget also includes the model's internal reasoning, not only JSON.
            "max_output_tokens": 8192,
        }
        if effort is not None:
            request_body["reasoning"] = {"effort": effort}
        body = json.dumps(request_body).encode("utf-8")
        metrics = {"durationMs": None, "requestBytes": len(body),
                   "instructionChars": len(policy), "inputChars": len(input_text),
                   "reasoningEffort": effort or "default", **_usage_metrics({})}
        request = urllib.request.Request(
            "https://api.meta.ai/v1/responses", data=body,
            headers={"Authorization": "Bearer " + self._api_key,
                     "Content-Type": "application/json"}, method="POST")
        try:
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
            except (urllib.error.URLError, TimeoutError, OSError):
                raise ProviderError("model_unavailable") from None
            except (ValueError, UnicodeError):
                raise ProviderError("model_invalid_response") from None
            if not isinstance(data, dict):
                raise ProviderError("model_invalid_response")
            metrics.update(_usage_metrics(data))
            result = parse_output(data)
        except ProviderError as exc:
            exc.metrics = metrics
            raise
        finally:
            metrics["durationMs"] = round((time.perf_counter() - started) * 1000, 2)
        return result, metrics

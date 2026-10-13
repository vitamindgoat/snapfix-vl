#!/usr/bin/env python3
"""
SNAPFIX tenant HTTP server (deployed with examples/snapfix via R2).

Routes (no /_malex prefix):
  POST /snapfix/contractors  — vision → Places → rerank → response
  POST /snapfix/rerank       — ModernBERT hybrid rerank
  GET  /snapfix/health       — readiness (200 only when Qwen2-VL + ModernBERT loaded)

Config from environment (project .env sourced by entrypoint.sh):
  GOOGLE_PLACES_API_KEY, SNAPFIX_VISION_MODEL, SNAPFIX_VISION_DEVICE,
  SNAPFIX_RERANK_DEVICE (default cpu — vision model may use mps/cuda)
"""
from __future__ import annotations

import json
import math
import os
import threading
import httpx
import numpy as np
import urllib.parse

import qwen_vision

from functools import lru_cache
from http.server import BaseHTTPRequestHandler, HTTPServer
from sentence_transformers import SentenceTransformer
from typing import Any


MAX_IMAGE_PAYLOAD_BYTES = 6 * 1024 * 1024
HOST = os.environ.get("MALEX_TENANT_HTTP_BIND", "127.0.0.1")
PORT = int(os.environ.get("MALEX_TENANT_HTTP_PORT", "8790"))
RERANK_MODEL = "answerdotai/ModernBERT-large"
RERANK_DEVICE = os.environ.get("SNAPFIX_RERANK_DEVICE", "cpu").strip() or "cpu"

_rerank_ready = threading.Event()
_rerank_error_lock = threading.Lock()
_rerank_error: str | None = None

GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText"

SNAPFIX_VISION_PROMPT = """You are SNAPFIX. Analyze the image to determine if there is a home maintenance problem.
Return JSON only with exactly these keys:
- "detected": boolean
- "category": short string (e.g. "plumbing", "electrical", "roof", "hvac")
- "issue": brief problem description
- "trade": short search-friendly trade label (e.g. "plumber", "electrician", "roofer")
- "recommendation": one sentence for the homeowner

No markdown, no extra keys, no explanations."""


def _places_api_key() -> str | None:
    k = (os.environ.get("GOOGLE_PLACES_API_KEY") or "").strip()
    return k or None


def _clamp01(x: float) -> float:
    return float(max(0.0, min(1.0, x)))


def _normalize_rating(r: Any) -> float:
    try:
        r = float(r)
    except (TypeError, ValueError):
        return 0.0
    return _clamp01(r / 5.0)


def _normalize_inv_distance(dmi: Any) -> float:
    try:
        d = float(dmi)
    except (TypeError, ValueError):
        return 0.0
    if d <= 0.0:
        return 1.0
    return float(_clamp01(15.0 / (d + 15.0)))


def _hybrid(sim: float, rating: Any, dist_mi: Any) -> float:
    return (
        0.5 * _clamp01((sim + 1.0) / 2.0)
        + 0.3 * _normalize_rating(rating)
        + 0.2 * _normalize_inv_distance(dist_mi)
    )


def _set_rerank_error(msg: str) -> None:
    global _rerank_error
    with _rerank_error_lock:
        _rerank_error = msg


def rerank_is_ready() -> bool:
    return _rerank_ready.is_set()


def rerank_status() -> dict[str, Any]:
    with _rerank_error_lock:
        err = _rerank_error
    return {
        "ready": _rerank_ready.is_set(),
        "model": RERANK_MODEL,
        "error": err,
    }


def models_ready() -> bool:
    return qwen_vision.is_ready() and rerank_is_ready()


def health_payload() -> dict[str, Any]:
    return {
        "ok": models_ready(),
        "vision": qwen_vision.status(),
        "rerank": rerank_status(),
    }


@lru_cache(maxsize=1)
def _encoder():
    print(f"[+] Loading rerank model {RERANK_MODEL} on {RERANK_DEVICE} …")
    enc = SentenceTransformer(RERANK_MODEL, device=RERANK_DEVICE)
    print(f"[+] rerank encoder ready ({RERANK_DEVICE}).")
    with _rerank_error_lock:
        global _rerank_error
        _rerank_error = None
    _rerank_ready.set()
    return enc


def _preload_rerank() -> None:
    try:
        _encoder()
    except Exception as e:
        _set_rerank_error(repr(e))
        print(f"[!] rerank preload failed: {e}")


def _encode_batch(texts: list[str]) -> np.ndarray:
    enc = _encoder()
    return enc.encode(
        texts, batch_size=min(32, len(texts)), show_progress_bar=False, convert_to_numpy=True
    )


def rerank(payload: dict) -> dict:
    query = payload.get("query") or ""
    trade = (payload.get("trade") or "").strip()
    cand = payload.get("candidates")
    if not isinstance(cand, list):
        cand = []

    cand_texts: list[str] = []
    cand_meta: list[dict] = []
    for raw in cand:
        if not isinstance(raw, dict):
            continue
        pid = str(raw.get("place_id") or "").strip()
        name = str(raw.get("name") or "").strip()
        phone = str(raw.get("phone") or "").strip()
        rating = raw.get("rating")
        dm = raw.get("distance_miles")
        addr = str(raw.get("address") or "").strip()
        if not pid:
            continue
        line = (
            f"{name}. Trade: {trade}. Rating {rating if rating is not None else 'n/a'}."
            f" Distance miles {dm if dm is not None else 'unknown'}. {addr}".strip()
        )
        cand_texts.append(line)
        cand_meta.append(
            {"place_id": pid, "name": name, "phone": phone, "rating": rating, "distance_miles": dm}
        )

    if not cand_meta:
        return {"scores": []}

    embeddings = _encode_batch([query] + list(cand_texts))
    qv = embeddings[0].astype("float64")
    qnorm = np.linalg.norm(qv) + 1e-9

    scored = []
    for i, meta in enumerate(cand_meta):
        cv = embeddings[1 + i].astype("float64")
        cnorm = np.linalg.norm(cv) + 1e-9
        sim = float(np.dot(qv / qnorm, cv / cnorm))
        hybrid = _hybrid(sim, meta.get("rating"), meta.get("distance_miles"))
        scored.append(
            {
                "place_id": meta["place_id"],
                "semantic_score": sim,
                "hybrid_score": hybrid,
            }
        )

    scored.sort(key=lambda row: row["hybrid_score"], reverse=True)
    return {"scores": scored}


# --- Places ---


def _distance_miles(a: dict, b: dict) -> float:
    r = 3958.7613
    lat1, lng1 = math.radians(a["lat"]), math.radians(a["lng"])
    lat2, lng2 = math.radians(b["lat"]), math.radians(b["lng"])
    d_lat = lat2 - lat1
    d_lon = lng2 - lng1
    h = math.sin(d_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(d_lon / 2) ** 2
    return 2.0 * r * math.asin(math.sqrt(h))


def geocode_address(addr: str, api_key: str) -> dict | None:
    q = urllib.parse.urlencode({"address": addr, "key": api_key})
    url = f"{GEOCODE_URL}?{q}"
    try:
        with httpx.Client(timeout=30.0) as client:
            res = client.get(url)
        if res.status_code != 200:
            return None
        body = res.json()
        if body.get("status") != "OK" or not body.get("results"):
            return None
        loc = body["results"][0]["geometry"]["location"]
        return {"lat": float(loc["lat"]), "lng": float(loc["lng"])}
    except Exception as e:
        print(f"[!] geocode: {e}")
        return None


def search_places_near(
    text_query: str, origin: dict | None, api_key: str, max_results: int = 20
) -> list[dict]:
    payload: dict[str, Any] = {
        "textQuery": text_query,
        "maxResultCount": max_results,
    }
    if origin:
        payload["locationBias"] = {
            "circle": {
                "center": {"latitude": origin["lat"], "longitude": origin["lng"]},
                "radius": 50000.0,
            }
        }

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": (
            "places.displayName,places.formattedAddress,places.name,"
            "places.nationalPhoneNumber,places.rating,places.location"
        ),
    }

    with httpx.Client(timeout=45.0) as client:
        res = client.post(SEARCH_TEXT_URL, headers=headers, json=payload)

    if res.status_code != 200:
        preview = res.text[:800]
        raise RuntimeError(f"Places searchText HTTP {res.status_code}: {preview}")

    decoded = res.json()
    out: list[dict] = []
    for p in decoded.get("places") or []:
        dn = (p.get("displayName") or {}).get("text") or ""
        name_field = p.get("name") or ""
        display_name = dn.strip() or _place_slug(name_field)
        address = p.get("formattedAddress") or ""
        loc = p.get("location") or {}
        lat = loc.get("latitude")
        lng = loc.get("longitude")
        lat_lng = None
        if lat is not None and lng is not None:
            lat_lng = {"lat": float(lat), "lng": float(lng)}

        out.append(
            {
                "resource_name": name_field or display_name,
                "display_name": display_name,
                "address": address,
                "national_phone_number": p.get("nationalPhoneNumber"),
                "rating": p.get("rating"),
                "lat_lng": lat_lng,
            }
        )
        if len(out) >= 20:
            break
    return out


def _place_slug(resource_name: str) -> str:
    if resource_name.startswith("places/"):
        return resource_name[7:]
    return resource_name


def normalize_for_rerank(
    places: list[dict], geocoded_origin: dict | None, max_kept: int = 20
) -> list[dict]:
    out: list[dict] = []
    for p in places:
        phone = (p.get("national_phone_number") or "").strip()
        if not phone:
            continue
        dist = None
        if geocoded_origin and p.get("lat_lng"):
            dist = _distance_miles(geocoded_origin, p["lat_lng"])
        out.append(
            {
                "place_id": _place_slug(p.get("resource_name") or ""),
                "name": p.get("display_name") or "",
                "phone": phone,
                "rating": p.get("rating"),
                "distance_miles": dist,
                "address": p.get("address") or "",
            }
        )
        if len(out) >= max_kept:
            break
    return out


# --- Vision / contractors ---


def _preview_bytes(raw: bytes, limit: int = 1200) -> str:
    s = raw.decode("utf-8", errors="replace").strip()
    return s if len(s) <= limit else s[:limit] + "…"


def _strip_code_fence(s: str) -> str:
    t = s.strip()
    if t.startswith("```"):
        idx = t.find("\n")
        if idx >= 0:
            rest = t[idx + 1 :]
            end = rest.rfind("```")
            if end >= 0:
                return rest[:end].strip()
    return t


def _extract_json_object_bytes(s: str) -> bytes | None:
    stripped = _strip_code_fence(s)
    start = stripped.find("{")
    if start < 0:
        return None
    depth = 0
    end_mark = None
    for i, ch in enumerate(stripped[start:]):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end_mark = start + i + 1
                break
    if end_mark is None:
        return None
    return stripped[start:end_mark].encode()


def _parse_analysis(text: str) -> dict:
    blob = _extract_json_object_bytes(text)
    if not blob:
        raise ValueError("no JSON object in model output")
    v = json.loads(blob)
    if "detected" not in v or not isinstance(v["detected"], bool):
        raise ValueError("missing detected boolean")

    def sval(k: str) -> str:
        x = v.get(k)
        return x.strip() if isinstance(x, str) else ""

    return {
        "detected": v["detected"],
        "category": sval("category"),
        "issue": sval("issue"),
        "trade": sval("trade"),
        "recommendation": sval("recommendation"),
    }


def _call_vision(location_hint: str, image_b64: str) -> tuple[int, bytes]:
    user_text = (
        f"Residential location hint: {location_hint}\n"
        "Return JSON only with the requested keys."
    )
    try:
        text = qwen_vision.analyze_image(
            system_prompt=SNAPFIX_VISION_PROMPT,
            user_text=user_text,
            image_b64=image_b64,
        )
    except Exception as e:
        err = json.dumps({"error": {"message": str(e), "type": "vision_error"}}).encode()
        return 502, err
    payload = {"choices": [{"message": {"role": "assistant", "content": text}}]}
    return 200, json.dumps(payload).encode()


def _extract_assistant_text(raw: bytes) -> str:
    try:
        v = json.loads(raw)
        c = v.get("choices") or []
        if c:
            msg = c[0].get("message") or {}
            content = msg.get("content")
            if isinstance(content, str):
                return content
    except json.JSONDecodeError:
        pass
    return ""


def _fallback_sort(norm: list[dict]) -> None:
    norm.sort(
        key=lambda c: (
            c.get("distance_miles") if c.get("distance_miles") is not None else float("inf"),
            -(c.get("rating") or 0.0),
        )
    )


def _order_by_place_ids(normalized: list[dict], scores: list[dict], limit: int) -> list[dict]:
    m = {s["place_id"]: s.get("hybrid_score", (s.get("semantic_score", 0) + 1) / 2) for s in scores}
    tagged = [(c, m.get(c["place_id"], 0.0)) for c in normalized]
    tagged.sort(key=lambda x: (-x[1], -(x[0].get("rating") or 0.0)))
    return [c for c, _ in tagged[:limit]]


def _template_reason(query: str, trade: str, rating: float, miles: float | None) -> str:
    dist = f"{miles:.1f} mi away" if miles is not None else "distance unknown"
    tlabel = trade if trade else "recommended"
    r = (
        f"Semantic match for your issue ({tlabel} trade). {rating:.1f}-star Places rating; {dist}."
    )
    if len(query) < 240:
        r += " Focus: " + query[:400]
    return r


def handle_contractors(body: dict) -> tuple[int, dict]:
    img = (body.get("image_base64") or "").strip()
    loc = (body.get("location") or "").strip()
    if not img or not loc:
        return 400, {"error": "invalid JSON body: expected { image_base64, location }"}

    places_key = _places_api_key()
    if not places_key:
        return 500, {
            "error": "misconfigured",
            "detail": "GOOGLE_PLACES_API_KEY is missing or empty (set in dashboard Security or project .env for malexai run)",
        }

    code, vision_raw = _call_vision(loc, img)
    if code != 200:
        return 502, {
            "error": "vision_upstream_error",
            "status": code,
            "preview": _preview_bytes(vision_raw),
        }

    try:
        analysis = _parse_analysis(_extract_assistant_text(vision_raw))
    except ValueError as e:
        return 422, {
            "error": "vision_parse_error",
            "detail": str(e),
            "preview": _preview_bytes(vision_raw),
        }

    if not analysis["detected"]:
        return 200, {
            "analysis": analysis,
            "contractors": [],
            "search_warning": "No maintenance issue detected; skipped contractor search.",
        }

    trade_q = analysis["trade"].strip()
    issue_q = analysis["issue"].strip()
    if not trade_q:
        text_query = f"{issue_q} {loc}".strip()
    elif not issue_q:
        text_query = f"{trade_q} near {loc}"
    else:
        text_query = f"{trade_q} {issue_q} near {loc}"

    geocoded = geocode_address(loc, places_key)
    try:
        raw_places = search_places_near(text_query, geocoded, places_key, 20)
    except Exception as e:
        return 502, {"error": "places_error", "detail": str(e)}

    normalized = normalize_for_rerank(raw_places, geocoded, 20)
    search_warning = None
    if len(normalized) < 5:
        search_warning = f"Only {len(normalized)} grounded contractors with phones were returned."

    if not normalized:
        return 200, {
            "analysis": analysis,
            "contractors": [],
            "search_warning": search_warning
            or "No Places results included a national phone.",
        }

    query_text = f"{analysis['issue'].strip()}. Need {trade_q}. Near {loc}."
    rerank_payload = {
        "query": query_text,
        "trade": trade_q,
        "candidates": normalized,
    }

    rerank_warning = None
    try:
        scores = rerank(rerank_payload).get("scores") or []
        if not scores:
            nw = list(normalized)
            _fallback_sort(nw)
            picks = nw[:5]
            rerank_warning = "rerank returned no scores — used distance/rating fallback"
        else:
            picks = _order_by_place_ids(normalized, scores, 5)
    except Exception as e:
        nw = list(normalized)
        _fallback_sort(nw)
        picks = nw[:5]
        rerank_warning = f"rerank_error: {e}"

    contractors = []
    for c in picks:
        rating = float(c.get("rating") or 0.0)
        dm = c.get("distance_miles")
        dist = f"{dm:.1f} mi" if dm is not None else "—"
        contractors.append(
            {
                "name": c["name"],
                "phone": c["phone"],
                "rating": rating,
                "distance": dist,
                "reason": _template_reason(query_text, trade_q, rating, dm),
            }
        )

    out: dict[str, Any] = {"analysis": analysis, "contractors": contractors}
    if search_warning:
        out["search_warning"] = search_warning
    if rerank_warning:
        out["rerank_warning"] = rerank_warning
    return 200, out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"[snapfix] {fmt % args}")

    def _send_json(self, status: int, body: dict | bytes) -> None:
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/snapfix/health", "/health"):
            body = health_payload()
            self._send_json(200 if body["ok"] else 503, body)
            return
        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        ln = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(ln) if ln > 0 else b"{}"

        if self.path == "/snapfix/rerank":
            try:
                payload = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError as e:
                self._send_json(400, {"error": f"invalid_json: {e}"})
                return
            try:
                out = rerank(payload)
            except Exception as e:
                self._send_json(500, {"error": "rerank_failed", "detail": repr(e)})
                return
            self._send_json(200, out)
            return

        if self.path == "/snapfix/contractors":
            if ln > MAX_IMAGE_PAYLOAD_BYTES:
                self._send_json(413, {"error": "payload_too_large"})
                return
            try:
                payload = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON body: expected { image_base64, location }"})
                return
            status, out = handle_contractors(payload)
            self._send_json(status, out)
            return

        self._send_json(404, {"error": "not_found"})


def main() -> None:
    server = HTTPServer((HOST, PORT), Handler)
    print(f"[+] SNAPFIX tenant HTTP http://{HOST}:{PORT} (/snapfix/contractors, /snapfix/rerank)")
    print("[+] Pre-loading rerank model in background…")
    threading.Thread(target=_preload_rerank, name="snapfix-rerank-preload", daemon=True).start()
    print("[+] Pre-loading Qwen2-VL in background…")
    threading.Thread(target=qwen_vision.preload, name="snapfix-vision-preload", daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()

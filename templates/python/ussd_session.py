"""
USSD session store.

A USSD session is short-lived and stateful. The USSD Gateway sends you a
keypress and a `sessionId`; it does not tell you where in the menu the
subscriber is. That state is yours to keep.

⚠️  THIS IN-MEMORY IMPLEMENTATION IS FOR DEVELOPMENT ONLY.

It breaks the moment you run more than one worker — a keypress routed to worker
B cannot see a session created on worker A, and the subscriber's menu dies
mid-flow. Gunicorn or uvicorn with more than one worker is already "more than
one process". Use the Redis implementation at the bottom of this file in
production.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

#: Sessions must expire. Sessions never closed with `mt-fin` would otherwise
#: accumulate forever.
SESSION_TTL_SECONDS = 120


@dataclass
class UssdSession:
    #: Where in your menu tree the subscriber currently is.
    node: str
    #: Subscriber address, as received (possibly masked).
    source_address: str
    #: Arbitrary per-session scratch data. Keep it small and non-sensitive.
    data: Dict[str, Any] = field(default_factory=dict)
    created_at: float = 0.0
    updated_at: float = 0.0
    expires_at: float = 0.0


_sessions: Dict[str, UssdSession] = {}
_lock = threading.Lock()


def get_session(session_id: str) -> Optional[UssdSession]:
    now = time.monotonic()
    with _lock:
        session = _sessions.get(session_id)
        if session is None:
            return None
        if now > session.expires_at:
            del _sessions[session_id]
            return None
        return session


def set_session(
    session_id: str,
    *,
    node: str,
    source_address: str,
    data: Optional[Dict[str, Any]] = None,
) -> None:
    now = time.monotonic()
    with _lock:
        existing = _sessions.get(session_id)
        _sessions[session_id] = UssdSession(
            node=node,
            source_address=source_address,
            data=data if data is not None else (existing.data if existing else {}),
            created_at=existing.created_at if existing else now,
            updated_at=now,
            expires_at=now + SESSION_TTL_SECONDS,
        )


def end_session(session_id: str) -> None:
    """Call this whenever you send `mt-fin`."""
    with _lock:
        _sessions.pop(session_id, None)


def active_session_count() -> int:
    _sweep()
    with _lock:
        return len(_sessions)


def _sweep() -> None:
    now = time.monotonic()
    with _lock:
        for key, session in list(_sessions.items()):
            if now > session.expires_at:
                del _sessions[key]


# ─────────────────────────────────────────────────────────────────────────────
# Production: Redis
#
# Same interface, works across workers, survives deploys, and gets TTL eviction
# for free.
#
#     import json, redis
#     _redis = redis.from_url(os.environ["REDIS_URL"])
#
#     def _key(session_id: str) -> str:
#         return f"ussd:session:{session_id}"
#
#     def get_session(session_id):
#         raw = _redis.get(_key(session_id))
#         return UssdSession(**json.loads(raw)) if raw else None
#
#     def set_session(session_id, *, node, source_address, data=None):
#         payload = {"node": node, "source_address": source_address, "data": data or {}}
#         _redis.set(_key(session_id), json.dumps(payload), ex=SESSION_TTL_SECONDS)
#
#     def end_session(session_id):
#         _redis.delete(_key(session_id))
#
# Notes:
#   - Do not store the raw MSISDN longer than the session needs it.
#   - Keep session payloads small; USSD flows should not accumulate state.
# ─────────────────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────────────────
# Menu rendering
#
# USSD is plain ASCII (encoding 440), and the GSM standard caps a message at 182
# septets. Strip anything else and truncate at a safe 160 — a screen that
# silently fails to render tells the subscriber nothing.
# ─────────────────────────────────────────────────────────────────────────────

_SMART_QUOTES = {
    "“": '"', "”": '"', "‘": "'", "’": "'",
    "–": "-", "—": "-",
}


def sanitise_ussd(text: str, max_length: int = 160) -> str:
    for bad, good in _SMART_QUOTES.items():
        text = text.replace(bad, good)
    text = text.replace("\t", " ")
    # Drop emoji, Sinhala/Tamil script and control characters.
    ascii_only = re.sub(r"[^\x20-\x7E\n]", "", text)
    # Hard truncate — no ellipsis, since "…" is itself non-ASCII.
    return ascii_only[:max_length]


def render_menu(header: str, options: Dict[str, str]) -> str:
    """Render a menu screen. Plain ASCII, one option per line."""
    lines = [header] + [f"{key}. {label}" for key, label in options.items()]
    return sanitise_ussd("\n".join(lines))

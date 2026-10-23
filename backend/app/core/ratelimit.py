"""In-process sliding-window rate limiter.

Adequate for a single backend instance. For horizontally scaled deployments, also enable rate
limiting at the reverse proxy / load balancer (see docs/DEPLOYMENT.md); the per-account lockout
stored in the database applies across instances regardless.
"""

import threading
import time
from collections import deque

from app.core.errors import RateLimited


class SlidingWindowLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque] = {}
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window_seconds: int = 60) -> None:
        now = time.monotonic()
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and q[0] <= now - window_seconds:
                q.popleft()
            if len(q) >= limit:
                raise RateLimited("Too many attempts. Please wait a minute and try again.")
            q.append(now)
            if len(self._hits) > 50000:
                self._hits.clear()

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = SlidingWindowLimiter()

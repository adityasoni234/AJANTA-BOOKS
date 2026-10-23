import logging
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.core.config import get_settings
from app.core.logging import request_id_ctx, user_id_ctx

log = logging.getLogger("app.request")


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Correlation ID, access log, body-size limit and security headers."""

    async def dispatch(self, request: Request, call_next) -> Response:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        rid = rid[:64]
        token = request_id_ctx.set(rid)
        user_id_ctx.set(None)
        start = time.perf_counter()
        try:
            cl = request.headers.get("content-length")
            if cl and cl.isdigit() and int(cl) > get_settings().max_request_bytes:
                return JSONResponse(
                    status_code=413,
                    content={"error": {"code": "payload_too_large", "message": "Request body too large", "request_id": rid}},
                )
            response = await call_next(request)
            elapsed = (time.perf_counter() - start) * 1000
            response.headers["X-Request-ID"] = rid
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["X-Frame-Options"] = "DENY"
            response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
            response.headers["Cache-Control"] = response.headers.get("Cache-Control", "no-store")
            if request.url.path.startswith("/api/") and not request.url.path.startswith("/api/docs"):
                log.info(
                    "request",
                    extra={"method": request.method, "path": request.url.path, "status": response.status_code,
                           "duration_ms": round(elapsed, 1)},
                )
            return response
        finally:
            request_id_ctx.reset(token)

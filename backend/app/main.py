import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.v1 import router as v1_router
from app.core.config import get_settings
from app.core.db import get_engine
from app.core.errors import install_error_handlers
from app.core.logging import configure_logging
from app.core.middleware import RequestContextMiddleware

log = logging.getLogger("app")


def create_app() -> FastAPI:
    settings = get_settings()  # validates required environment at startup
    configure_logging(settings.log_level, settings.log_json)
    app = FastAPI(
        title=settings.app_name,
        version="1.0.0",
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
    )
    install_error_handlers(app)
    app.add_middleware(RequestContextMiddleware)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Content-Type", "X-CSRF-Token", "Idempotency-Key", "X-Request-ID"],
        )
    if settings.trusted_hosts != ["*"]:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.trusted_hosts)

    app.include_router(v1_router, prefix="/api/v1")

    @app.get("/health/live", tags=["health"])
    def live():
        return {"status": "ok"}

    @app.get("/health/ready", tags=["health"])
    def ready():
        try:
            with get_engine().connect() as conn:
                conn.execute(text("select 1"))
                rev = conn.execute(text("select version_num from alembic_version")).scalar()
            return {"status": "ok", "database": "ok", "migration": rev}
        except Exception:
            log.exception("readiness_check_failed")
            return JSONResponse(status_code=503, content={"status": "unavailable", "database": "error"})

    return app


app = create_app()

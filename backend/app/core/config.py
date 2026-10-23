"""Application configuration loaded from environment variables.

Required settings are validated at startup; the app refuses to boot in production
with insecure defaults.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"
    app_name: str = "Ajanta Books ERP"
    log_level: str = "INFO"
    log_json: bool = True

    database_url: str = Field(..., description="SQLAlchemy URL, e.g. postgresql+psycopg://user:pass@host/db")
    db_pool_size: int = 10
    db_max_overflow: int = 10
    db_statement_timeout_ms: int = 15000

    secret_key: str = Field(..., min_length=32)

    session_cookie_name: str = "ab_session"
    csrf_cookie_name: str = "ab_csrf"
    session_idle_minutes: int = 120
    session_absolute_hours: int = 12
    cookie_secure: bool = True
    cookie_samesite: Literal["lax", "strict", "none"] = "lax"
    cookie_domain: str | None = None

    cors_origins: list[str] = []
    trusted_hosts: list[str] = ["*"]

    login_rate_limit_per_minute: int = 10
    max_failed_logins: int = 8
    lockout_minutes: int = 15

    max_request_bytes: int = 10 * 1024 * 1024
    upload_dir: str = "./uploads"
    max_upload_bytes: int = 5 * 1024 * 1024

    max_page_size: int = 200
    max_export_rows: int = 50000

    # Optional integrations — remain "unconfigured" until set.
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from: str | None = None
    smtp_starttls: bool = True
    public_app_url: str = "http://localhost:5173"

    @field_validator("database_url")
    @classmethod
    def _db_url(cls, v: str) -> str:
        if v.startswith("postgres://"):
            v = "postgresql+psycopg://" + v[len("postgres://"):]
        elif v.startswith("postgresql://"):
            v = "postgresql+psycopg://" + v[len("postgresql://"):]
        if not v.startswith("postgresql+psycopg://"):
            raise ValueError("DATABASE_URL must be a PostgreSQL URL")
        return v

    @model_validator(mode="after")
    def _production_guards(self) -> "Settings":
        if self.app_env == "production":
            weak = {"change-me", "changeme", "dev-secret"}
            if any(w in self.secret_key.lower() for w in weak):
                raise ValueError("SECRET_KEY must be a strong random value in production")
            if not self.cookie_secure:
                raise ValueError("COOKIE_SECURE must be true in production")
            if self.cookie_samesite == "none" and not self.cookie_secure:
                raise ValueError("SameSite=None requires secure cookies")
        return self

    @property
    def smtp_configured(self) -> bool:
        return bool(self.smtp_host and self.smtp_from)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]

"""Authentication + authorization dependencies.

Every protected endpoint depends on `require(...)`, which:
  1. resolves the session cookie to an active, unexpired, unrevoked session of an active user,
  2. enforces CSRF (double-submit token bound to the session) on unsafe methods,
  3. checks the requested permission(s) against the user's role (loaded fresh from the DB each request,
     so role changes and deactivation take effect immediately),
  4. exposes location-scope helpers used by every query on location-owned data.
"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from fastapi import Depends, Request
from sqlalchemy import ColumnElement, false, select, true
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.errors import Forbidden, NotFound, Unauthorized
from app.core.logging import user_id_ctx
from app.core.security import constant_time_equals, hash_token
from app.models import Location, User, UserSession

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@dataclass
class AuthContext:
    user: User
    session_id: uuid.UUID
    permissions: set[str]
    all_locations: bool
    location_ids: set[uuid.UUID]
    ip: str | None = None
    user_agent: str | None = None
    extras: dict = field(default_factory=dict)

    @property
    def user_id(self) -> uuid.UUID:
        return self.user.id

    @property
    def id(self) -> uuid.UUID:  # convenience for audit()
        return self.user.id

    def has(self, perm: str) -> bool:
        return perm in self.permissions

    def require(self, *perms: str) -> None:
        missing = [p for p in perms if p not in self.permissions]
        if missing:
            raise Forbidden(f"Missing permission: {', '.join(missing)}", code="permission_denied")

    def can_access(self, location_id: uuid.UUID | None) -> bool:
        if location_id is None:
            return self.all_locations
        return self.all_locations or location_id in self.location_ids

    def ensure_location(self, location_id: uuid.UUID | None) -> None:
        """For explicit location parameters: deny with 403."""
        if not self.can_access(location_id):
            raise Forbidden("You do not have access to this location", code="location_denied")

    def ensure_resource(self, *location_ids: uuid.UUID | None) -> None:
        """For resources fetched by id: hide existence with 404 unless any owning location is in scope."""
        if self.all_locations:
            return
        if not any(lid in self.location_ids for lid in location_ids if lid is not None):
            raise NotFound("Not found")

    def loc_filter(self, column) -> ColumnElement[bool]:
        if self.all_locations:
            return true()
        if not self.location_ids:
            return false()
        return column.in_(self.location_ids)

    def scoped_location_ids(self, requested: uuid.UUID | None) -> list[uuid.UUID] | None:
        """Resolve a report/list filter: None means 'all permitted' (None == unrestricted)."""
        if requested is not None:
            self.ensure_location(requested)
            return [requested]
        return None if self.all_locations else sorted(self.location_ids)


def _client_ip(request: Request) -> str | None:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


def _load_context(request: Request, db: Session, *, allow_pending_password: bool) -> AuthContext:
    settings = get_settings()
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise Unauthorized("Not authenticated", code="not_authenticated")
    sess = db.scalar(select(UserSession).where(UserSession.token_hash == hash_token(token)))
    now = datetime.now(UTC)
    if sess is None or sess.revoked_at is not None or sess.expires_at <= now:
        raise Unauthorized("Session expired or revoked", code="session_expired")
    if sess.last_seen_at + timedelta(minutes=settings.session_idle_minutes) <= now:
        sess.revoked_at = now
        db.commit()
        raise Unauthorized("Session expired due to inactivity", code="session_expired")

    user = db.get(User, sess.user_id)
    if user is None or not user.is_active:
        raise Unauthorized("Account is deactivated", code="account_inactive")

    if request.method not in SAFE_METHODS:
        header = request.headers.get("x-csrf-token", "")
        if not header or not constant_time_equals(hash_token(header), sess.csrf_hash):
            raise Forbidden("CSRF token missing or invalid", code="csrf_failed")

    if user.must_change_password and not allow_pending_password:
        raise Forbidden("Password change required", code="password_change_required")

    if (now - sess.last_seen_at).total_seconds() > 60:
        sess.last_seen_at = now
        db.commit()

    active_loc_ids = set(
        db.scalars(
            select(Location.id).where(Location.id.in_(user.location_ids), Location.is_active.is_(True))
        )
    ) if user.location_ids else set()

    ctx = AuthContext(
        user=user,
        session_id=sess.id,
        permissions=set(user.role.permission_codes),
        all_locations=user.all_locations,
        location_ids=active_loc_ids,
        ip=_client_ip(request),
        user_agent=request.headers.get("user-agent"),
    )
    user_id_ctx.set(str(user.id))
    return ctx


def current_user(request: Request, db: Session = Depends(get_db)) -> AuthContext:
    return _load_context(request, db, allow_pending_password=False)


def current_user_allow_pending(request: Request, db: Session = Depends(get_db)) -> AuthContext:
    return _load_context(request, db, allow_pending_password=True)


def require(*perms: str):
    def dep(ctx: AuthContext = Depends(current_user)) -> AuthContext:
        ctx.require(*perms)
        return ctx

    return dep


def require_any(*perms: str):
    def dep(ctx: AuthContext = Depends(current_user)) -> AuthContext:
        if not any(ctx.has(p) for p in perms):
            raise Forbidden(f"Requires one of: {', '.join(perms)}", code="permission_denied")
        return ctx

    return dep

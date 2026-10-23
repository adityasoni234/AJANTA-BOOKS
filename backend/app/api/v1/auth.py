import logging
import os
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, _client_ip, current_user, current_user_allow_pending
from app.core.config import get_settings
from app.core.db import get_db
from app.core.errors import Forbidden, NotFound, ValidationFailed
from app.core.ratelimit import limiter
from app.core.security import constant_time_equals, verify_password
from app.models import Location, Organization, User, UserSession
from app.services import bootstrap
from app.services.audit import audit
from app.services.auth import (
    authenticate,
    clear_session_cookies,
    consume_reset_token,
    create_reset_token,
    create_session,
    revoke_user_sessions,
    set_password,
    set_session_cookies,
)
from app.services.gst import STATE_CODES
from app.services.mailer import send_email

router = APIRouter(tags=["auth"])
log = logging.getLogger("app.auth")


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class LocationBrief(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    type: str
    state_code: str


class MeOut(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str
    role_code: str
    role_name: str
    permissions: list[str]
    all_locations: bool
    locations: list[LocationBrief]
    must_change_password: bool
    organization_name: str | None
    csrf_token: str | None = None


def build_me(db: Session, user: User, perms: set[str], loc_ids: set[uuid.UUID] | None) -> MeOut:
    q = select(Location).where(Location.is_active.is_(True)).order_by(Location.type.desc(), Location.name)
    if not user.all_locations:
        q = q.where(Location.id.in_(loc_ids or set()))
    org = db.scalar(select(Organization).limit(1))
    return MeOut(
        id=user.id, email=user.email, full_name=user.full_name, role_code=user.role.code, role_name=user.role.name,
        permissions=sorted(perms), all_locations=user.all_locations,
        locations=[LocationBrief(id=loc.id, code=loc.code, name=loc.name, type=loc.type, state_code=loc.state_code)
                   for loc in db.scalars(q)],
        must_change_password=user.must_change_password,
        organization_name=(org.trade_name or org.legal_name) if org else None,
    )


@router.post("/auth/login", response_model=MeOut)
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    s = get_settings()
    ip = _client_ip(request) or "unknown"
    limiter.hit(f"login:ip:{ip}", s.login_rate_limit_per_minute)
    limiter.hit(f"login:email:{body.email.lower()}", s.login_rate_limit_per_minute)
    try:
        user = authenticate(db, body.email, body.password)
    except Exception:
        audit(db, None, "auth.login_failed", details={"email": body.email.lower()}, ip=ip,
              user_agent=request.headers.get("user-agent"))
        db.commit()
        raise
    token, csrf, _ = create_session(db, user, ip=ip, user_agent=request.headers.get("user-agent"))
    audit(db, user.id, "auth.login", entity_type="user", entity_id=user.id, ip=ip,
          user_agent=request.headers.get("user-agent"))
    db.commit()
    set_session_cookies(response, token, csrf)
    me = build_me(db, user, user.role.permission_codes, user.location_ids)
    me.csrf_token = csrf
    return me


@router.post("/auth/logout")
def logout(response: Response, ctx: AuthContext = Depends(current_user_allow_pending), db: Session = Depends(get_db)):
    sess = db.get(UserSession, ctx.session_id)
    if sess and sess.revoked_at is None:
        sess.revoked_at = datetime.now(UTC)
    audit(db, ctx, "auth.logout", entity_type="user", entity_id=ctx.user_id)
    db.commit()
    clear_session_cookies(response)
    return {"message": "Signed out"}


@router.get("/auth/me", response_model=MeOut)
def me(request: Request, ctx: AuthContext = Depends(current_user_allow_pending), db: Session = Depends(get_db)):
    out = build_me(db, ctx.user, ctx.permissions, ctx.location_ids)
    out.csrf_token = request.cookies.get(get_settings().csrf_cookie_name)
    return out


class ChangePasswordIn(BaseModel):
    current_password: str = Field(max_length=128)
    new_password: str = Field(max_length=128)


@router.post("/auth/change-password")
def change_password(body: ChangePasswordIn, ctx: AuthContext = Depends(current_user_allow_pending),
                    db: Session = Depends(get_db)):
    user = db.get(User, ctx.user_id)
    if not verify_password(user.password_hash, body.current_password):
        raise ValidationFailed("Current password is incorrect", code="invalid_password")
    if body.current_password == body.new_password:
        raise ValidationFailed("New password must differ from the current password")
    set_password(db, user, body.new_password)
    n = revoke_user_sessions(db, user.id, except_session=ctx.session_id)
    audit(db, ctx, "auth.password_changed", entity_type="user", entity_id=user.id, details={"revoked_sessions": n})
    db.commit()
    return {"message": "Password updated"}


class ResetRequestIn(BaseModel):
    email: EmailStr


@router.post("/auth/password-reset/request")
def request_reset(body: ResetRequestIn, request: Request, db: Session = Depends(get_db)):
    limiter.hit(f"reset:ip:{_client_ip(request)}", 5)
    s = get_settings()
    user = db.scalar(select(User).where(User.email.ilike(body.email), User.is_active.is_(True)))
    email_configured = s.smtp_configured
    if user and user.password_hash and email_configured:
        token = create_reset_token(db, user, None, hours=1)
        db.commit()
        try:
            send_email(user.email, "Reset your password",
                       f"Use this link within 1 hour to reset your password:\n{s.public_app_url}/reset-password?token={token}")
        except Exception:  # delivery failure must not reveal whether the account exists
            log.exception("password_reset_email_failed")
    audit(db, None, "auth.password_reset_requested", details={"email": body.email.lower()},
          ip=_client_ip(request))
    db.commit()
    # Same response whether or not the account exists (no user enumeration).
    return {
        "message": "If the account exists, a reset link has been sent."
        if email_configured
        else "Email is not configured. Ask an administrator to issue you a password reset link.",
        "email_configured": email_configured,
    }


class ResetConfirmIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    new_password: str = Field(max_length=128)


@router.post("/auth/password-reset/confirm")
def confirm_reset(body: ResetConfirmIn, request: Request, db: Session = Depends(get_db)):
    limiter.hit(f"reset-confirm:ip:{_client_ip(request)}", 10)
    user = consume_reset_token(db, body.token)
    set_password(db, user, body.new_password)
    revoke_user_sessions(db, user.id)
    audit(db, user.id, "auth.password_reset", entity_type="user", entity_id=user.id, ip=_client_ip(request))
    db.commit()
    return {"message": "Password has been reset. You can now sign in."}


class SessionOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    ip: str | None
    user_agent: str | None
    current: bool


@router.get("/auth/sessions", response_model=list[SessionOut])
def my_sessions(ctx: AuthContext = Depends(current_user), db: Session = Depends(get_db)):
    now = datetime.now(UTC)
    rows = db.scalars(
        select(UserSession).where(UserSession.user_id == ctx.user_id, UserSession.revoked_at.is_(None),
                                  UserSession.expires_at > now).order_by(UserSession.last_seen_at.desc())
    )
    return [SessionOut(id=r.id, created_at=r.created_at, last_seen_at=r.last_seen_at, expires_at=r.expires_at,
                       ip=r.ip, user_agent=r.user_agent, current=r.id == ctx.session_id) for r in rows]


@router.post("/auth/sessions/{session_id}/revoke")
def revoke_my_session(session_id: uuid.UUID, ctx: AuthContext = Depends(current_user), db: Session = Depends(get_db)):
    sess = db.get(UserSession, session_id)
    if sess is None or sess.user_id != ctx.user_id:
        raise NotFound("Session not found")
    sess.revoked_at = datetime.now(UTC)
    audit(db, ctx, "auth.session_revoked", entity_type="session", entity_id=session_id)
    db.commit()
    return {"message": "Session revoked"}


# ---------------------------------------------------------------- first-run setup


@router.get("/setup/status")
def setup_status(db: Session = Depends(get_db)):
    return {"needs_setup": bootstrap.needs_setup(db), "setup_token_required": True,
            "states": [{"code": k, "name": v} for k, v in sorted(STATE_CODES.items())]}


class SetupIn(BaseModel):
    setup_token: str = Field(min_length=16, max_length=200)
    organization_name: str = Field(min_length=2, max_length=200)
    state_code: str = Field(pattern=r"^\d{2}$")
    gstin: str | None = Field(default=None, max_length=15)
    admin_email: EmailStr
    admin_name: str = Field(min_length=2, max_length=120)
    admin_password: str = Field(max_length=128)


@router.post("/setup")
def run_setup(body: SetupIn, request: Request, db: Session = Depends(get_db)):
    """Protected first-run setup. Requires SETUP_TOKEN from the server environment and only works
    while no administrator exists. The CLI (`python -m app.cli create-admin`) is the alternative."""
    limiter.hit(f"setup:ip:{_client_ip(request)}", 5)
    expected = os.environ.get("SETUP_TOKEN", "")
    if len(expected) < 16 or not constant_time_equals(expected, body.setup_token):
        raise Forbidden("Invalid setup token", code="invalid_setup_token")
    if body.state_code not in STATE_CODES:
        raise ValidationFailed("Unknown state code")
    user = bootstrap.create_first_admin(
        db, email=body.admin_email, full_name=body.admin_name, password=body.admin_password,
        org_name=body.organization_name, state_code=body.state_code, gstin=(body.gstin or None),
    )
    audit(db, user.id, "setup.completed", entity_type="user", entity_id=user.id, ip=_client_ip(request))
    db.commit()
    return {"message": "Setup complete. Sign in with the administrator account."}

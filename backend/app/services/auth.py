import uuid
from datetime import UTC, datetime, timedelta

from fastapi import Response
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import Unauthorized, ValidationFailed
from app.core.security import (
    hash_password,
    hash_token,
    needs_rehash,
    new_token,
    password_problems,
    verify_password,
)
from app.models import PasswordResetToken, User, UserSession


def authenticate(db: Session, email: str, password: str) -> User:
    s = get_settings()
    user = db.scalar(select(User).where(User.email.ilike(email.strip())))
    now = datetime.now(UTC)
    if user is not None and user.locked_until and user.locked_until > now:
        raise Unauthorized("Account temporarily locked after repeated failed sign-ins. Try again later.",
                           code="account_locked")
    if user is None or not verify_password(user.password_hash, password):
        if user is not None:
            user.failed_login_count += 1
            if user.failed_login_count >= s.max_failed_logins:
                user.locked_until = now + timedelta(minutes=s.lockout_minutes)
                user.failed_login_count = 0
            db.commit()
        raise Unauthorized("Invalid email or password", code="invalid_credentials")
    if not user.is_active:
        raise Unauthorized("Invalid email or password", code="invalid_credentials")
    user.failed_login_count = 0
    user.locked_until = None
    user.last_login_at = now
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    return user


def create_session(db: Session, user: User, *, ip: str | None, user_agent: str | None) -> tuple[str, str, UserSession]:
    s = get_settings()
    token, csrf = new_token(32), new_token(24)
    sess = UserSession(
        id=uuid.uuid4(), user_id=user.id, token_hash=hash_token(token), csrf_hash=hash_token(csrf),
        expires_at=datetime.now(UTC) + timedelta(hours=s.session_absolute_hours),
        ip=ip, user_agent=(user_agent or "")[:300] or None,
    )
    db.add(sess)
    return token, csrf, sess


def set_session_cookies(response: Response, token: str, csrf: str) -> None:
    s = get_settings()
    max_age = s.session_absolute_hours * 3600
    common = {"secure": s.cookie_secure, "samesite": s.cookie_samesite, "domain": s.cookie_domain, "path": "/",
              "max_age": max_age}
    response.set_cookie(s.session_cookie_name, token, httponly=True, **common)
    response.set_cookie(s.csrf_cookie_name, csrf, httponly=False, **common)


def clear_session_cookies(response: Response) -> None:
    s = get_settings()
    for name in (s.session_cookie_name, s.csrf_cookie_name):
        response.delete_cookie(name, path="/", domain=s.cookie_domain)


def revoke_user_sessions(db: Session, user_id: uuid.UUID, *, except_session: uuid.UUID | None = None) -> int:
    q = update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
    if except_session:
        q = q.where(UserSession.id != except_session)
    return db.execute(q.values(revoked_at=datetime.now(UTC))).rowcount or 0


def set_password(db: Session, user: User, new_password: str, *, must_change: bool = False) -> None:
    problems = password_problems(new_password, user.email)
    if problems:
        raise ValidationFailed("Password does not meet requirements", details=problems)
    user.password_hash = hash_password(new_password)
    user.password_changed_at = datetime.now(UTC)
    user.must_change_password = must_change
    user.failed_login_count = 0
    user.locked_until = None


def create_reset_token(db: Session, user: User, created_by: uuid.UUID | None, hours: int = 24) -> str:
    token = new_token(32)
    db.add(PasswordResetToken(user_id=user.id, token_hash=hash_token(token), created_by=created_by,
                              expires_at=datetime.now(UTC) + timedelta(hours=hours)))
    return token


def consume_reset_token(db: Session, token: str) -> User:
    row = db.scalar(
        select(PasswordResetToken).where(PasswordResetToken.token_hash == hash_token(token)).with_for_update(of=PasswordResetToken)
    )
    now = datetime.now(UTC)
    if row is None or row.used_at is not None or row.expires_at <= now:
        raise ValidationFailed("Reset link is invalid or has expired", code="invalid_token")
    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        raise ValidationFailed("Reset link is invalid or has expired", code="invalid_token")
    row.used_at = now
    return user

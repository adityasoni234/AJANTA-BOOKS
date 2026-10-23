import hashlib
import hmac
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import get_settings

# Argon2id with OWASP-recommended baseline parameters.
_hasher = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=2)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    if not password_hash:
        # Spend comparable time to avoid user enumeration via timing.
        _hasher.hash(password)
        return False
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    """Keyed hash so a database leak does not expose usable session tokens."""
    key = get_settings().secret_key.encode()
    return hmac.new(key, token.encode(), hashlib.sha256).hexdigest()


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


COMMON_PASSWORDS = {
    "password", "password1", "12345678", "123456789", "qwerty123", "admin123", "letmein1",
    "welcome1", "iloveyou", "11111111", "abc12345", "password123", "admin@123",
}


def password_problems(password: str, email: str | None = None) -> list[str]:
    problems: list[str] = []
    if len(password) < 10:
        problems.append("Password must be at least 10 characters long")
    if len(password) > 128:
        problems.append("Password must be at most 128 characters long")
    classes = sum(
        [
            any(c.islower() for c in password),
            any(c.isupper() for c in password),
            any(c.isdigit() for c in password),
            any(not c.isalnum() for c in password),
        ]
    )
    if classes < 3:
        problems.append("Use at least three of: lowercase, uppercase, digits, symbols")
    if password.lower() in COMMON_PASSWORDS:
        problems.append("Password is too common")
    if email and email.split("@")[0].lower() in password.lower():
        problems.append("Password must not contain your email name")
    return problems

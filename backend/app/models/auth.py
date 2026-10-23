import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UUIDPk


class Permission(Base):
    __tablename__ = "permissions"
    code: Mapped[str] = mapped_column(String(60), primary_key=True)
    module: Mapped[str] = mapped_column(String(40))
    description: Mapped[str] = mapped_column(String(200))


class Role(UUIDPk, Timestamps, Base):
    __tablename__ = "roles"
    code: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str | None] = mapped_column(Text)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)

    permissions: Mapped[list["RolePermission"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin"
    )

    @property
    def permission_codes(self) -> set[str]:
        return {p.permission_code for p in self.permissions}


class RolePermission(Base):
    __tablename__ = "role_permissions"
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True)
    permission_code: Mapped[str] = mapped_column(
        ForeignKey("permissions.code", ondelete="CASCADE"), primary_key=True
    )


class User(UUIDPk, Timestamps, Base):
    """Staff member. Users with a password can sign in; others are employee records only."""

    __tablename__ = "users"
    email: Mapped[str] = mapped_column(String(200))
    full_name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(30))
    employee_code: Mapped[str | None] = mapped_column(String(30), unique=True)
    designation: Mapped[str | None] = mapped_column(String(80))
    joined_on: Mapped[date | None] = mapped_column(Date)
    password_hash: Mapped[str | None] = mapped_column(String(300))
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id"))
    all_locations: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    failed_login_count: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column()
    last_login_at: Mapped[datetime | None] = mapped_column()
    password_changed_at: Mapped[datetime | None] = mapped_column()

    role: Mapped[Role] = relationship(lazy="joined")
    location_links: Mapped[list["UserLocation"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin"
    )

    __table_args__ = (Index("uq_users_email", func.lower(email), unique=True),)

    @property
    def location_ids(self) -> set[uuid.UUID]:
        return {link.location_id for link in self.location_links}


class UserLocation(Base):
    __tablename__ = "user_locations"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    location_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("locations.id", ondelete="CASCADE"), primary_key=True
    )


class UserSession(UUIDPk, Base):
    __tablename__ = "sessions"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column()
    revoked_at: Mapped[datetime | None] = mapped_column()
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(300))


class PasswordResetToken(UUIDPk, Base):
    __tablename__ = "password_reset_tokens"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column()
    used_at: Mapped[datetime | None] = mapped_column()
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import AuthContext, require, require_any
from app.core.config import get_settings
from app.core.db import get_db
from app.core.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.models import (
    AuditLog,
    Location,
    Organization,
    Permission,
    Register,
    Role,
    RolePermission,
    User,
    UserLocation,
)
from app.schemas.common import ORM, Page, PageParams, paginate
from app.services.audit import audit
from app.services.auth import create_reset_token, revoke_user_sessions, set_password
from app.services.gst import STATE_CODES, valid_gstin
from app.services.mailer import integration_status
from app.services.reports import local_date
from app.services.settings import PolicySettings, get_policy, save_policy

router = APIRouter(tags=["administration"])


# ---------------------------------------------------------------- locations


class LocationIn(BaseModel):
    code: str = Field(min_length=2, max_length=20, pattern=r"^[A-Z0-9-]+$")
    name: str = Field(min_length=2, max_length=120)
    type: str = Field(pattern=r"^(WAREHOUSE|OUTLET)$")
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    state_code: str = Field(pattern=r"^\d{2}$")
    pincode: str | None = Field(default=None, max_length=10)
    phone: str | None = None
    email: EmailStr | None = None
    gstin: str | None = None
    invoice_prefix: str = Field(min_length=1, max_length=4, pattern=r"^[A-Z0-9]+$")  # keeps invoice numbers ≤ 16 chars
    is_active: bool = True

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v):
        if v:
            v = v.strip().upper()
            if not valid_gstin(v):
                raise ValueError("Invalid GSTIN (format or checksum)")
        return v or None


class LocationOut(ORM):
    id: uuid.UUID
    code: str
    name: str
    type: str
    is_active: bool
    address_line1: str | None
    address_line2: str | None
    city: str | None
    state: str | None
    state_code: str
    pincode: str | None
    phone: str | None
    email: str | None
    gstin: str | None
    invoice_prefix: str
    created_at: datetime


@router.get("/locations", response_model=list[LocationOut])
def list_locations(include_inactive: bool = False, ctx: AuthContext = Depends(require_any("dashboard.view", "pos.sell", "inventory.view", "locations.manage")),
                   db: Session = Depends(get_db)):
    q = select(Location).where(ctx.loc_filter(Location.id)).order_by(Location.type.desc(), Location.name)
    if not include_inactive:
        q = q.where(Location.is_active.is_(True))
    return list(db.scalars(q))


@router.get("/locations/directory", response_model=list[LocationOut])
def location_directory(ctx: AuthContext = Depends(require_any("transfers.create", "transfers.view", "locations.manage")),
                       db: Session = Depends(get_db)):
    """All active locations (names only matter) — needed to pick a transfer source/destination."""
    return list(db.scalars(select(Location).where(Location.is_active.is_(True)).order_by(Location.type.desc(), Location.name)))


def _check_location(body: LocationIn):
    if body.state_code not in STATE_CODES:
        raise ValidationFailed("Unknown state code")
    if body.gstin and body.gstin[:2] != body.state_code:
        raise ValidationFailed("GSTIN state code does not match the location state")


@router.post("/locations", response_model=LocationOut, status_code=201)
def create_location(body: LocationIn, ctx: AuthContext = Depends(require("locations.manage")), db: Session = Depends(get_db)):
    _check_location(body)
    if not ctx.all_locations:
        raise Forbidden("Only organisation-wide administrators can create locations")
    loc = Location(**body.model_dump())
    db.add(loc)
    db.flush()
    if body.type == "OUTLET":
        db.add(Register(location_id=loc.id, name="Counter 1"))
    audit(db, ctx, "location.created", entity_type="location", entity_id=loc.id, location_id=loc.id,
          details=body.model_dump())
    db.commit()
    return loc


@router.put("/locations/{location_id}", response_model=LocationOut)
def update_location(location_id: uuid.UUID, body: LocationIn, ctx: AuthContext = Depends(require("locations.manage")),
                    db: Session = Depends(get_db)):
    loc = db.get(Location, location_id)
    if loc is None:
        raise NotFound("Location not found")
    ctx.ensure_location(location_id)
    _check_location(body)
    if body.type != loc.type:
        raise ValidationFailed("Location type cannot be changed after creation")
    before = LocationOut.model_validate(loc).model_dump()
    for k, v in body.model_dump().items():
        setattr(loc, k, v)
    audit(db, ctx, "location.updated", entity_type="location", entity_id=loc.id, location_id=loc.id,
          details={"before": before, "after": body.model_dump()})
    db.commit()
    return loc


# ---------------------------------------------------------------- organisation & policy


class OrgIn(BaseModel):
    legal_name: str = Field(min_length=2, max_length=200)
    trade_name: str | None = None
    gstin: str | None = None
    gst_registration_type: str = Field(pattern=r"^(REGULAR|COMPOSITION|UNREGISTERED)$")
    pan: str | None = Field(default=None, pattern=r"^[A-Z]{5}\d{4}[A-Z]$")
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    state_code: str = Field(pattern=r"^\d{2}$")
    pincode: str | None = None
    phone: str | None = None
    email: EmailStr | None = None
    financial_year_start_month: int = Field(ge=1, le=12)
    timezone: str = "Asia/Kolkata"

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v):
        if v:
            v = v.strip().upper()
            if not valid_gstin(v):
                raise ValueError("Invalid GSTIN (format or checksum)")
        return v or None


class OrgOut(OrgIn, ORM):
    id: uuid.UUID
    currency: str


@router.get("/organization", response_model=OrgOut)
def get_org(ctx: AuthContext = Depends(require_any("settings.manage", "dashboard.view", "pos.sell")), db: Session = Depends(get_db)):
    org = db.scalar(select(Organization).limit(1))
    if org is None:
        raise NotFound("Organisation not configured")
    return org


@router.put("/organization", response_model=OrgOut)
def update_org(body: OrgIn, ctx: AuthContext = Depends(require("settings.manage")), db: Session = Depends(get_db)):
    org = db.scalar(select(Organization).limit(1))
    if body.gst_registration_type == "REGULAR" and not body.gstin:
        raise ValidationFailed("A GSTIN is required for regular GST registration")
    if body.gstin and body.gstin[:2] != body.state_code:
        raise ValidationFailed("GSTIN state code does not match the organisation state")
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        ZoneInfo(body.timezone)
    except ZoneInfoNotFoundError:
        raise ValidationFailed("Unknown timezone")
    for k, v in body.model_dump().items():
        setattr(org, k, v)
    audit(db, ctx, "organization.updated", entity_type="organization", entity_id=org.id, details=body.model_dump())
    db.commit()
    return org


@router.get("/settings/policy", response_model=PolicySettings)
def read_policy(ctx: AuthContext = Depends(require_any("settings.manage", "pos.sell", "dashboard.view")), db: Session = Depends(get_db)):
    return get_policy(db)


@router.put("/settings/policy", response_model=PolicySettings)
def update_policy(body: PolicySettings, ctx: AuthContext = Depends(require("settings.manage")), db: Session = Depends(get_db)):
    before = get_policy(db).model_dump(mode="json")
    save_policy(db, body, ctx.user_id)
    audit(db, ctx, "settings.policy_updated", entity_type="settings", entity_id="policy",
          details={"before": before, "after": body.model_dump(mode="json")})
    db.commit()
    return body


@router.get("/settings/integrations")
def integrations(ctx: AuthContext = Depends(require("settings.manage"))):
    return integration_status()


@router.get("/reference/states")
def states(_: AuthContext = Depends(require_any("dashboard.view", "pos.sell", "catalog.view"))):
    return [{"code": k, "name": v} for k, v in sorted(STATE_CODES.items())]


# ---------------------------------------------------------------- roles & permissions


class PermissionOut(ORM):
    code: str
    module: str
    description: str


class RoleIn(BaseModel):
    code: str = Field(min_length=2, max_length=40, pattern=r"^[A-Z0-9_]+$")
    name: str = Field(min_length=2, max_length=80)
    description: str | None = None
    permissions: list[str]


class RoleOut(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    description: str | None
    is_system: bool
    permissions: list[str]
    user_count: int = 0


def _role_out(db: Session, r: Role) -> RoleOut:
    n = db.scalar(select(func.count()).select_from(User).where(User.role_id == r.id)) or 0
    return RoleOut(id=r.id, code=r.code, name=r.name, description=r.description, is_system=r.is_system,
                   permissions=sorted(r.permission_codes), user_count=n)


@router.get("/permissions", response_model=list[PermissionOut])
def list_permissions(_: AuthContext = Depends(require_any("roles.manage", "users.view")), db: Session = Depends(get_db)):
    return list(db.scalars(select(Permission).order_by(Permission.module, Permission.code)))


@router.get("/roles", response_model=list[RoleOut])
def list_roles(_: AuthContext = Depends(require_any("roles.manage", "users.view")), db: Session = Depends(get_db)):
    return [_role_out(db, r) for r in db.scalars(select(Role).order_by(Role.is_system.desc(), Role.name))]


def _validate_perms(db: Session, ctx: AuthContext, perms: list[str]) -> list[str]:
    known = set(db.scalars(select(Permission.code)))
    unknown = set(perms) - known
    if unknown:
        raise ValidationFailed(f"Unknown permissions: {', '.join(sorted(unknown))}")
    escalation = set(perms) - ctx.permissions
    if escalation:
        raise Forbidden("You cannot grant permissions you do not hold", details=sorted(escalation))
    return sorted(set(perms))


@router.post("/roles", response_model=RoleOut, status_code=201)
def create_role(body: RoleIn, ctx: AuthContext = Depends(require("roles.manage")), db: Session = Depends(get_db)):
    perms = _validate_perms(db, ctx, body.permissions)
    if db.scalar(select(Role).where(Role.code == body.code)):
        raise Conflict("Role code already exists")
    role = Role(code=body.code, name=body.name, description=body.description, is_system=False)
    role.permissions = [RolePermission(permission_code=p) for p in perms]
    db.add(role)
    db.flush()
    audit(db, ctx, "role.created", entity_type="role", entity_id=role.id, details={"code": body.code, "permissions": perms})
    db.commit()
    return _role_out(db, role)


@router.put("/roles/{role_id}", response_model=RoleOut)
def update_role(role_id: uuid.UUID, body: RoleIn, ctx: AuthContext = Depends(require("roles.manage")), db: Session = Depends(get_db)):
    role = db.get(Role, role_id)
    if role is None:
        raise NotFound("Role not found")
    if role.code == "OWNER":
        raise Forbidden("The owner role always has every permission and cannot be edited")
    if ctx.user.role_id == role.id:
        raise Forbidden("You cannot edit your own role")
    perms = _validate_perms(db, ctx, body.permissions)
    before = sorted(role.permission_codes)
    role.name, role.description = body.name, body.description
    if not role.is_system:
        role.code = body.code
    role.permissions = [RolePermission(permission_code=p) for p in perms]
    audit(db, ctx, "role.updated", entity_type="role", entity_id=role.id, details={"before": before, "after": perms})
    db.commit()
    return _role_out(db, role)


@router.delete("/roles/{role_id}", status_code=204)
def delete_role(role_id: uuid.UUID, ctx: AuthContext = Depends(require("roles.manage")), db: Session = Depends(get_db)):
    role = db.get(Role, role_id)
    if role is None:
        raise NotFound("Role not found")
    if role.is_system:
        raise Forbidden("System roles cannot be deleted")
    if db.scalar(select(func.count()).select_from(User).where(User.role_id == role.id)):
        raise Conflict("Role is assigned to users; reassign them first")
    audit(db, ctx, "role.deleted", entity_type="role", entity_id=role.id, details={"code": role.code})
    db.delete(role)
    db.commit()


# ---------------------------------------------------------------- users / employees


class UserIn(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=120)
    phone: str | None = Field(default=None, max_length=30)
    employee_code: str | None = Field(default=None, max_length=30)
    designation: str | None = Field(default=None, max_length=80)
    joined_on: date | None = None
    role_id: uuid.UUID
    all_locations: bool = False
    location_ids: list[uuid.UUID] = []
    is_active: bool = True
    can_login: bool = True
    initial_password: str | None = Field(default=None, max_length=128)


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str
    phone: str | None
    employee_code: str | None
    designation: str | None
    joined_on: date | None
    role_id: uuid.UUID
    role_name: str
    role_code: str
    all_locations: bool
    location_ids: list[uuid.UUID]
    is_active: bool
    can_login: bool
    must_change_password: bool
    last_login_at: datetime | None
    locked: bool
    created_at: datetime


def _user_out(u: User) -> UserOut:
    from datetime import UTC
    from datetime import datetime as dt

    return UserOut(
        id=u.id, email=u.email, full_name=u.full_name, phone=u.phone, employee_code=u.employee_code,
        designation=u.designation, joined_on=u.joined_on, role_id=u.role_id, role_name=u.role.name,
        role_code=u.role.code, all_locations=u.all_locations, location_ids=sorted(u.location_ids, key=str),
        is_active=u.is_active, can_login=u.password_hash is not None, must_change_password=u.must_change_password,
        last_login_at=u.last_login_at, locked=bool(u.locked_until and u.locked_until > dt.now(UTC)),
        created_at=u.created_at,
    )


def _guard_assignment(db: Session, ctx: AuthContext, body: UserIn) -> Role:
    role = db.get(Role, body.role_id)
    if role is None:
        raise ValidationFailed("Role not found")
    if not role.permission_codes <= ctx.permissions:
        raise Forbidden("You cannot assign a role with more permissions than your own")
    if body.all_locations and not ctx.all_locations:
        raise Forbidden("You cannot grant organisation-wide location access")
    for lid in body.location_ids:
        ctx.ensure_location(lid)
        if db.get(Location, lid) is None:
            raise ValidationFailed("Unknown location")
    if not body.all_locations and not body.location_ids:
        raise ValidationFailed("Assign at least one location or organisation-wide access")
    return role


def _visible_user(ctx: AuthContext, u: User) -> bool:
    if ctx.all_locations:
        return True
    return not u.all_locations and bool(u.location_ids & ctx.location_ids)


@router.get("/users", response_model=Page[UserOut])
def list_users(q: str | None = None, role_id: uuid.UUID | None = None, location_id: uuid.UUID | None = None,
               active: bool | None = None, params: PageParams = Depends(),
               ctx: AuthContext = Depends(require("users.view")), db: Session = Depends(get_db)):
    stmt = select(User).order_by(User.full_name)
    if not ctx.all_locations:
        stmt = stmt.where(User.all_locations.is_(False),
                          User.id.in_(select(UserLocation.user_id).where(UserLocation.location_id.in_(ctx.location_ids))))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(User.full_name.ilike(like), User.email.ilike(like), User.employee_code.ilike(like)))
    if role_id:
        stmt = stmt.where(User.role_id == role_id)
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(or_(User.all_locations.is_(True),
                              User.id.in_(select(UserLocation.user_id).where(UserLocation.location_id == location_id))))
    if active is not None:
        stmt = stmt.where(User.is_active.is_(active))
    rows, total = paginate(db, stmt, params)
    return Page(items=[_user_out(u) for u in rows], total=total, page=params.page, page_size=params.page_size)


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(body: UserIn, ctx: AuthContext = Depends(require("users.manage")), db: Session = Depends(get_db)):
    _guard_assignment(db, ctx, body)
    if db.scalar(select(User).where(func.lower(User.email) == body.email.lower())):
        raise Conflict("A user with this email already exists")
    u = User(email=body.email.lower(), full_name=body.full_name, phone=body.phone, employee_code=body.employee_code,
             designation=body.designation, joined_on=body.joined_on, role_id=body.role_id,
             all_locations=body.all_locations, is_active=body.is_active)
    u.location_links = [UserLocation(location_id=lid) for lid in set(body.location_ids)] if not body.all_locations else []
    if body.can_login:
        if not body.initial_password:
            raise ValidationFailed("An initial password is required for users who can sign in")
        set_password(db, u, body.initial_password, must_change=True)
    db.add(u)
    db.flush()
    db.refresh(u)
    audit(db, ctx, "user.created", entity_type="user", entity_id=u.id,
          details={"email": u.email, "role": u.role.code, "locations": body.location_ids, "all_locations": body.all_locations})
    db.commit()
    return _user_out(u)


@router.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: uuid.UUID, ctx: AuthContext = Depends(require("users.view")), db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if u is None or not _visible_user(ctx, u):
        raise NotFound("User not found")
    return _user_out(u)


@router.put("/users/{user_id}", response_model=UserOut)
def update_user(user_id: uuid.UUID, body: UserIn, ctx: AuthContext = Depends(require("users.manage")), db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if u is None or not _visible_user(ctx, u):
        raise NotFound("User not found")
    if u.id == ctx.user_id and (body.role_id != u.role_id or not body.is_active or body.all_locations != u.all_locations):
        raise Forbidden("You cannot change your own role, scope or active status")
    if not u.role.permission_codes <= ctx.permissions:
        raise Forbidden("You cannot modify a user with more permissions than your own")
    _guard_assignment(db, ctx, body)
    if body.email.lower() != u.email and db.scalar(select(User).where(func.lower(User.email) == body.email.lower())):
        raise Conflict("A user with this email already exists")
    before = _user_out(u).model_dump(mode="json")
    scope_changed = (body.role_id != u.role_id or body.all_locations != u.all_locations
                     or set(body.location_ids) != u.location_ids)
    u.email, u.full_name, u.phone = body.email.lower(), body.full_name, body.phone
    u.employee_code, u.designation, u.joined_on = body.employee_code, body.designation, body.joined_on
    u.role_id, u.all_locations, u.is_active = body.role_id, body.all_locations, body.is_active
    u.location_links = [] if body.all_locations else [UserLocation(location_id=lid) for lid in set(body.location_ids)]
    if not body.can_login and u.password_hash:
        u.password_hash = None
        revoke_user_sessions(db, u.id)
    elif body.can_login and not u.password_hash:
        if not body.initial_password:
            raise ValidationFailed("An initial password is required to enable sign-in")
        set_password(db, u, body.initial_password, must_change=True)
    if not body.is_active:
        revoke_user_sessions(db, u.id)
    db.flush()
    db.refresh(u)
    audit(db, ctx, "user.updated", entity_type="user", entity_id=u.id,
          details={"before": before, "after": _user_out(u).model_dump(mode="json"), "scope_changed": scope_changed})
    db.commit()
    return _user_out(u)


@router.post("/users/{user_id}/reset-password")
def admin_reset_password(user_id: uuid.UUID, ctx: AuthContext = Depends(require("users.manage")), db: Session = Depends(get_db)):
    """Issue a one-time reset link (shown once to the administrator) and revoke the user's sessions."""
    u = db.get(User, user_id)
    if u is None or not _visible_user(ctx, u):
        raise NotFound("User not found")
    if not u.role.permission_codes <= ctx.permissions:
        raise Forbidden("You cannot reset the password of a user with more permissions than your own")
    token = create_reset_token(db, u, ctx.user_id, hours=24)
    revoke_user_sessions(db, u.id)
    audit(db, ctx, "user.password_reset_issued", entity_type="user", entity_id=u.id)
    db.commit()
    return {"reset_url": f"{get_settings().public_app_url}/reset-password?token={token}", "expires_in_hours": 24}


@router.post("/users/{user_id}/revoke-sessions")
def admin_revoke_sessions(user_id: uuid.UUID, ctx: AuthContext = Depends(require("users.manage")), db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if u is None or not _visible_user(ctx, u):
        raise NotFound("User not found")
    n = revoke_user_sessions(db, u.id, except_session=ctx.session_id if u.id == ctx.user_id else None)
    audit(db, ctx, "user.sessions_revoked", entity_type="user", entity_id=u.id, details={"count": n})
    db.commit()
    return {"revoked": n}


@router.post("/users/{user_id}/unlock")
def unlock_user(user_id: uuid.UUID, ctx: AuthContext = Depends(require("users.manage")), db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if u is None or not _visible_user(ctx, u):
        raise NotFound("User not found")
    u.locked_until = None
    u.failed_login_count = 0
    audit(db, ctx, "user.unlocked", entity_type="user", entity_id=u.id)
    db.commit()
    return {"message": "Account unlocked"}


# ---------------------------------------------------------------- audit log


class AuditOut(ORM):
    id: int
    ts: datetime
    actor_id: uuid.UUID | None
    actor_name: str | None = None
    action: str
    entity_type: str | None
    entity_id: str | None
    location_id: uuid.UUID | None
    ip: str | None
    request_id: str | None
    details: dict


@router.get("/audit-logs", response_model=Page[AuditOut])
def audit_logs(action: str | None = None, actor_id: uuid.UUID | None = None, entity_type: str | None = None,
               entity_id: str | None = None, location_id: uuid.UUID | None = None,
               date_from: date | None = None, date_to: date | None = None,
               params: PageParams = Depends(), ctx: AuthContext = Depends(require("audit.view")),
               db: Session = Depends(get_db)):
    stmt = select(AuditLog, User.full_name).outerjoin(User, User.id == AuditLog.actor_id).order_by(AuditLog.id.desc())
    if not ctx.all_locations:
        stmt = stmt.where(AuditLog.location_id.in_(ctx.location_ids))
    if action:
        stmt = stmt.where(AuditLog.action.ilike(f"{action}%"))
    if actor_id:
        stmt = stmt.where(AuditLog.actor_id == actor_id)
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    if location_id:
        ctx.ensure_location(location_id)
        stmt = stmt.where(AuditLog.location_id == location_id)
    if date_from:
        stmt = stmt.where(local_date(db, AuditLog.ts) >= date_from)
    if date_to:
        stmt = stmt.where(local_date(db, AuditLog.ts) <= date_to)
    rows, total = paginate(db, stmt, params, scalars=False)
    items = []
    for log, name in rows:
        o = AuditOut.model_validate(log)
        o.actor_name = name
        items.append(o)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


__all__ = ["router", "Query"]

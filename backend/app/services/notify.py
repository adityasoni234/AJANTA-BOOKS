"""In-app notifications fanned out to users who hold a permission for a location."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Notification, RolePermission, User, UserLocation


def users_with_permission(db: Session, perm: str, location_id: uuid.UUID | None) -> list[uuid.UUID]:
    q = (
        select(User.id)
        .join(RolePermission, RolePermission.role_id == User.role_id)
        .where(RolePermission.permission_code == perm, User.is_active.is_(True), User.password_hash.is_not(None))
    )
    if location_id is not None:
        q = q.where(
            (User.all_locations.is_(True))
            | User.id.in_(select(UserLocation.user_id).where(UserLocation.location_id == location_id))
        )
    else:
        q = q.where(User.all_locations.is_(True))
    return list(db.scalars(q))


def notify_users(db: Session, user_ids, *, kind: str, title: str, body: str | None = None, link: str | None = None,
                 location_id: uuid.UUID | None = None, exclude: uuid.UUID | None = None) -> int:
    n = 0
    for uid in set(user_ids):
        if uid == exclude:
            continue
        db.add(Notification(user_id=uid, kind=kind, title=title[:200], body=body, link=link, location_id=location_id))
        n += 1
    return n


def notify_permission(db: Session, perm: str, location_id: uuid.UUID | None, *, kind: str, title: str,
                      body: str | None = None, link: str | None = None, exclude: uuid.UUID | None = None) -> int:
    return notify_users(
        db, users_with_permission(db, perm, location_id), kind=kind, title=title, body=body, link=link,
        location_id=location_id, exclude=exclude,
    )

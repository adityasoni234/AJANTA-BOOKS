import json
import uuid
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.logging import request_id_ctx
from app.models import AuditLog


def _clean(obj):
    return json.loads(json.dumps(obj, default=lambda o: str(o) if isinstance(o, (Decimal, uuid.UUID)) else str(o)))


def audit(db: Session, actor, action: str, *, entity_type: str | None = None, entity_id=None,
          location_id=None, details: dict | None = None, ip: str | None = None, user_agent: str | None = None) -> None:
    actor_id = getattr(actor, "user_id", None) or getattr(actor, "id", None) or (actor if isinstance(actor, uuid.UUID) else None)
    db.add(
        AuditLog(
            actor_id=actor_id,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id else None,
            location_id=location_id,
            ip=ip or getattr(actor, "ip", None),
            user_agent=(user_agent or getattr(actor, "user_agent", None) or "")[:300] or None,
            request_id=request_id_ctx.get(),
            details=_clean(details or {}),
        )
    )

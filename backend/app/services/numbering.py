"""Gapless, never-reused document numbering using row-locked sequences."""

from datetime import date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models import DocumentSequence, Organization


def org_tz(db: Session) -> ZoneInfo:
    org = db.scalar(select(Organization).limit(1))
    return ZoneInfo(org.timezone if org else "Asia/Kolkata")


def local_today(db: Session) -> date:
    return datetime.now(org_tz(db)).date()


def financial_year(d: date, start_month: int = 4) -> str:
    start = d.year if d.month >= start_month else d.year - 1
    if start_month == 1:
        return f"{start}"
    return f"{start}-{str(start + 1)[-2:]}"


def _fy_short(fy: str) -> str:
    # "2026-27" -> "2627"
    return fy[2:4] + fy[-2:] if "-" in fy else fy[-2:]


def current_fy(db: Session) -> str:
    org = db.scalar(select(Organization).limit(1))
    start_month = org.financial_year_start_month if org else 4
    return financial_year(local_today(db), start_month)


def next_number(db: Session, doc_type: str, *, scope: str = "ORG", prefix: str | None = None, width: int = 5,
                fy: str | None = None) -> str:
    """Issue the next number for (scope, doc_type, fy). Locks the sequence row until commit,
    so concurrent transactions serialize and numbers are never duplicated."""
    fy = fy or current_fy(db)
    prefix = prefix if prefix is not None else doc_type
    db.execute(
        insert(DocumentSequence)
        .values(scope=scope, doc_type=doc_type, financial_year=fy, prefix=prefix, next_value=1)
        .on_conflict_do_nothing(index_elements=["scope", "doc_type", "financial_year"])
    )
    seq = db.scalars(
        select(DocumentSequence)
        .where(
            DocumentSequence.scope == scope,
            DocumentSequence.doc_type == doc_type,
            DocumentSequence.financial_year == fy,
        )
        .with_for_update(of=DocumentSequence)
    ).one()
    value = seq.next_value
    seq.next_value = value + 1
    db.flush()
    return f"{seq.prefix}/{_fy_short(fy)}/{value:0{width}d}"


def next_code(db: Session, doc_type: str, prefix: str, width: int = 6) -> str:
    """Non-FY running code (SKU, customer codes, copy codes)."""
    db.execute(
        insert(DocumentSequence)
        .values(scope="ORG", doc_type=doc_type, financial_year="ALL", prefix=prefix, next_value=1)
        .on_conflict_do_nothing(index_elements=["scope", "doc_type", "financial_year"])
    )
    seq = db.scalars(
        select(DocumentSequence)
        .where(
            DocumentSequence.scope == "ORG",
            DocumentSequence.doc_type == doc_type,
            DocumentSequence.financial_year == "ALL",
        )
        .with_for_update(of=DocumentSequence)
    ).one()
    value = seq.next_value
    seq.next_value = value + 1
    db.flush()
    return f"{prefix}{value:0{width}d}"


def sequence_number(db: Session, sequence: str, prefix: str, width: int = 7) -> str:
    """Unique (not gapless) number from a PostgreSQL sequence; never blocks concurrent writers."""
    if sequence not in ("journal_entry_seq", "payment_seq"):
        raise ValueError("Unknown sequence")
    value = db.execute(text(f"select nextval('{sequence}')")).scalar_one()
    return f"{prefix}-{value:0{width}d}"

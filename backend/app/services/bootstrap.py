"""Idempotent reference-data bootstrap and first-administrator creation."""

from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import Conflict
from app.models import (
    Account,
    ExpenseCategory,
    Organization,
    PaymentMethod,
    Permission,
    Role,
    RolePermission,
    TaxClass,
    User,
)
from app.services import accounting
from app.services.auth import set_password
from app.services.permissions import PERMISSIONS, ROLE_TEMPLATES

TAX_CLASSES = [
    # code, name, rate, exempt
    ("GST0", "Nil-rated / Exempt (0%)", Decimal("0"), True),
    ("GST5", "GST 5%", Decimal("5"), False),
    ("GST12", "GST 12%", Decimal("12"), False),
    ("GST18", "GST 18%", Decimal("18"), False),
    ("GST28", "GST 28%", Decimal("28"), False),
]

PAYMENT_METHODS = [
    # code, name, kind, account key, requires_reference
    ("CASH", "Cash", "CASH", "CASH", False),
    ("UPI", "UPI", "UPI", "UPI_CLEARING", True),
    ("CARD", "Card", "CARD", "CARD_CLEARING", True),
    ("BANK", "Bank Transfer", "BANK_TRANSFER", "BANK", True),
    ("STORE_CREDIT", "Store Credit", "STORE_CREDIT", "STORE_CREDIT", False),
    ("CREDIT", "Credit (Pay Later)", "CREDIT", "AR", False),
    ("EXCHANGE", "Exchange Credit", "EXCHANGE", "EXCHANGE_CLEARING", False),
]


def ensure_reference_data(db: Session) -> None:
    for code, (module, desc) in PERMISSIONS.items():
        p = db.get(Permission, code)
        if p is None:
            db.add(Permission(code=code, module=module, description=desc))
        else:
            p.module, p.description = module, desc
    db.flush()
    for code, tpl in ROLE_TEMPLATES.items():
        role = db.scalar(select(Role).where(Role.code == code))
        if role is None:
            role = Role(code=code, name=tpl["name"], description=tpl["description"], is_system=True)
            role.permissions = [RolePermission(permission_code=p) for p in sorted(tpl["permissions"])]
            db.add(role)
        elif code == "OWNER":
            have = role.permission_codes
            for p in sorted(set(PERMISSIONS) - have):
                role.permissions.append(RolePermission(permission_code=p))
    db.flush()
    accounting.ensure_chart_of_accounts(db)
    for code, name, label in accounting.DEFAULT_EXPENSE_ACCOUNTS:
        acc = db.scalar(select(Account).where(Account.code == code))
        if acc is None:
            acc = Account(code=code, name=name, type="EXPENSE")
            db.add(acc)
            db.flush()
        if db.scalar(select(ExpenseCategory).where(ExpenseCategory.name == label)) is None:
            db.add(ExpenseCategory(name=label, account_id=acc.id))
    for i, (code, name, kind, acc_key, ref) in enumerate(PAYMENT_METHODS):
        if db.scalar(select(PaymentMethod).where(PaymentMethod.code == code)) is None:
            acc = accounting.account_by_key(db, acc_key)
            db.add(PaymentMethod(code=code, name=name, kind=kind, account_id=acc.id, requires_reference=ref,
                                 sort_order=i, is_active=kind not in ("CREDIT",)))
    for code, name, rate, exempt in TAX_CLASSES:
        if db.scalar(select(TaxClass).where(TaxClass.code == code)) is None:
            db.add(TaxClass(code=code, name=name, rate=rate, is_exempt=exempt))
    db.flush()


def needs_setup(db: Session) -> bool:
    return (db.scalar(select(func.count()).select_from(User).where(User.password_hash.is_not(None))) or 0) == 0


def create_first_admin(db: Session, *, email: str, full_name: str, password: str, org_name: str,
                       state_code: str = "27", gstin: str | None = None) -> User:
    if not needs_setup(db):
        raise Conflict("Setup has already been completed")
    ensure_reference_data(db)
    if db.scalar(select(Organization).limit(1)) is None:
        db.add(Organization(legal_name=org_name, trade_name=org_name, state_code=state_code, gstin=gstin,
                            gst_registration_type="REGULAR" if gstin else "UNREGISTERED"))
    owner = db.scalar(select(Role).where(Role.code == "OWNER"))
    user = User(email=email.strip().lower(), full_name=full_name, role_id=owner.id, all_locations=True)
    set_password(db, user, password)
    db.add(user)
    db.flush()
    return user

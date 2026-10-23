"""Operational CLI.

    python -m app.cli bootstrap                 # idempotent reference data (roles, permissions, chart of accounts…)
    python -m app.cli create-admin --email ... --name ... --org-name ... --state-code 27
    python -m app.cli seed-demo                 # deterministic demo data (refuses in production)
    python -m app.cli daily-jobs                # supplier-due reminders, session cleanup
    python -m app.cli reconcile-inventory       # ledger vs balance check (exit code 1 on discrepancy)
    python -m app.cli check-config              # validate environment
"""

import argparse
import getpass
import os
import sys
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import delete, select

from app.core.config import get_settings
from app.core.db import session_factory


def cmd_bootstrap(_args) -> int:
    from app.services.bootstrap import ensure_reference_data

    with session_factory()() as db:
        ensure_reference_data(db)
        db.commit()
    print("Reference data is up to date.")
    return 0


def cmd_create_admin(args) -> int:
    from app.services.bootstrap import create_first_admin

    password = os.environ.get("ADMIN_PASSWORD") or getpass.getpass("Administrator password: ")
    if not os.environ.get("ADMIN_PASSWORD") and password != getpass.getpass("Repeat password: "):
        print("Passwords do not match", file=sys.stderr)
        return 1
    with session_factory()() as db:
        try:
            user = create_first_admin(db, email=args.email, full_name=args.name, password=password,
                                      org_name=args.org_name, state_code=args.state_code, gstin=args.gstin)
        except Exception as e:  # noqa: BLE001 - CLI surface
            print(f"Error: {getattr(e, 'message', e)} {getattr(e, 'details', '') or ''}", file=sys.stderr)
            return 1
        db.commit()
        print(f"Administrator {user.email} created. Sign in and complete organisation settings.")
    return 0


def cmd_seed_demo(args) -> int:
    if get_settings().app_env == "production":
        print("Refusing to seed demo data in production.", file=sys.stderr)
        return 1
    from app.seed import seed_demo

    with session_factory()() as db:
        seed_demo(db, password=args.password)
    return 0


def cmd_daily_jobs(_args) -> int:
    from app.models import SupplierInvoice, UserSession
    from app.services.notify import notify_permission

    with session_factory()() as db:
        soon = date.today() + timedelta(days=3)
        due = list(db.scalars(select(SupplierInvoice).where(
            SupplierInvoice.status.in_(["OPEN", "PARTIALLY_PAID"]), SupplierInvoice.due_date <= soon)))
        for si in due:
            state = "overdue" if si.due_date < date.today() else f"due {si.due_date:%d %b}"
            notify_permission(db, "finance.manage", si.location_id, kind="SUPPLIER_DUE",
                              title=f"Supplier invoice {si.invoice_number} ({si.supplier.name}) is {state}",
                              body=f"Balance ₹{si.total - si.amount_paid}", link="/finance/payables")
        cutoff = datetime.now(UTC) - timedelta(days=30)
        removed = db.execute(delete(UserSession).where(UserSession.expires_at < cutoff)).rowcount
        db.commit()
    print(f"Supplier reminders: {len(due)}; expired sessions removed: {removed}")
    return 0


def cmd_reconcile(_args) -> int:
    from app.services.inventory import reconcile

    with session_factory()() as db:
        issues = reconcile(db)
    if issues:
        for i in issues:
            print(i)
        print(f"{len(issues)} discrepancy(ies) found", file=sys.stderr)
        return 1
    print("Inventory balances reconcile with the ledger and copy registry.")
    return 0


def cmd_check_config(_args) -> int:
    s = get_settings()
    print(f"env={s.app_env} db={s.database_url.split('@')[-1]} cookie_secure={s.cookie_secure} "
          f"smtp={'configured' if s.smtp_configured else 'not configured'}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="app.cli")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("bootstrap").set_defaults(fn=cmd_bootstrap)
    a = sub.add_parser("create-admin")
    a.add_argument("--email", required=True)
    a.add_argument("--name", required=True)
    a.add_argument("--org-name", required=True)
    a.add_argument("--state-code", default="27")
    a.add_argument("--gstin", default=None)
    a.set_defaults(fn=cmd_create_admin)
    s = sub.add_parser("seed-demo")
    s.add_argument("--password", default=os.environ.get("DEMO_PASSWORD", "Demo@Books2026"))
    s.set_defaults(fn=cmd_seed_demo)
    sub.add_parser("daily-jobs").set_defaults(fn=cmd_daily_jobs)
    sub.add_parser("reconcile-inventory").set_defaults(fn=cmd_reconcile)
    sub.add_parser("check-config").set_defaults(fn=cmd_check_config)
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())

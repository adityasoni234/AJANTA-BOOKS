"""Double-entry posting engine.

Posting rules (system accounts are looked up by `system_key`, so codes/names are configurable):
  Goods receipt        Dr INVENTORY                       Cr GRNI
  Supplier invoice     Dr GRNI (+variance), Dr INPUT_*GST Cr AP
  Supplier payment     Dr AP                              Cr cash/bank
  Sale                 Dr payment accounts (or AR)        Cr SALES, Cr OUTPUT_*GST, ±ROUND_OFF
                       Dr COGS                            Cr INVENTORY        (at weighted-average cost)
  Return / credit note Dr SALES_RETURNS, Dr OUTPUT_*GST    Cr refund account; Dr INVENTORY Cr COGS
  Stock adjustment     Dr/Cr INVENTORY                    Cr/Dr INVENTORY_ADJ (or OPENING_EQUITY)
  Expense              Dr expense account                 Cr cash/bank
  Register close       Dr/Cr CASH_OVER_SHORT              Cr/Dr CASH
Entries are immutable; corrections are made with reversal entries.
"""

import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AppError, Conflict, ValidationFailed
from app.core.money import ZERO, r2
from app.models import Account, JournalEntry, JournalLine
from app.services.numbering import local_today, sequence_number

SYSTEM_ACCOUNTS: list[tuple[str, str, str, str, bool]] = [
    # key, code, name, type, is_cash_or_bank
    ("CASH", "1000", "Cash on Hand", "ASSET", True),
    ("BANK", "1010", "Bank Account", "ASSET", True),
    ("UPI_CLEARING", "1020", "UPI Collections", "ASSET", True),
    ("CARD_CLEARING", "1030", "Card Settlements Clearing", "ASSET", True),
    ("AR", "1100", "Accounts Receivable", "ASSET", False),
    ("INVENTORY", "1200", "Inventory", "ASSET", False),
    ("INPUT_CGST", "1300", "Input CGST", "ASSET", False),
    ("INPUT_SGST", "1301", "Input SGST", "ASSET", False),
    ("INPUT_IGST", "1302", "Input IGST", "ASSET", False),
    ("AP", "2000", "Accounts Payable", "LIABILITY", False),
    ("GRNI", "2010", "Goods Received Not Invoiced", "LIABILITY", False),
    ("OUTPUT_CGST", "2100", "Output CGST", "LIABILITY", False),
    ("OUTPUT_SGST", "2101", "Output SGST", "LIABILITY", False),
    ("OUTPUT_IGST", "2102", "Output IGST", "LIABILITY", False),
    ("STORE_CREDIT", "2200", "Customer Store Credit", "LIABILITY", False),
    ("EXCHANGE_CLEARING", "2210", "Exchange Credit Clearing", "LIABILITY", False),
    ("OPENING_EQUITY", "3000", "Opening Balance Equity", "EQUITY", False),
    ("OWNER_CAPITAL", "3100", "Owner's Capital", "EQUITY", False),
    ("RETAINED_EARNINGS", "3200", "Retained Earnings", "EQUITY", False),
    ("SALES", "4000", "Sales Revenue", "INCOME", False),
    ("SALES_RETURNS", "4010", "Sales Returns", "INCOME", False),
    ("ROUND_OFF", "4900", "Rounding Adjustments", "INCOME", False),
    ("COGS", "5000", "Cost of Goods Sold", "EXPENSE", False),
    ("INVENTORY_ADJ", "5100", "Inventory Shrinkage & Write-offs", "EXPENSE", False),
    ("PURCHASE_VARIANCE", "5110", "Purchase Price Variance", "EXPENSE", False),
    ("CASH_OVER_SHORT", "5200", "Cash Over / Short", "EXPENSE", False),
    ("LOYALTY_EXPENSE", "5300", "Loyalty Rewards", "EXPENSE", False),
]

DEFAULT_EXPENSE_ACCOUNTS = [
    ("6000", "Rent", "Rent"),
    ("6010", "Salaries & Wages", "Salaries"),
    ("6020", "Electricity & Utilities", "Utilities"),
    ("6030", "Store Supplies", "Store Supplies"),
    ("6040", "Freight & Transport", "Transport"),
    ("6050", "Marketing & Advertising", "Marketing"),
    ("6060", "Repairs & Maintenance", "Maintenance"),
    ("6090", "Miscellaneous Expenses", "Miscellaneous"),
]


@dataclass
class Leg:
    account: str | uuid.UUID  # system key or account id
    amount: Decimal  # positive = debit, negative = credit
    location_id: uuid.UUID | None = None
    memo: str | None = None


def account_by_key(db: Session, key: str) -> Account:
    acc = db.scalar(select(Account).where(Account.system_key == key))
    if acc is None:
        raise AppError(f"System account {key} is not configured", code="accounting_setup")
    return acc


def _resolve(db: Session, ref: str | uuid.UUID, cache: dict) -> Account:
    if ref in cache:
        return cache[ref]
    acc = db.get(Account, ref) if isinstance(ref, uuid.UUID) else account_by_key(db, ref)
    if acc is None or not acc.is_active:
        raise ValidationFailed("Account not found or inactive")
    cache[ref] = acc
    return acc


def post(db: Session, *, source_type: str, source_id: uuid.UUID | None, legs: list[Leg], memo: str | None = None,
         location_id: uuid.UUID | None = None, actor_id: uuid.UUID | None = None,
         entry_date: date | None = None, reversal_of_id: uuid.UUID | None = None) -> JournalEntry | None:
    """Post a balanced journal entry. Legs with zero amounts are dropped; same account+location legs
    are netted. Returns None if nothing remains to post."""
    cache: dict = {}
    net: dict[tuple, Decimal] = {}
    order: list[tuple] = []
    for leg in legs:
        amt = r2(leg.amount)
        if amt == ZERO:
            continue
        acc = _resolve(db, leg.account, cache)
        k = (acc.id, leg.location_id if leg.location_id is not None else location_id, leg.memo)
        if k not in net:
            order.append(k)
            net[k] = ZERO
        net[k] += amt
    rows = [(k, net[k]) for k in order if net[k] != ZERO]
    if not rows:
        return None
    total = sum((a for _, a in rows), ZERO)
    if total != ZERO:
        raise AppError(f"Unbalanced journal for {source_type}: difference {total}", code="unbalanced_journal")
    entry = JournalEntry(
        id=uuid.uuid4(),
        number=sequence_number(db, "journal_entry_seq", "JV"),
        entry_date=entry_date or local_today(db),
        source_type=source_type,
        source_id=source_id,
        memo=memo,
        location_id=location_id,
        reversal_of_id=reversal_of_id,
        created_by=actor_id,
    )
    db.add(entry)
    db.flush()
    for (acc_id, loc_id, line_memo), amt in rows:
        db.add(
            JournalLine(
                entry_id=entry.id,
                account_id=acc_id,
                debit=amt if amt > 0 else ZERO,
                credit=-amt if amt < 0 else ZERO,
                location_id=loc_id,
                memo=line_memo,
            )
        )
    db.flush()
    return entry


def reverse(db: Session, entry: JournalEntry, *, actor_id: uuid.UUID | None, memo: str | None = None,
            source_type: str | None = None, source_id: uuid.UUID | None = None) -> JournalEntry:
    existing = db.scalar(select(JournalEntry).where(JournalEntry.reversal_of_id == entry.id))
    if existing is not None:
        raise Conflict("This journal entry has already been reversed")
    if entry.reversal_of_id is not None:
        raise Conflict("A reversal entry cannot itself be reversed; post a new entry instead")
    legs = [
        Leg(account=line.account_id, amount=line.credit - line.debit, location_id=line.location_id, memo=line.memo)
        for line in entry.lines
    ]
    rev = post(
        db,
        source_type=source_type or entry.source_type,
        source_id=source_id or entry.source_id,
        legs=legs,
        memo=memo or f"Reversal of {entry.number}",
        location_id=entry.location_id,
        actor_id=actor_id,
        reversal_of_id=entry.id,
    )
    assert rev is not None
    return rev


def ensure_chart_of_accounts(db: Session) -> None:
    for key, code, name, typ, cash in SYSTEM_ACCOUNTS:
        if db.scalar(select(Account).where(Account.system_key == key)) is None:
            db.add(Account(code=code, name=name, type=typ, system_key=key, is_cash_or_bank=cash))
    db.flush()

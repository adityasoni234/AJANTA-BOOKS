"""Deterministic demo data for local development and demos (never production).

Everything is created through the real service layer (purchase orders, goods receipts, transfers,
POS checkout, returns, expenses, register sessions), so stock, invoices and journals are fully
consistent. To give dashboards a 30-day history, each simulated day's transactions are then
shifted back in time (demo-only; requires a database role that may set session_replication_role).
"""

import random
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.api.deps import AuthContext
from app.models import (
    Account,
    Book,
    Category,
    Customer,
    ExpenseCategory,
    Location,
    Organization,
    PaymentMethod,
    Register,
    Role,
    Sale,
    Supplier,
    TaxClass,
    User,
    UserLocation,
)
from app.services import finance, purchasing, returns, sales, transfers
from app.services import inventory as inv
from app.services.auth import set_password
from app.services.bootstrap import ensure_reference_data
from app.services.catalog import BookIn, create_book
from app.services.gst import gstin_checksum_char
from app.services.identifiers import ean13_check_digit
from app.services.numbering import next_code
from app.services.settings import PolicySettings, save_policy

R = random.Random(20261023)
D = Decimal

SHIFT_TABLES = {
    "sales": ["created_at"], "invoices": ["issued_at"], "payments": ["created_at"],
    "inventory_ledger": ["created_at"], "journal_entries": ["posted_at"], "register_sessions": ["opened_at", "closed_at"],
    "returns": ["created_at", "completed_at"], "copy_events": ["created_at"], "customer_ledger": ["created_at"],
    "audit_logs": ["ts"], "notifications": ["created_at"], "goods_receipts": ["received_at"],
    "purchase_orders": ["created_at", "approved_at", "issued_at"], "stock_transfers": ["created_at", "requested_at", "approved_at", "dispatched_at", "completed_at"],
    "transfer_receipts": ["received_at"], "stock_adjustments": ["created_at", "posted_at"], "expenses": ["created_at", "approved_at"],
    "approval_requests": ["requested_at", "decided_at"],
}


def gstin(state: str, pan: str = "AABCA1234F") -> str:
    first = f"{state}{pan}1Z"
    return first + gstin_checksum_char(first)


def ctx_for(db: Session, user: User) -> AuthContext:
    db.refresh(user)
    return AuthContext(user=user, session_id=uuid.uuid4(), permissions=set(user.role.permission_codes),
                       all_locations=user.all_locations, location_ids=set(user.location_ids), ip="127.0.0.1",
                       user_agent="seed")


def backdate(db: Session, marker: datetime, days: int) -> None:
    """Shift every row written since `marker` back by `days` (demo history only)."""
    if days <= 0:
        return
    db.execute(text("SET LOCAL session_replication_role = replica"))
    for table, cols in SHIFT_TABLES.items():
        anchor = cols[0]
        sets = ", ".join(f"{c} = {c} - make_interval(days => :d)" for c in cols)
        db.execute(text(f"UPDATE {table} SET {sets} WHERE {anchor} >= :m"), {"d": days, "m": marker})
    db.execute(text("UPDATE journal_entries SET entry_date = (posted_at AT TIME ZONE 'Asia/Kolkata')::date WHERE posted_at >= :m - make_interval(days => :d) AND entry_date > (posted_at AT TIME ZONE 'Asia/Kolkata')::date"),
               {"d": days, "m": marker})
    db.execute(text("UPDATE payments SET payment_date = (created_at AT TIME ZONE 'Asia/Kolkata')::date WHERE created_at >= :m - make_interval(days => :d) AND payment_date > (created_at AT TIME ZONE 'Asia/Kolkata')::date"),
               {"d": days, "m": marker})
    db.commit()


FICTION = ["The Monsoon Archive", "Salt of the Konkan", "Letters from Matheran", "The Last Tram to Esplanade",
           "A Lamp in Lonavala", "Rivers Remember", "The Cartographer's Daughter", "Midnight at Marine Drive",
           "The Spice Ledger", "Ghats in the Rain", "Ink and Indigo", "The Silent Harbour", "Tea Gardens at Dusk",
           "The Clockmaker of Pune", "Seven Winters in Shimla"]
NONFICTION = ["Building the Modern Bazaar", "A Short History of the Deccan", "Numbers That Matter",
              "Lessons from Small Businesses", "The Frugal Founder", "Monsoon Economics", "Minds at Work",
              "Ordinary Heroes of Bombay", "The Art of Quiet Leadership", "Rails Across India"]
CHILDREN = ["Tara and the Talking Tiger", "The Mango Tree Club", "Counting Stars with Dadi", "Robo Raju Goes to School",
            "The Little Lighthouse", "Elephants Never Hurry"]
ACADEMIC = ["Engineering Mathematics Volume I", "Fundamentals of Accounting", "Concise Human Anatomy",
            "Introduction to Data Structures", "Principles of Economics (Indian Edition)"]
REGIONAL = ["पावसाळी गोष्टी", "गाँव की धूप", "स्मृतींचा प्रवास"]
AUTHORS = ["Anaya Kulkarni", "Rohan Mehta", "Meera Iyer", "Vikram Desai", "Farah Sheikh", "Arjun Rao", "Kavya Nair",
           "Siddharth Joshi", "Neha Banerjee", "Imran Qureshi", "Priya Menon", "Dev Malhotra", "Lata Pawar"]
PUBLISHERS = ["Saffron Leaf Press", "Deccan Ink Publishers", "Harbour Line Books", "Peacock Feather Publishing"]


def isbn13(n: int) -> str:
    body = f"97881950{n:04d}"
    return body + ean13_check_digit(body)


def seed_demo(db: Session, password: str) -> None:
    if db.scalar(select(Organization).limit(1)) is not None or db.scalar(select(User).limit(1)) is not None:
        print("Database already contains data; demo seed only runs on an empty database.")
        return
    print("Seeding reference data…")
    ensure_reference_data(db)
    org = Organization(legal_name="Ajanta Books Private Limited", trade_name="Ajanta Books", gstin=gstin("27"),
                       gst_registration_type="REGULAR", pan="AABCA1234F", address_line1="12 Hornby Road, Fort",
                       city="Mumbai", state="Maharashtra", state_code="27", pincode="400001", phone="+91 22 4000 1000",
                       email="accounts@ajantabooks.test")
    db.add(org)
    policy = PolicySettings(loyalty_enabled=True, credit_sales_enabled=True)
    save_policy(db, policy, None)

    locs = {
        "WH-BHW": Location(code="WH-BHW", name="Central Warehouse — Bhiwandi", type="WAREHOUSE", city="Bhiwandi",
                           state="Maharashtra", state_code="27", pincode="421302", address_line1="Plot 7, Logistics Park",
                           invoice_prefix="WH", gstin=gstin("27")),
        "OUT-FORT": Location(code="OUT-FORT", name="Fort, Mumbai", type="OUTLET", city="Mumbai", state="Maharashtra",
                             state_code="27", pincode="400001", address_line1="12 Hornby Road, Fort",
                             phone="+91 22 4000 1001", invoice_prefix="FRT", gstin=gstin("27")),
        "OUT-PUNE": Location(code="OUT-PUNE", name="FC Road, Pune", type="OUTLET", city="Pune", state="Maharashtra",
                             state_code="27", pincode="411004", address_line1="88 Fergusson College Road",
                             phone="+91 20 4000 1002", invoice_prefix="PNQ", gstin=gstin("27")),
        "OUT-BLR": Location(code="OUT-BLR", name="Church Street, Bengaluru", type="OUTLET", city="Bengaluru",
                            state="Karnataka", state_code="29", pincode="560001", address_line1="45 Church Street",
                            phone="+91 80 4000 1003", invoice_prefix="BLR", gstin=gstin("29")),
    }
    for loc in locs.values():
        db.add(loc)
    db.flush()
    registers = {}
    for code in ("OUT-FORT", "OUT-PUNE", "OUT-BLR"):
        reg = Register(location_id=locs[code].id, name="Counter 1")
        db.add(reg)
        registers[code] = reg
    db.add(Register(location_id=locs["OUT-FORT"].id, name="Counter 2"))
    db.flush()

    roles = {r.code: r for r in db.scalars(select(Role))}

    def user(email, name, role, *, all_locs=False, codes=(), designation=None):
        u = User(email=email, full_name=name, role_id=roles[role].id, all_locations=all_locs, designation=designation,
                 employee_code=next_code(db, "EMP", "E", 4), joined_on=date(2023, 4, 1))
        u.location_links = [UserLocation(location_id=locs[c].id) for c in codes]
        set_password(db, u, password)
        db.add(u)
        db.flush()
        return u

    owner = user("owner@ajantabooks.test", "Aditi Sharma", "OWNER", all_locs=True, designation="Managing Director")
    invmgr = user("inventory@ajantabooks.test", "Rahul Verma", "INVENTORY_MANAGER", all_locs=True, designation="Inventory Head")
    acct = user("accounts@ajantabooks.test", "Sunita Rao", "ACCOUNTANT", all_locs=True, designation="Accountant")
    user("auditor@ajantabooks.test", "Kiran Shah", "AUDITOR", all_locs=True, designation="External Auditor")
    mgr = {
        "OUT-FORT": user("fort.manager@ajantabooks.test", "Nikhil Patil", "STORE_MANAGER", codes=["OUT-FORT"], designation="Store Manager"),
        "OUT-PUNE": user("pune.manager@ajantabooks.test", "Shreya Gokhale", "STORE_MANAGER", codes=["OUT-PUNE"], designation="Store Manager"),
        "OUT-BLR": user("blr.manager@ajantabooks.test", "Karthik Reddy", "STORE_MANAGER", codes=["OUT-BLR"], designation="Store Manager"),
    }
    cashier = {
        "OUT-FORT": user("fort.cashier@ajantabooks.test", "Pooja Naik", "CASHIER", codes=["OUT-FORT"], designation="Cashier"),
        "OUT-PUNE": user("pune.cashier@ajantabooks.test", "Amit Jadhav", "CASHIER", codes=["OUT-PUNE"], designation="Cashier"),
        "OUT-BLR": user("blr.cashier@ajantabooks.test", "Divya Shetty", "CASHIER", codes=["OUT-BLR"], designation="Cashier"),
    }
    db.commit()
    ictx, actx = ctx_for(db, invmgr), ctx_for(db, acct)

    print("Seeding catalog…")
    cats = {}
    for parent, children in {"Fiction": ["Literary", "Thriller", "Historical"], "Non-fiction": ["Business", "History", "Biography"],
                             "Children": ["Picture Books", "Early Readers"], "Academic": ["Engineering", "Commerce", "Medical"],
                             "Indian Languages": ["Marathi", "Hindi"], "Stationery": []}.items():
        p = Category(name=parent)
        db.add(p)
        db.flush()
        cats[parent] = p
        for c in children:
            cc = Category(name=c, parent_id=p.id)
            db.add(cc)
            db.flush()
            cats[c] = cc
    tc = {t.code: t for t in db.scalars(select(TaxClass))}
    suppliers = []
    for i, (name, city, st) in enumerate([("Deccan Book Distributors", "Pune", "27"), ("Western India Book House", "Mumbai", "27"),
                                          ("Southern Star Publishers' Depot", "Bengaluru", "29"),
                                          ("Classmate Stationery Supplies", "Thane", "27")]):
        s = Supplier(code=next_code(db, "SUPPLIER", "S", 4), name=name, contact_person=AUTHORS[i + 5], phone=f"+91 98200 0{i}100",
                     email=f"orders{i}@supplier.test", gstin=gstin(st, f"AAACD{1000 + i}K"), city=city, state_code=st,
                     address_line1=f"{10 + i} Industrial Estate", payment_terms_days=[30, 45, 30, 15][i])
        db.add(s)
        suppliers.append(s)
    db.flush()

    books: list[Book] = []
    n = 0

    def add(title, cat, mrp, *, tax="GST0", hsn="4901", isbn=True, mode="QUANTITY", reorder=(5, 20), lang="English",
            binding="Paperback", supplier=None):
        nonlocal n
        n += 1
        data = BookIn(title=title, authors=[AUTHORS[n % len(AUTHORS)]] + ([AUTHORS[(n * 7) % len(AUTHORS)]] if n % 5 == 0 else []),
                      publisher=PUBLISHERS[n % len(PUBLISHERS)] if isbn else "Classmate", isbn13=isbn13(n) if isbn else None,
                      category_id=cats[cat].id, tax_class_id=tc[tax].id, hsn_code=hsn, mrp=D(mrp),
                      selling_price=D(mrp) if n % 4 else (D(mrp) * D("0.95")).quantize(D("1")),
                      min_selling_price=(D(mrp) * D("0.80")).quantize(D("1")),
                      purchase_price=(D(mrp) * D("0.58")).quantize(D("0.01")), reorder_level=reorder[0],
                      reorder_qty=reorder[1], tracking_mode=mode, language=lang, binding=binding if isbn else None,
                      page_count=R.randint(120, 640) if isbn else None, edition="1st" if isbn else None,
                      default_supplier_id=(supplier or suppliers[n % 3]).id,
                      description=f"{title} — demo catalogue entry." if isbn else None,
                      tags=["bestseller"] if n % 6 == 0 else [])
        b = create_book(db, data, owner.id)
        books.append(b)
        return b

    for i, t in enumerate(FICTION):
        add(t, ["Literary", "Thriller", "Historical"][i % 3], R.choice([299, 350, 399, 450, 499, 599]))
    for i, t in enumerate(NONFICTION):
        add(t, ["Business", "History", "Biography"][i % 3], R.choice([399, 499, 599, 699, 799]), binding="Hardcover" if i % 3 == 0 else "Paperback")
    for t in CHILDREN:
        add(t, R.choice(["Picture Books", "Early Readers"]), R.choice([150, 199, 250, 299]), reorder=(8, 25))
    for i, t in enumerate(ACADEMIC):
        add(t, ["Engineering", "Commerce", "Medical", "Engineering", "Commerce"][i], R.choice([550, 695, 850, 995]), reorder=(3, 10))
    for i, t in enumerate(REGIONAL):
        add(t, "Marathi" if i != 1 else "Hindi", R.choice([180, 220, 260]), lang="Marathi" if i != 1 else "Hindi")
    collectible = [add("The Monsoon Archive — Signed First Edition", "Literary", 2499, mode="COPY", reorder=(0, 0)),
                   add("Bombay Atlas 1932 (Facsimile, Numbered)", "History", 3999, mode="COPY", reorder=(0, 0), binding="Hardcover")]
    stationery = [add("Ajanta Classic Notebook A5 (Ruled)", "Stationery", 120, tax="GST12", hsn="4820", isbn=False, reorder=(20, 60), supplier=suppliers[3]),
                  add("Gel Pen Pack of 5", "Stationery", 90, tax="GST18", hsn="9608", isbn=False, reorder=(15, 50), supplier=suppliers[3]),
                  add("Leather Bookmark", "Stationery", 149, tax="GST12", hsn="4202", isbn=False, reorder=(10, 30), supplier=suppliers[3]),
                  add("Gift Wrap Sheet", "Stationery", 40, tax="GST12", hsn="4802", isbn=False, reorder=(25, 100), supplier=suppliers[3])]
    db.commit()

    now = datetime.now(UTC)
    print("Seeding purchases…")
    marker = datetime.now(UTC)
    regular = [b for b in books if b not in collectible and b not in stationery]
    grns = []
    po_specs = [(suppliers[0], regular[0:16]), (suppliers[1], regular[16:32]), (suppliers[2], regular[32:]), (suppliers[3], stationery),
                (suppliers[0], collectible)]
    for sup, items in po_specs:
        po = purchasing.PurchaseOrder(id=uuid.uuid4(), number=purchasing.next_number(db, "PO"), supplier_id=sup.id,
                                      location_id=locs["WH-BHW"].id, order_date=date.today() - timedelta(days=36),
                                      created_by=invmgr.id)
        db.add(po)
        db.flush()
        purchasing.set_po_lines(db, po, [{"book_id": b.id, "qty": 6 if b in collectible else (150 if b in stationery else R.choice([70, 90, 120])),
                                          "unit_cost": (b.mrp * D("0.58")).quantize(D("0.01")), "tax_rate":
                                          b.tax_class.rate} for b in items])
        purchasing.submit_po(db, ictx, po)
        po.status, po.issued_at = "ISSUED", now
        db.flush()
        partial = sup is suppliers[2]
        lines = [{"po_line_id": ln.id, "qty_received": ln.qty_ordered - (10 if partial and i % 3 == 0 else 0),
                  "qty_damaged": 1 if (sup is suppliers[1] and i == 2) else 0} for i, ln in enumerate(po.lines)]
        for ln in lines:
            if ln["qty_damaged"]:
                ln["qty_received"] -= 1
        grn, _ = purchasing.receive_goods(db, ictx, idempotency_key=f"seed-grn-{po.number}", location_id=locs["WH-BHW"].id,
                                          supplier_id=None, po_id=po.id, lines=lines, freight=D("1500") if partial else D("0"),
                                          other_charges=D("0"), supplier_ref=f"DC-{R.randint(1000, 9999)}", notes=None)
        grns.append((grn, sup, po))
        db.commit()
    # Supplier invoices for the first three receipts; pay one fully.
    for i, (grn, sup, po) in enumerate(grns[:4]):
        tax = sum(((ln.qty_received + ln.qty_damaged) * ln.unit_cost * (D(next(p.tax_rate for p in po.lines if p.book_id == ln.book_id)) / 100)
                   for ln in grn.lines), D(0)).quantize(D("0.01"))
        half = (tax / 2).quantize(D("0.01"))
        si = purchasing.record_supplier_invoice(
            db, actx, supplier_id=sup.id, invoice_number=f"INV/{2026}/{R.randint(1000, 9999)}", invoice_date=date.today() - timedelta(days=34),
            due_date=date.today() - timedelta(days=34) + timedelta(days=sup.payment_terms_days), grn_ids=[grn.id],
            taxable_amount=grn.goods_value + grn.freight, cgst=half, sgst=half, igst=D(0), other_charges=D(0), notes=None)
        db.flush()
        if i == 0:
            bank = db.scalar(select(PaymentMethod).where(PaymentMethod.code == "BANK"))
            purchasing.pay_supplier(db, actx, idempotency_key=f"seed-pay-{si.id}", supplier_id=sup.id,
                                    location_id=locs["WH-BHW"].id, payment_method_id=bank.id, account_id=None,
                                    amount=si.total, reference="NEFT-SEED-001", payment_date=date.today() - timedelta(days=20),
                                    allocations=[{"supplier_invoice_id": si.id, "amount": si.total}], notes=None)
        db.commit()
    backdate(db, marker, 35)

    print("Seeding transfers…")
    marker = datetime.now(UTC)
    for k, code in enumerate(("OUT-FORT", "OUT-PUNE", "OUT-BLR")):
        items = [b for b in books if b not in collectible]
        lines = [{"book_id": b.id, "qty": R.choice([8, 10, 12, 15]) if b not in stationery else 25} for b in items]
        if code == "OUT-FORT":
            lines += [{"book_id": collectible[0].id, "qty": 2}, {"book_id": collectible[1].id, "qty": 1}]
        t = transfers.create(db, ctx_for(db, mgr[code]), source_id=locs["WH-BHW"].id, dest_id=locs[code].id, lines=lines,
                             notes="Opening stock for outlet")
        transfers.request(db, ctx_for(db, mgr[code]), t)
        db.flush()
        from app.services import approvals as appr

        req = appr.pending_for(db, "stock_transfer", t.id)
        if req:
            appr.decide(db, ictx, req.id, True, "Approved for opening stock")
        transfers.dispatch(db, ictx, t, [])
        recv = [{"line_id": ln.id, "qty_received": ln.qty_dispatched - (1 if (k == 1 and i == 0) else 0),
                 "qty_damaged": 1 if (k == 1 and i == 0) else 0} for i, ln in enumerate(t.lines)]
        transfers.receive(db, ctx_for(db, mgr[code]), t, idempotency_key=f"seed-trf-{t.number}", lines=recv, final=True, notes=None)
        db.commit()
    backdate(db, marker, 32)

    print("Seeding customers…")
    customers = []
    for i, name in enumerate(["Rhea Kapoor", "Sameer Kulkarni", "Ishaan Gupta", "Ananya Pillai", "Zoya Khan", "Harish Iyer",
                              "Maya Deshpande", "Arnav Sinha", "Tanvi Joshi", "Rohit Bhat", "Leela Fernandes", "Omkar Sawant"]):
        c = Customer(code=next_code(db, "CUSTOMER", "C", 6), name=name, phone=f"98{i:02d}00{1000 + i * 7:04d}",
                     email=f"{name.split()[0].lower()}@example.test", marketing_consent=i % 2 == 0,
                     credit_limit=D("5000") if i < 3 else D("0"), state_code="27" if i % 4 else "29",
                     consent_updated_at=now if i % 2 == 0 else None)
        db.add(c)
        customers.append(c)
    corp = Customer(code=next_code(db, "CUSTOMER", "C", 6), name="Brightminds Learning Centre", phone="9822012345",
                    gstin=gstin("29", "AAFCB4321Q"), state_code="29", billing_address="22 MG Road, Bengaluru",
                    credit_limit=D("25000"))
    db.add(corp)
    customers.append(corp)
    db.commit()

    print("Seeding 30 days of sales (this takes a minute)…")
    methods = {m.code: m for m in db.scalars(select(PaymentMethod))}
    cash_acc = db.scalar(select(Account).where(Account.system_key == "CASH"))
    bank_acc = db.scalar(select(Account).where(Account.system_key == "BANK"))
    exp_cats = {c.name: c for c in db.scalars(select(ExpenseCategory))}
    failures: dict[str, int] = {}
    outlet_weight = {"OUT-FORT": (5, 9), "OUT-PUNE": (3, 7), "OUT-BLR": (3, 6)}
    for day in range(30, -1, -1):
        marker = datetime.now(UTC)
        for code in ("OUT-FORT", "OUT-PUNE", "OUT-BLR"):
            loc = locs[code]
            cctx = ctx_for(db, cashier[code])
            mctx = ctx_for(db, mgr[code])
            session = finance.open_session(db, cctx, registers[code].id, D("2000"))
            db.commit()
            sold_today: list[Sale] = []
            lo, hi = outlet_weight[code]
            for s_i in range(R.randint(lo, hi) + (2 if day % 7 in (5, 6) else 0)):
                avail_books = [b for b in books if b not in collectible]
                picks = R.sample(avail_books, R.choice([1, 1, 2, 2, 3]))
                items = [{"book_id": b.id, "qty": R.choice([1, 1, 1, 2])} for b in picks]
                if code == "OUT-FORT" and day in (12, 3) and s_i == 0:
                    items.append({"book_id": collectible[0].id, "qty": 1})
                customer = R.choice(customers[:12]) if R.random() < 0.45 else None
                if code in ("OUT-BLR", "OUT-FORT") and day % 9 == 0 and s_i == 0:
                    customer = corp  # B2B; at the Mumbai outlet this is an interstate (IGST) supply
                bill_discount = D(0)
                reason = None
                try:
                    _, quote, _ = sales.quote(db, cctx, location_id=loc.id, items=items, customer_id=customer.id if customer else None)
                except Exception:  # noqa: BLE001
                    continue
                if R.random() < 0.15:
                    bill_discount = (quote.gross * D("0.05")).quantize(D("1"))
                    reason = "Loyal customer"
                    _, quote, _ = sales.quote(db, cctx, location_id=loc.id, items=items, customer_id=customer.id if customer else None,
                                              bill_discount=bill_discount)
                total = quote.grand_total
                r = R.random()
                if customer is corp:
                    payments = [{"payment_method_id": methods["BANK"].id, "amount": total, "reference": f"NEFT{R.randint(100000, 999999)}"}]
                elif r < 0.45:
                    tendered = ((total // 100) + 1) * 100 if total % 100 else total
                    payments = [{"payment_method_id": methods["CASH"].id, "amount": total, "tendered": tendered}]
                elif r < 0.85:
                    payments = [{"payment_method_id": methods["UPI"].id, "amount": total, "reference": f"UPI{R.randint(10**9, 10**10)}"}]
                elif r < 0.95 or total < 300:
                    payments = [{"payment_method_id": methods["CARD"].id, "amount": total, "reference": f"CARD{R.randint(1000, 9999)}"}]
                else:
                    cash_part = (total / 2).quantize(D("1"))
                    payments = [{"payment_method_id": methods["CASH"].id, "amount": cash_part},
                                {"payment_method_id": methods["UPI"].id, "amount": total - cash_part, "reference": f"UPI{R.randint(10**9, 10**10)}"}]
                try:
                    sale, _ = sales.checkout(db, cctx, idempotency_key=f"seed-{code}-{day}-{s_i}", location_id=loc.id,
                                             register_session_id=session.id, items=items, payments=payments,
                                             customer_id=customer.id if customer else None, bill_discount=bill_discount,
                                             discount_reason=reason)
                    db.commit()
                    sold_today.append(sale)
                except Exception as e:  # noqa: BLE001 - e.g. demo stock ran out
                    db.rollback()
                    failures[type(e).__name__ + ": " + str(getattr(e, "message", e))[:60]] = failures.get(
                        type(e).__name__ + ": " + str(getattr(e, "message", e))[:60], 0) + 1
            # Occasional return (restock) and a damaged return
            if sold_today and day % 6 == 2:
                s = sold_today[0]
                ln = s.lines[0]
                try:
                    returns.create_return(db, mctx, idempotency_key=f"seed-ret-{code}-{day}", sale_id=s.id,
                                          lines=[{"sale_line_id": ln.id, "qty": 1, "disposition": "RESTOCK" if day % 12 else "DAMAGED",
                                                  "condition": "GOOD" if day % 12 else "DAMAGED"}],
                                          reason="Customer changed mind" if day % 12 else "Binding defect",
                                          refund_method_id=methods["CASH"].id, refund_reference=None,
                                          register_session_id=session.id)
                    db.commit()
                except Exception:  # noqa: BLE001
                    db.rollback()
            if day % 10 == 4:
                finance.create_expense(db, mctx, idempotency_key=f"seed-exp-cash-{code}-{day}", location_id=loc.id,
                                       category_id=exp_cats["Store Supplies"].id, expense_date=date.today() - timedelta(days=day),
                                       amount=D(R.choice([180, 240, 350])), description="Cleaning supplies and tea",
                                       vendor="Local vendor", paid_from_account_id=cash_acc.id, register_session_id=session.id,
                                       reference=None)
                db.commit()
            if day > 0:
                summary = finance.session_summary(db, session)
                variance = D(0) if day % 8 else D(R.choice([-50, 20, -120]))
                finance.close_session(db, cctx, session.id, summary["expected_cash"] + variance, None)
                db.commit()
        if day == 28:
            for code in ("OUT-FORT", "OUT-PUNE", "OUT-BLR"):
                for cat, amt in (("Rent", {"OUT-FORT": 145000, "OUT-PUNE": 85000, "OUT-BLR": 110000}[code]),
                                 ("Electricity & Utilities" if "Electricity & Utilities" in exp_cats else "Utilities", 9500),
                                 ("Salaries", 96000)):
                    finance.create_expense(db, actx, idempotency_key=f"seed-exp-{code}-{cat}", location_id=locs[code].id,
                                           category_id=exp_cats[cat].id, expense_date=date.today() - timedelta(days=day),
                                           amount=D(amt), description=f"{cat} — {locs[code].name}", vendor=None,
                                           paid_from_account_id=bank_acc.id, register_session_id=None, reference="NEFT")
            db.commit()
        backdate(db, marker, day)

    if failures:
        print("Checkouts skipped:", dict(sorted(failures.items(), key=lambda x: -x[1])[:5]))
    print("Seeding pending workflow items…")
    # A requested transfer awaiting approval, a damaged-stock adjustment, a pending expense approval.
    pctx = ctx_for(db, mgr["OUT-PUNE"])
    t = transfers.create(db, pctx, source_id=locs["WH-BHW"].id, dest_id=locs["OUT-PUNE"].id,
                         lines=[{"book_id": b.id, "qty": 10} for b in regular[:4]], notes="Weekend restock")
    transfers.request(db, pctx, t)
    t2 = transfers.create(db, ictx, source_id=locs["WH-BHW"].id, dest_id=locs["OUT-BLR"].id,
                          lines=[{"book_id": b.id, "qty": 6} for b in regular[10:13]], notes="Academic restock")
    transfers.request(db, ictx, t2)
    transfers.dispatch(db, ictx, t2, [])
    from app.models import InventoryBalance

    damaged_book = db.scalar(select(InventoryBalance.book_id).where(
        InventoryBalance.location_id == locs["OUT-FORT"].id, InventoryBalance.on_hand - InventoryBalance.reserved > 2,
        InventoryBalance.book_id.in_([b.id for b in regular])).order_by(InventoryBalance.book_id).limit(1))
    inv.create_adjustment(db, ctx_for(db, mgr["OUT-FORT"]), location_id=locs["OUT-FORT"].id, reason_code="DAMAGE",
                          lines=[{"book_id": damaged_book, "qty": 1}], notes="Water damage near window display")
    finance.create_expense(db, ctx_for(db, mgr["OUT-BLR"]), idempotency_key="seed-exp-pending", location_id=locs["OUT-BLR"].id,
                           category_id=exp_cats["Maintenance"].id if "Maintenance" in exp_cats else exp_cats["Miscellaneous"].id,
                           expense_date=date.today(), amount=D("7800"), description="AC servicing (annual)", vendor="CoolAir Services",
                           paid_from_account_id=bank_acc.id, register_session_id=None, reference=None)
    db.commit()
    issues = inv.reconcile(db)
    print(f"Inventory reconciliation issues: {len(issues)}")
    print("Demo data ready. Sign in as owner@ajantabooks.test (and other *@ajantabooks.test users) with the demo password.")

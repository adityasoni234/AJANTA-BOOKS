"""Point-of-sale checkout, voids and customer receipts.

Checkout is a single ACID transaction:
  validate -> server-side pricing & GST -> insert sale header (idempotency key unique) ->
  lock stock rows (sorted) -> deduct stock / mark copies sold -> issue gapless invoice number ->
  record payments + allocations -> post balanced journal (revenue, GST, COGS) -> commit.
The browser never supplies prices, tax or totals; it only sends items, quantities, requested
discounts and tendered payments.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.core.money import ZERO, D, r2
from app.models import (
    ApprovalRequest,
    Book,
    Customer,
    CustomerLedger,
    IndividualCopy,
    InventoryBalance,
    Invoice,
    Location,
    Organization,
    Payment,
    PaymentAllocation,
    PaymentMethod,
    RegisterSession,
    Return,
    Sale,
    SaleLine,
)
from app.services import accounting, approvals, gst
from app.services import inventory as inv
from app.services.accounting import Leg
from app.services.audit import audit
from app.services.inventory import Ref
from app.services.numbering import current_fy, next_number, sequence_number
from app.services.settings import PolicySettings, get_policy


@dataclass
class CartLine:
    book: Book
    qty: int
    unit_price: Decimal
    tax_rate: Decimal
    line_discount: Decimal
    copy_id: uuid.UUID | None = None


def effective_price(db: Session, book: Book, location_id: uuid.UUID) -> Decimal:
    override = db.scalar(select(InventoryBalance.price_override).where(
        InventoryBalance.location_id == location_id, InventoryBalance.book_id == book.id))
    return override if override is not None else book.selling_price


def tax_rate_for(org: Organization, book: Book) -> Decimal:
    if org.gst_registration_type != "REGULAR":
        return ZERO  # composition / unregistered dealers do not charge GST on the invoice
    return book.tax_class.rate


def doc_type_for(org: Organization, lines: list[CartLine]) -> str:
    if org.gst_registration_type != "REGULAR":
        return "BILL_OF_SUPPLY"
    return "TAX_INVOICE" if any(ln.tax_rate > 0 for ln in lines) else "BILL_OF_SUPPLY"


def customer_balance(db: Session, customer_id: uuid.UUID, kind: str) -> Decimal:
    return D(db.scalar(select(func.coalesce(func.sum(CustomerLedger.delta), 0)).where(
        CustomerLedger.customer_id == customer_id, CustomerLedger.kind == kind)))


def customer_receivable(db: Session, customer_id: uuid.UUID) -> Decimal:
    return D(db.scalar(select(func.coalesce(func.sum(Sale.grand_total - Sale.amount_paid), 0)).where(
        Sale.customer_id == customer_id, Sale.status == "COMPLETED")))


def place_of_supply(customer: Customer | None, location: Location, requested: str | None) -> str:
    if requested:
        if requested not in gst.STATE_CODES:
            raise ValidationFailed("Unknown place-of-supply state code")
        return requested
    if customer and customer.gstin:
        return customer.gstin[:2]
    # Over-the-counter retail sales: place of supply is the outlet's state.
    return location.state_code


def seller_snapshot(org: Organization, loc: Location) -> dict:
    return {
        "legal_name": org.legal_name, "trade_name": org.trade_name, "gstin": loc.gstin or org.gstin,
        "registration_type": org.gst_registration_type, "pan": org.pan,
        "location_name": loc.name, "address": ", ".join(x for x in [loc.address_line1, loc.address_line2, loc.city,
                                                                    loc.state, loc.pincode] if x),
        "state_code": loc.state_code, "state": gst.STATE_CODES.get(loc.state_code), "phone": loc.phone,
        "email": loc.email,
    }


def buyer_snapshot(customer: Customer | None) -> dict:
    if customer is None:
        return {"name": "Walk-in customer"}
    return {"name": customer.name, "phone": customer.phone, "email": customer.email, "gstin": customer.gstin,
            "address": customer.billing_address, "state_code": customer.state_code}


def _check_discounts(db: Session, ctx, policy: PolicySettings, location_id, lines: list[CartLine],
                     bill: gst.BillResult, approval_id: uuid.UUID | None) -> ApprovalRequest | None:
    """Returns the consumed approval (if any). Raises if discount/min-price policy is violated."""
    discount = bill.discount_total
    pct = (discount / bill.gross * 100) if bill.gross > 0 else ZERO
    below_min = []
    for ln, lr in zip(lines, bill.lines, strict=True):
        if ln.book.min_selling_price is not None:
            effective_unit = (lr.gross - lr.line_discount - lr.bill_discount_alloc) / ln.qty
            if effective_unit < ln.book.min_selling_price:
                below_min.append(ln.book.title)
    within_limit = discount == 0 or (ctx.has("pos.discount") and pct <= policy.max_discount_pct)
    if within_limit and not below_min:
        return None
    if ctx.has("pos.discount_override"):
        return None
    if approval_id is None:
        detail = f"discount {pct:.2f}% exceeds your limit" if not within_limit else f"price below minimum for {', '.join(below_min)}"
        raise Forbidden(f"Approval required: {detail}", code="discount_approval_required",
                        details={"discount_pct": str(r2(pct)), "below_min": below_min})
    req = db.scalar(select(ApprovalRequest).where(ApprovalRequest.id == approval_id).with_for_update(of=ApprovalRequest))
    if (req is None or req.type != "DISCOUNT" or req.status != "APPROVED" or req.consumed_at is not None
            or req.location_id != location_id):
        raise Forbidden("Discount approval is not valid, not approved, or already used", code="invalid_approval")
    approved_pct = D(req.payload.get("discount_pct", 0))
    approved_amount = D(req.payload.get("discount_amount", 0))
    if pct > approved_pct + Decimal("0.01") and discount > approved_amount:
        raise Forbidden("Discount exceeds the approved amount", code="invalid_approval")
    req.consumed_at = datetime.now(UTC)
    return req


def build_cart(db: Session, ctx, *, location_id, items: list[dict], org: Organization) -> list[CartLine]:
    lines: list[CartLine] = []
    if not items:
        raise ValidationFailed("Cart is empty")
    if len(items) > 300:
        raise ValidationFailed("Too many lines in one bill")
    for it in items:
        qty = int(it.get("qty") or 1)
        if qty <= 0 or qty > 10000:
            raise ValidationFailed("Invalid quantity")
        copy_id = it.get("copy_id")
        if copy_id:
            copy = db.get(IndividualCopy, copy_id)
            if copy is None:
                raise NotFound("Copy not found")
            book = db.get(Book, copy.book_id)
            if qty != 1:
                raise ValidationFailed("An individual copy is always quantity 1")
        else:
            book = db.get(Book, it.get("book_id"))
            if book is None:
                raise NotFound("Book not found")
        if book.status == "ARCHIVED" or book.merged_into_id:
            raise ValidationFailed(f"'{book.title}' is archived and cannot be sold")
        price = effective_price(db, book, location_id)
        disc = r2(D(it.get("line_discount") or 0))
        rate = tax_rate_for(org, book)
        if book.tracking_mode == "COPY" and not copy_id and qty > 1:
            per = gst.allocate(disc, [Decimal(1)] * qty)
            lines += [CartLine(book, 1, price, rate, d) for d in per]
        else:
            lines.append(CartLine(book, qty, price, rate, disc, uuid.UUID(str(copy_id)) if copy_id else None))
    copy_ids = [ln.copy_id for ln in lines if ln.copy_id]
    if len(copy_ids) != len(set(copy_ids)):
        raise ValidationFailed("The same copy is in the cart twice")
    return lines


def quote(db: Session, ctx, *, location_id, items: list[dict], customer_id=None, bill_discount=ZERO,
          place_of_supply_code: str | None = None) -> tuple[list[CartLine], gst.BillResult, dict]:
    org = db.scalar(select(Organization).limit(1))
    loc = db.get(Location, location_id)
    customer = db.get(Customer, customer_id) if customer_id else None
    policy = get_policy(db)
    lines = build_cart(db, ctx, location_id=location_id, items=items, org=org)
    pos = place_of_supply(customer, loc, place_of_supply_code)
    try:
        bill = gst.compute_bill([gst.LineInput(ln.unit_price, ln.qty, ln.tax_rate, ln.line_discount) for ln in lines],
                                prices_include_tax=policy.prices_include_tax, interstate=pos != loc.state_code,
                                bill_discount=D(bill_discount), rounding=policy.rounding)
    except gst.BillingError as e:
        raise ValidationFailed(str(e))
    meta = {"place_of_supply": pos, "interstate": pos != loc.state_code, "doc_type": doc_type_for(org, lines),
            "prices_include_tax": policy.prices_include_tax}
    return lines, bill, meta


def _payment_account(db: Session, method: PaymentMethod):
    if method.account_id is None:
        raise ValidationFailed(f"Payment method {method.name} has no ledger account configured")
    return method.account_id


def checkout(db: Session, ctx, *, idempotency_key: str, location_id: uuid.UUID, register_session_id: uuid.UUID,
             items: list[dict], payments: list[dict], customer_id: uuid.UUID | None = None,
             bill_discount: Decimal = ZERO, discount_reason: str | None = None, discount_approval_id=None,
             place_of_supply_code: str | None = None, exchange_return_id=None, notes: str | None = None
             ) -> tuple[Sale, bool]:
    existing = db.scalar(select(Sale).where(Sale.idempotency_key == idempotency_key))
    if existing:
        ctx.ensure_resource(existing.location_id)
        return existing, False
    ctx.ensure_location(location_id)
    loc = db.get(Location, location_id)
    if loc is None or not loc.is_active or loc.type != "OUTLET":
        raise ValidationFailed("Sales can only be made at an active outlet")
    session = db.scalar(select(RegisterSession).where(RegisterSession.id == register_session_id).with_for_update(of=RegisterSession))
    if session is None or session.location_id != location_id or session.status != "OPEN":
        raise Conflict("Open a register session at this outlet before selling", code="register_closed")
    policy = get_policy(db)
    customer = None
    if customer_id:
        customer = db.get(Customer, customer_id)
        if customer is None or not customer.is_active:
            raise ValidationFailed("Customer not found or inactive")

    lines, bill, meta = quote(db, ctx, location_id=location_id, items=items, customer_id=customer_id,
                              bill_discount=bill_discount, place_of_supply_code=place_of_supply_code)
    approval = _check_discounts(db, ctx, policy, location_id, lines, bill, discount_approval_id)
    if bill.discount_total > 0 and not discount_reason and (approval or bill.discount_total / max(bill.gross, Decimal(1)) * 100 > policy.max_discount_pct):
        raise ValidationFailed("A reason is required for this discount")

    # ---- payments (validated before anything is written)
    methods = {}
    paid = ZERO
    pay_rows = []
    for p in payments:
        m = db.get(PaymentMethod, p["payment_method_id"])
        if m is None or (not m.is_active and m.kind not in ("EXCHANGE",)):
            raise ValidationFailed("Payment method not available")
        amt = r2(D(p["amount"]))
        if amt <= 0:
            raise ValidationFailed("Payment amounts must be positive")
        if m.kind == "CREDIT":
            raise ValidationFailed("Credit is not a tender; leave the balance unpaid to create a credit sale")
        if m.requires_reference and not (p.get("reference") or "").strip():
            raise ValidationFailed(f"{m.name} payments need a reference (transaction ID)")
        tendered = r2(D(p["tendered"])) if p.get("tendered") is not None else None
        change = None
        if m.kind == "CASH" and tendered is not None:
            if tendered < amt:
                raise ValidationFailed("Cash tendered is less than the amount")
            change = tendered - amt
        elif tendered is not None and tendered != amt:
            raise ValidationFailed("Only cash payments can return change")
        methods[m.id] = m
        paid += amt
        pay_rows.append((m, amt, tendered, change, (p.get("reference") or "").strip() or None))
    if paid > bill.grand_total:
        raise ValidationFailed(f"Payments ({paid}) exceed the bill total ({bill.grand_total})")
    balance = bill.grand_total - paid
    if balance > 0:
        if not policy.credit_sales_enabled:
            raise ValidationFailed(f"Payment incomplete: {balance} still due", code="payment_incomplete")
        if not ctx.has("pos.credit_sale"):
            raise Forbidden("You are not allowed to create credit sales")
        if customer is None:
            raise ValidationFailed("Credit sales require a registered customer")
        if customer_receivable(db, customer.id) + balance > customer.credit_limit:
            raise Conflict("Customer credit limit exceeded", code="credit_limit")
    if any(m.kind == "STORE_CREDIT" for m, *_ in pay_rows):
        if customer is None:
            raise ValidationFailed("Store credit requires a customer")
        db.scalar(select(Customer).where(Customer.id == customer.id).with_for_update(of=Customer))
        needed = sum((a for m, a, *_ in pay_rows if m.kind == "STORE_CREDIT"), ZERO)
        if customer_balance(db, customer.id, "STORE_CREDIT") < needed:
            raise Conflict("Insufficient store credit", code="insufficient_store_credit")
    exchange = None
    ex_amt = sum((a for m, a, *_ in pay_rows if m.kind == "EXCHANGE"), ZERO)
    if exchange_return_id or ex_amt:
        exchange = db.scalar(select(Return).where(Return.id == exchange_return_id).with_for_update(of=Return)) if exchange_return_id else None
        if exchange is None or exchange.status != "COMPLETED" or exchange.refund_method.kind != "EXCHANGE" \
                or exchange.location_id != location_id:
            raise ValidationFailed("Exchange credit not found for this outlet")
        if ex_amt != exchange.refund_total:
            raise ValidationFailed(f"Apply the full exchange credit of {exchange.refund_total}")
        if db.scalar(select(Sale.id).where(Sale.exchange_return_id == exchange.id)):
            raise Conflict("This exchange credit has already been used")

    # ---- header first: duplicate idempotency keys fail here before any stock is touched
    sale = Sale(
        id=uuid.uuid4(), location_id=location_id, register_session_id=session.id,
        customer_id=customer.id if customer else None, status="COMPLETED",
        prices_include_tax=meta["prices_include_tax"], is_interstate=meta["interstate"],
        place_of_supply=meta["place_of_supply"], gross_amount=bill.gross,
        line_discount_total=bill.line_discount_total, bill_discount=bill.bill_discount,
        taxable_total=bill.taxable_total, cgst_total=bill.cgst_total, sgst_total=bill.sgst_total,
        igst_total=bill.igst_total, round_off=bill.round_off, grand_total=bill.grand_total, amount_paid=paid,
        discount_reason=discount_reason, discount_approval_id=approval.id if approval else None,
        exchange_return_id=exchange.id if exchange else None, notes=notes, idempotency_key=idempotency_key,
        created_by=ctx.user_id,
    )
    db.add(sale)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Sale).where(Sale.idempotency_key == idempotency_key))
        if existing:
            return existing, False
        raise

    # ---- stock: lock balances in deterministic order, then copies
    ref = Ref("SALE", sale.id, None)
    balances = inv.lock_balances(db, [(location_id, ln.book.id) for ln in lines])
    need: dict[uuid.UUID, int] = {}
    for ln in lines:
        need[ln.book.id] = need.get(ln.book.id, 0) + ln.qty
    for book_id, qty in need.items():
        bal = balances[(location_id, book_id)]
        if bal.on_hand - bal.reserved < qty:
            title = next(ln.book.title for ln in lines if ln.book.id == book_id)
            raise Conflict(f"Insufficient stock for '{title}': available {bal.on_hand - bal.reserved}, requested {qty}",
                           code="insufficient_stock", details={"book_id": str(book_id)})
    for ln in lines:
        if ln.book.tracking_mode == "COPY":
            if ln.copy_id:
                c = inv.lock_copy(db, ln.copy_id)
                if c.book_id != ln.book.id or c.location_id != location_id or c.status != "AVAILABLE":
                    raise Conflict(f"Copy {c.copy_code} is not available for sale here (status {c.status.lower()})",
                                   code="copy_unavailable")
            else:
                c = inv.pick_copies(db, book_id=ln.book.id, location_id=location_id, qty=1)[0]
            ln.copy_id = c.id

    cogs = ZERO
    cost_complete = True
    for i, (ln, lr) in enumerate(zip(lines, bill.lines, strict=True), start=1):
        bal = balances[(location_id, ln.book.id)]
        unit_cost = bal.avg_cost
        if unit_cost is None:
            cost_complete = False
        else:
            cogs += r2(unit_cost * ln.qty)
        db.add(SaleLine(
            sale_id=sale.id, line_no=i, book_id=ln.book.id, copy_id=ln.copy_id, title=ln.book.title[:300],
            hsn_code=ln.book.hsn_code, qty=ln.qty, unit_price=ln.unit_price, mrp=ln.book.mrp,
            line_discount=lr.line_discount, bill_discount_alloc=lr.bill_discount_alloc, taxable_value=lr.taxable_value,
            tax_rate=ln.tax_rate, cgst=lr.cgst, sgst=lr.sgst, igst=lr.igst, line_total=lr.line_total,
            unit_cost=unit_cost,
        ))
        inv.apply(db, bal, bucket="ON_HAND", delta=-ln.qty, movement_type="SALE", ref=ref, actor_id=ctx.user_id,
                  unit_cost=unit_cost, copy_id=ln.copy_id, check_available=True)
        if ln.copy_id:
            c = db.get(IndividualCopy, ln.copy_id)
            inv.move_copy(db, c, event="SOLD", to_status="SOLD", ref=ref, actor_id=ctx.user_id)
    sale.cogs_total = cogs if cost_complete else (cogs or None)
    sale.cost_complete = cost_complete

    # ---- invoice (gapless per outlet per financial year)
    org = db.scalar(select(Organization).limit(1))
    fy = current_fy(db)
    doc_type = meta["doc_type"]
    # One consecutive series per outlet per financial year for all outward invoices (tax invoices and
    # bills of supply). Max 16 characters as required for GST invoice numbers: PPPP/YYYY/NNNNNN.
    number = next_number(db, "SALES_INVOICE", scope=str(location_id), prefix=loc.invoice_prefix, fy=fy, width=6)
    invoice = Invoice(id=uuid.uuid4(), number=number, doc_type=doc_type, sale_id=sale.id, location_id=location_id,
                      financial_year=fy, seller=seller_snapshot(org, loc), buyer=buyer_snapshot(customer),
                      place_of_supply=meta["place_of_supply"])
    db.add(invoice)

    # ---- payments & journal
    legs: list[Leg] = []
    for m, amt, tendered, change, reference in pay_rows:
        pay = Payment(id=uuid.uuid4(), number=sequence_number(db, "payment_seq", "PAY"), direction="IN", purpose="SALE",
                      payment_method_id=m.id, account_id=_payment_account(db, m), amount=amt, tendered=tendered,
                      change_given=change, reference=reference, location_id=location_id,
                      register_session_id=session.id, customer_id=sale.customer_id, created_by=ctx.user_id)
        db.add(pay)
        db.flush()
        db.add(PaymentAllocation(payment_id=pay.id, sale_id=sale.id, amount=amt))
        legs.append(Leg(m.account_id, amt))
        if m.kind == "STORE_CREDIT":
            db.add(CustomerLedger(customer_id=customer.id, kind="STORE_CREDIT", delta=-amt, ref_type="SALE",
                                  ref_id=sale.id, note=f"Used on {number}", actor_id=ctx.user_id))
    if balance > 0:
        legs.append(Leg("AR", balance))
    legs += [Leg("SALES", -bill.taxable_total), Leg("OUTPUT_CGST", -bill.cgst_total),
             Leg("OUTPUT_SGST", -bill.sgst_total), Leg("OUTPUT_IGST", -bill.igst_total),
             Leg("ROUND_OFF", -bill.round_off)]
    if cogs:
        legs += [Leg("COGS", cogs), Leg("INVENTORY", -cogs)]
    je = accounting.post(db, source_type="SALE", source_id=sale.id, location_id=location_id, actor_id=ctx.user_id,
                         memo=f"Sale {number}", legs=legs)
    sale.journal_entry_id = je.id if je else None

    # ---- loyalty
    if policy.loyalty_enabled and customer and policy.loyalty_points_per_100 > 0:
        points = (bill.taxable_total / 100 * policy.loyalty_points_per_100).to_integral_value(rounding="ROUND_FLOOR")
        if points > 0:
            db.add(CustomerLedger(customer_id=customer.id, kind="LOYALTY", delta=points, ref_type="SALE",
                                  ref_id=sale.id, note=f"Earned on {number}", actor_id=ctx.user_id))

    for book_id in need:
        inv.low_stock_check(db, balances[(location_id, book_id)])
    audit(db, ctx, "pos.sale_completed", entity_type="sale", entity_id=sale.id, location_id=location_id,
          details={"invoice": number, "total": bill.grand_total, "discount": bill.discount_total,
                   "approval": str(approval.id) if approval else None})
    return sale, True


def request_discount_approval(db: Session, ctx, *, location_id, items, customer_id, bill_discount, reason: str,
                              place_of_supply_code=None) -> ApprovalRequest:
    ctx.ensure_location(location_id)
    lines, bill, _ = quote(db, ctx, location_id=location_id, items=items, customer_id=customer_id,
                           bill_discount=bill_discount, place_of_supply_code=place_of_supply_code)
    pct = r2(bill.discount_total / bill.gross * 100) if bill.gross else ZERO
    return approvals.create(
        db, ctx, type_="DISCOUNT", location_id=location_id,
        title=f"Discount {pct}% (₹{bill.discount_total}) on bill of ₹{bill.gross}", amount=bill.discount_total,
        reason=reason,
        payload={"discount_pct": str(pct), "discount_amount": str(bill.discount_total), "gross": str(bill.gross),
                 "items": [{"title": ln.book.title, "qty": ln.qty, "price": str(ln.unit_price)} for ln in lines]},
    )


approvals.register("DISCOUNT", None, None)


# ---------------------------------------------------------------- void


def void_sale(db: Session, ctx, sale: Sale, reason: str, *, actor_id=None) -> None:
    """Cancel a sale made in a still-open register session. Restocks items, refunds every payment
    with the original method, reverses the journal and marks the invoice cancelled (number kept)."""
    actor_id = actor_id or ctx.user_id
    if sale.status != "COMPLETED":
        raise Conflict("Sale is already cancelled")
    if db.scalar(select(func.count()).select_from(Return).where(Return.sale_id == sale.id, Return.status != "REJECTED")):
        raise Conflict("Sale has returns; use the returns workflow instead")
    if sale.exchange_return_id:
        raise Conflict("Exchange sales cannot be voided; process a return instead")
    session = db.get(RegisterSession, sale.register_session_id)
    if session.status != "OPEN":
        raise Conflict("The register session is closed; use the returns workflow instead")
    if sale.amount_paid != sale.grand_total:
        raise Conflict("Sales with partial payments or receivables cannot be voided")
    ref = Ref("SALE_VOID", sale.id, sale.invoice.number if sale.invoice else None)
    balances = inv.lock_balances(db, [(sale.location_id, ln.book_id) for ln in sale.lines])
    for ln in sale.lines:
        bal = balances[(sale.location_id, ln.book_id)]
        inv.receive_cost(bal, ln.qty, ln.unit_cost)
        inv.apply(db, bal, bucket="ON_HAND", delta=ln.qty, movement_type="SALE_VOID", ref=ref, actor_id=actor_id,
                  unit_cost=ln.unit_cost, copy_id=ln.copy_id)
        if ln.copy_id:
            c = inv.lock_copy(db, ln.copy_id)
            if c.status != "SOLD":
                raise Conflict(f"Copy {c.copy_code} is not in sold state")
            inv.move_copy(db, c, event="SALE_VOIDED", to_status="AVAILABLE", ref=ref, actor_id=actor_id)
    for alloc in db.scalars(select(PaymentAllocation).where(PaymentAllocation.sale_id == sale.id)):
        orig = db.get(Payment, alloc.payment_id)
        refund = Payment(id=uuid.uuid4(), number=sequence_number(db, "payment_seq", "PAY"), direction="OUT",
                         purpose="SALE_VOID", payment_method_id=orig.payment_method_id, account_id=orig.account_id,
                         amount=alloc.amount, reference=orig.reference, location_id=sale.location_id,
                         register_session_id=session.id, customer_id=sale.customer_id, created_by=actor_id,
                         notes=f"Void of {ref.number}")
        db.add(refund)
        db.flush()
        db.add(PaymentAllocation(payment_id=refund.id, sale_id=sale.id, amount=alloc.amount))
        if orig.method.kind == "STORE_CREDIT":
            db.add(CustomerLedger(customer_id=sale.customer_id, kind="STORE_CREDIT", delta=alloc.amount,
                                  ref_type="SALE_VOID", ref_id=sale.id, note=f"Void of {ref.number}", actor_id=actor_id))
    for led in db.scalars(select(CustomerLedger).where(CustomerLedger.ref_id == sale.id, CustomerLedger.kind == "LOYALTY",
                                                       CustomerLedger.ref_type == "SALE")):
        db.add(CustomerLedger(customer_id=led.customer_id, kind="LOYALTY", delta=-led.delta, ref_type="SALE_VOID",
                              ref_id=sale.id, note="Reversed on void", actor_id=actor_id))
    if sale.journal_entry_id:
        je = db.get(accounting.JournalEntry, sale.journal_entry_id)
        accounting.reverse(db, je, actor_id=actor_id, memo=f"Void of {ref.number}", source_type="SALE_VOID")
    sale.status = "CANCELLED"
    sale.cancelled_by, sale.cancelled_at, sale.cancel_reason = actor_id, datetime.now(UTC), reason
    if sale.invoice:
        inv_row = db.get(Invoice, sale.invoice.id)
        inv_row.status = "CANCELLED"
    audit(db, ctx, "pos.sale_voided", entity_type="sale", entity_id=sale.id, location_id=sale.location_id,
          details={"invoice": ref.number, "reason": reason, "total": sale.grand_total})


def _approve_void(db: Session, ctx, req) -> None:
    sale = db.scalar(select(Sale).where(Sale.id == req.entity_id).with_for_update(of=Sale))
    if sale is None:
        raise NotFound("Sale not found")
    void_sale(db, ctx, sale, req.reason or "Approved void", actor_id=ctx.user_id)


approvals.register("VOID", _approve_void, None)


# ---------------------------------------------------------------- customer receipts (credit sales)


def receive_customer_payment(db: Session, ctx, *, idempotency_key: str, customer_id, location_id, payment_method_id,
                             amount: Decimal, reference: str | None, allocations: list[dict],
                             register_session_id=None) -> tuple[Payment, bool]:
    existing = db.scalar(select(Payment).where(Payment.idempotency_key == idempotency_key))
    if existing:
        ctx.ensure_resource(existing.location_id)
        return existing, False
    ctx.ensure_location(location_id)
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise NotFound("Customer not found")
    m = db.get(PaymentMethod, payment_method_id)
    if m is None or m.kind in ("CREDIT", "STORE_CREDIT", "EXCHANGE"):
        raise ValidationFailed("Payment method not allowed for receipts")
    if m.requires_reference and not reference:
        raise ValidationFailed("Reference required")
    amount = r2(amount)
    if sum((r2(D(a["amount"])) for a in allocations), ZERO) != amount:
        raise ValidationFailed("Allocations must equal the amount received")
    session = None
    if m.kind == "CASH":
        if not register_session_id:
            raise ValidationFailed("Cash receipts must be recorded in an open register session")
        session = db.get(RegisterSession, register_session_id)
        if session is None or session.status != "OPEN" or session.location_id != location_id:
            raise Conflict("Register session is not open at this location")
    pay = Payment(id=uuid.uuid4(), number=sequence_number(db, "payment_seq", "PAY"), direction="IN",
                  purpose="CUSTOMER_RECEIPT", payment_method_id=m.id, account_id=m.account_id, amount=amount,
                  reference=reference, location_id=location_id, register_session_id=session.id if session else None,
                  customer_id=customer.id, idempotency_key=idempotency_key, created_by=ctx.user_id)
    db.add(pay)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Payment).where(Payment.idempotency_key == idempotency_key))
        if existing:
            return existing, False
        raise
    for a in sorted(allocations, key=lambda x: str(x["sale_id"])):
        sale = db.scalar(select(Sale).where(Sale.id == a["sale_id"]).with_for_update(of=Sale))
        if sale is None or sale.customer_id != customer.id or sale.status != "COMPLETED":
            raise ValidationFailed("Sale not found for this customer")
        ctx.ensure_resource(sale.location_id)
        amt = r2(D(a["amount"]))
        if amt <= 0 or amt > sale.balance_due:
            raise ValidationFailed(f"Allocation exceeds balance due ({sale.balance_due})")
        sale.amount_paid += amt
        db.add(PaymentAllocation(payment_id=pay.id, sale_id=sale.id, amount=amt))
    je = accounting.post(db, source_type="CUSTOMER_RECEIPT", source_id=pay.id, location_id=location_id,
                         actor_id=ctx.user_id, memo=f"Receipt {pay.number} from {customer.name}",
                         legs=[Leg(m.account_id, amount), Leg("AR", -amount)])
    pay.journal_entry_id = je.id if je else None
    audit(db, ctx, "finance.customer_receipt", entity_type="payment", entity_id=pay.id, location_id=location_id,
          details={"customer": customer.name, "amount": amount})
    return pay, True

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.money import ZERO, r2, r4
from app.models import (
    Account,
    Book,
    GoodsReceipt,
    GoodsReceiptLine,
    Location,
    Payment,
    PaymentAllocation,
    PaymentMethod,
    PriceHistory,
    PurchaseOrder,
    PurchaseOrderLine,
    Supplier,
    SupplierInvoice,
    SupplierProduct,
    SupplierReturn,
    SupplierReturnLine,
)
from app.services import accounting, approvals
from app.services import inventory as inv
from app.services.accounting import Leg
from app.services.audit import audit
from app.services.inventory import Ref
from app.services.numbering import next_number, sequence_number
from app.services.settings import get_policy

OPEN_PO = ("ISSUED", "PARTIALLY_RECEIVED")


def po_totals(po: PurchaseOrder) -> None:
    sub = tax = ZERO
    for ln in po.lines:
        net = r2(Decimal(ln.qty_ordered) * ln.unit_cost * (1 - ln.discount_pct / 100))
        sub += net
        tax += r2(net * ln.tax_rate / 100)
    po.subtotal, po.tax_total, po.total = sub, tax, sub + tax


def set_po_lines(db: Session, po: PurchaseOrder, lines: list[dict]) -> None:
    if not lines:
        raise ValidationFailed("A purchase order needs at least one line")
    seen = set()
    po.lines.clear()
    db.flush()
    for i, ln in enumerate(lines, start=1):
        book = db.get(Book, ln["book_id"])
        if book is None:
            raise ValidationFailed("Book not found")
        if book.id in seen:
            raise ValidationFailed(f"'{book.title}' appears more than once")
        seen.add(book.id)
        po.lines.append(PurchaseOrderLine(line_no=i, book_id=book.id, qty_ordered=int(ln["qty"]),
                                          unit_cost=Decimal(ln["unit_cost"]), discount_pct=Decimal(ln.get("discount_pct") or 0),
                                          tax_rate=Decimal(ln.get("tax_rate") or 0)))
    po_totals(po)


def submit_po(db: Session, ctx, po: PurchaseOrder) -> None:
    if po.status != "DRAFT":
        raise Conflict("Only draft purchase orders can be submitted")
    threshold = get_policy(db).po_approval_threshold
    if threshold > 0 and po.total >= threshold and not ctx.has("purchasing.approve"):
        po.status = "PENDING_APPROVAL"
        approvals.create(db, ctx, type_="PURCHASE_ORDER", location_id=po.location_id,
                         title=f"Purchase order {po.number} — {po.supplier.name}", entity_type="purchase_order",
                         entity_id=po.id, amount=po.total)
    else:
        po.status = "APPROVED"
        po.approved_by, po.approved_at = ctx.user_id, datetime.now(UTC)


def _approve_po(db: Session, ctx, req) -> None:
    po = db.get(PurchaseOrder, req.entity_id)
    if po is None or po.status != "PENDING_APPROVAL":
        raise Conflict("Purchase order is not pending approval")
    po.status = "APPROVED"
    po.approved_by, po.approved_at = ctx.user_id, datetime.now(UTC)


def _reject_po(db: Session, ctx, req) -> None:
    po = db.get(PurchaseOrder, req.entity_id)
    if po and po.status == "PENDING_APPROVAL":
        po.status = "DRAFT"


approvals.register("PURCHASE_ORDER", _approve_po, _reject_po)


def refresh_po_status(po: PurchaseOrder) -> None:
    received = sum(ln.qty_received for ln in po.lines)
    outstanding = sum(ln.qty_outstanding for ln in po.lines)
    if outstanding == 0:
        po.status = "RECEIVED" if all(ln.qty_cancelled == 0 for ln in po.lines) else "CLOSED"
        po.closed_at = datetime.now(UTC)
    elif received > 0:
        po.status = "PARTIALLY_RECEIVED"


def receive_goods(db: Session, ctx, *, idempotency_key: str, location_id: uuid.UUID, supplier_id: uuid.UUID | None,
                  po_id: uuid.UUID | None, lines: list[dict], freight: Decimal, other_charges: Decimal,
                  supplier_ref: str | None, notes: str | None) -> tuple[GoodsReceipt, bool]:
    """Post a goods receipt exactly once. Returns (grn, created). A retried request with the same
    idempotency key returns the original receipt without touching stock again."""
    existing = db.scalar(select(GoodsReceipt).where(GoodsReceipt.idempotency_key == idempotency_key))
    if existing:
        ctx.ensure_resource(existing.location_id)
        return existing, False
    ctx.ensure_location(location_id)
    loc = db.get(Location, location_id)
    if loc is None or not loc.is_active:
        raise ValidationFailed("Receiving location not found or inactive")
    po = None
    if po_id:
        po = db.scalar(select(PurchaseOrder).where(PurchaseOrder.id == po_id).with_for_update(of=PurchaseOrder))
        if po is None:
            raise NotFound("Purchase order not found")
        if po.status not in OPEN_PO:
            raise Conflict(f"Purchase order is {po.status.lower().replace('_', ' ')}; it must be issued to receive goods")
        if po.location_id != location_id:
            raise ValidationFailed("Goods must be received at the purchase order's delivery location")
        supplier_id = po.supplier_id
    supplier = db.get(Supplier, supplier_id) if supplier_id else None
    if supplier is None:
        raise ValidationFailed("Supplier is required")
    if not lines:
        raise ValidationFailed("At least one line is required")
    po_lines = {ln.id: ln for ln in po.lines} if po else {}

    prepared = []
    for ln in lines:
        rec, dmg = int(ln.get("qty_received") or 0), int(ln.get("qty_damaged") or 0)
        if rec < 0 or dmg < 0 or rec + dmg == 0:
            raise ValidationFailed("Each line needs a positive received or damaged quantity")
        pol = None
        if po:
            pol = po_lines.get(ln.get("po_line_id")) if ln.get("po_line_id") else next(
                (p for p in po.lines if p.book_id == ln.get("book_id")), None)
            if pol is None:
                raise ValidationFailed("Line does not belong to this purchase order")
            if rec + dmg > pol.qty_outstanding:
                raise Conflict(f"Over-receipt for '{pol.book.title}': outstanding {pol.qty_outstanding}, receiving {rec + dmg}")
            book_id = pol.book_id
            cost = Decimal(ln["unit_cost"]) if ln.get("unit_cost") is not None else r4(pol.unit_cost * (1 - pol.discount_pct / 100))
        else:
            book_id = ln.get("book_id")
            if ln.get("unit_cost") is None:
                raise ValidationFailed("Unit cost is required for receipts without a purchase order")
            cost = Decimal(ln["unit_cost"])
        book = db.get(Book, book_id)
        if book is None:
            raise ValidationFailed("Book not found")
        if cost < 0:
            raise ValidationFailed("Unit cost cannot be negative")
        prepared.append((book, pol, rec, dmg, cost))

    goods_value = sum((r2(Decimal(rec + dmg) * cost) for _, _, rec, dmg, cost in prepared), ZERO)
    extra = r2(freight) + r2(other_charges)
    weights = [Decimal(rec + dmg) * cost for _, _, rec, dmg, cost in prepared]
    from app.services.gst import allocate

    extra_alloc = allocate(extra, weights) if goods_value > 0 else [ZERO] * len(prepared)

    grn = GoodsReceipt(
        id=uuid.uuid4(), number=next_number(db, "GRN"), po_id=po.id if po else None, supplier_id=supplier.id,
        location_id=location_id, supplier_ref=supplier_ref, freight=r2(freight), other_charges=r2(other_charges),
        goods_value=goods_value, total_landed=goods_value + extra, notes=notes, idempotency_key=idempotency_key,
        created_by=ctx.user_id,
    )
    db.add(grn)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(GoodsReceipt).where(GoodsReceipt.idempotency_key == idempotency_key))
        if existing:
            return existing, False
        raise
    ref = Ref("GRN", grn.id, grn.number)
    balances = inv.lock_balances(db, [(location_id, b.id) for b, *_ in prepared])
    for (book, pol, rec, dmg, cost), alloc in zip(prepared, extra_alloc, strict=True):
        qty = rec + dmg
        landed = r4(cost + alloc / qty)
        db.add(GoodsReceiptLine(grn_id=grn.id, po_line_id=pol.id if pol else None, book_id=book.id, qty_received=rec,
                                qty_damaged=dmg, unit_cost=r4(cost), landed_unit_cost=landed))
        bal = balances[(location_id, book.id)]
        inv.receive_cost(bal, qty, landed)
        if rec:
            inv.apply(db, bal, bucket="ON_HAND", delta=rec, movement_type="PURCHASE_RECEIPT", ref=ref,
                      actor_id=ctx.user_id, unit_cost=landed)
        if dmg:
            inv.apply(db, bal, bucket="DAMAGED", delta=dmg, movement_type="PURCHASE_RECEIPT_DAMAGED", ref=ref,
                      actor_id=ctx.user_id, unit_cost=landed, note="Received damaged")
        if book.tracking_mode == "COPY":
            if rec:
                inv.create_copies(db, book=book, location_id=location_id, qty=rec, status="AVAILABLE", unit_cost=landed,
                                  ref=ref, actor_id=ctx.user_id)
            if dmg:
                inv.create_copies(db, book=book, location_id=location_id, qty=dmg, status="DAMAGED", unit_cost=landed,
                                  ref=ref, actor_id=ctx.user_id, condition="DAMAGED")
        if pol:
            pol.qty_received += qty
        sp = db.scalar(select(SupplierProduct).where(SupplierProduct.supplier_id == supplier.id,
                                                     SupplierProduct.book_id == book.id))
        if sp is None:
            sp = SupplierProduct(supplier_id=supplier.id, book_id=book.id)
            db.add(sp)
        sp.last_cost, sp.last_purchased_at = r2(cost), datetime.now(UTC)
        if book.purchase_price != r2(cost):
            db.add(PriceHistory(book_id=book.id, field="PURCHASE_PRICE", old_value=book.purchase_price,
                                new_value=r2(cost), changed_by=ctx.user_id, reason=f"Goods receipt {grn.number}"))
            book.purchase_price = r2(cost)
    if po:
        refresh_po_status(po)
    je = accounting.post(db, source_type="GOODS_RECEIPT", source_id=grn.id, location_id=location_id, actor_id=ctx.user_id,
                         memo=f"GRN {grn.number} from {supplier.name}",
                         legs=[Leg("INVENTORY", grn.total_landed), Leg("GRNI", -grn.total_landed)])
    grn.journal_entry_id = je.id if je else None
    audit(db, ctx, "purchasing.goods_received", entity_type="goods_receipt", entity_id=grn.id, location_id=location_id,
          details={"number": grn.number, "po": po.number if po else None, "value": grn.total_landed})
    return grn, True


def record_supplier_invoice(db: Session, ctx, *, supplier_id, invoice_number: str, invoice_date: date,
                            due_date: date | None, grn_ids: list[uuid.UUID], taxable_amount: Decimal, cgst: Decimal,
                            sgst: Decimal, igst: Decimal, other_charges: Decimal, notes: str | None) -> SupplierInvoice:
    supplier = db.get(Supplier, supplier_id)
    if supplier is None:
        raise NotFound("Supplier not found")
    if not grn_ids:
        raise ValidationFailed("Link at least one goods receipt to the supplier invoice")
    grns = list(db.scalars(select(GoodsReceipt).where(GoodsReceipt.id.in_(grn_ids)).with_for_update(of=GoodsReceipt)))
    if len(grns) != len(set(grn_ids)):
        raise ValidationFailed("Goods receipt not found")
    for g in grns:
        ctx.ensure_resource(g.location_id)
        if g.supplier_id != supplier.id:
            raise ValidationFailed(f"{g.number} is from a different supplier")
        if g.supplier_invoice_id:
            raise Conflict(f"{g.number} is already invoiced")
    if cgst != sgst:
        raise ValidationFailed("CGST and SGST must be equal")
    if (cgst > 0 or sgst > 0) and igst > 0:
        raise ValidationFailed("An invoice carries either CGST+SGST or IGST, not both")
    total = r2(taxable_amount) + r2(cgst) + r2(sgst) + r2(igst) + r2(other_charges)
    si = SupplierInvoice(
        id=uuid.uuid4(), supplier_id=supplier.id, invoice_number=invoice_number.strip(), invoice_date=invoice_date,
        due_date=due_date or invoice_date + timedelta(days=supplier.payment_terms_days),
        po_id=grns[0].po_id, location_id=grns[0].location_id, taxable_amount=r2(taxable_amount), cgst=r2(cgst),
        sgst=r2(sgst), igst=r2(igst), other_charges=r2(other_charges), total=total, notes=notes, created_by=ctx.user_id,
    )
    db.add(si)
    db.flush()
    grni = sum((g.total_landed for g in grns), ZERO)
    variance = r2(taxable_amount) + r2(other_charges) - grni
    for g in grns:
        g.supplier_invoice_id = si.id
    je = accounting.post(db, source_type="SUPPLIER_INVOICE", source_id=si.id, location_id=si.location_id,
                         actor_id=ctx.user_id, memo=f"Supplier invoice {si.invoice_number} — {supplier.name}",
                         entry_date=invoice_date,
                         legs=[Leg("GRNI", grni), Leg("PURCHASE_VARIANCE", variance), Leg("INPUT_CGST", cgst),
                               Leg("INPUT_SGST", sgst), Leg("INPUT_IGST", igst), Leg("AP", -total)])
    si.journal_entry_id = je.id if je else None
    audit(db, ctx, "finance.supplier_invoice_recorded", entity_type="supplier_invoice", entity_id=si.id,
          location_id=si.location_id, details={"number": si.invoice_number, "total": total, "variance": variance})
    return si


def pay_supplier(db: Session, ctx, *, idempotency_key: str, supplier_id, location_id, payment_method_id,
                 account_id, amount: Decimal, reference: str | None, payment_date: date,
                 allocations: list[dict], notes: str | None) -> tuple[Payment, bool]:
    existing = db.scalar(select(Payment).where(Payment.idempotency_key == idempotency_key))
    if existing:
        ctx.ensure_resource(existing.location_id)
        return existing, False
    ctx.ensure_location(location_id)
    supplier = db.get(Supplier, supplier_id)
    if supplier is None:
        raise NotFound("Supplier not found")
    method = db.get(PaymentMethod, payment_method_id)
    if method is None or method.kind not in ("CASH", "BANK_TRANSFER", "UPI", "CARD", "OTHER"):
        raise ValidationFailed("Payment method not allowed for supplier payments")
    acc = db.get(Account, account_id) if account_id else db.get(Account, method.account_id)
    if acc is None or not acc.is_cash_or_bank:
        raise ValidationFailed("Pay from a cash or bank account")
    amount = r2(amount)
    if amount <= 0:
        raise ValidationFailed("Amount must be positive")
    if not allocations:
        raise ValidationFailed("Allocate the payment to at least one invoice")
    alloc_total = sum((r2(a["amount"]) for a in allocations), ZERO)
    if alloc_total != amount:
        raise ValidationFailed(f"Allocations ({alloc_total}) must equal the payment amount ({amount})")
    pay = Payment(
        id=uuid.uuid4(), number=sequence_number(db, "payment_seq", "PAY"), direction="OUT", purpose="SUPPLIER_PAYMENT",
        payment_method_id=method.id, account_id=acc.id, amount=amount, reference=reference, location_id=location_id,
        supplier_id=supplier.id, payment_date=payment_date, idempotency_key=idempotency_key, notes=notes,
        created_by=ctx.user_id,
    )
    db.add(pay)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Payment).where(Payment.idempotency_key == idempotency_key))
        if existing:
            return existing, False
        raise
    for a in sorted(allocations, key=lambda x: str(x["supplier_invoice_id"])):
        si = db.scalar(select(SupplierInvoice).where(SupplierInvoice.id == a["supplier_invoice_id"]).with_for_update(of=SupplierInvoice))
        if si is None or si.supplier_id != supplier.id:
            raise ValidationFailed("Invoice not found for this supplier")
        amt = r2(a["amount"])
        if amt <= 0 or amt > si.total - si.amount_paid:
            raise ValidationFailed(f"Invoice {si.invoice_number}: allocation exceeds balance due ({si.total - si.amount_paid})")
        if si.status == "CANCELLED":
            raise Conflict(f"Invoice {si.invoice_number} is cancelled")
        si.amount_paid += amt
        si.status = "PAID" if si.amount_paid == si.total else "PARTIALLY_PAID"
        db.add(PaymentAllocation(payment_id=pay.id, supplier_invoice_id=si.id, amount=amt))
    je = accounting.post(db, source_type="SUPPLIER_PAYMENT", source_id=pay.id, location_id=location_id,
                         actor_id=ctx.user_id, entry_date=payment_date, memo=f"Payment {pay.number} to {supplier.name}",
                         legs=[Leg("AP", amount), Leg(acc.id, -amount)])
    pay.journal_entry_id = je.id if je else None
    audit(db, ctx, "finance.supplier_paid", entity_type="payment", entity_id=pay.id, location_id=location_id,
          details={"supplier": supplier.name, "amount": amount, "number": pay.number})
    return pay, True


def return_to_supplier(db: Session, ctx, *, idempotency_key: str, supplier_id, location_id, grn_id, reason: str,
                       lines: list[dict]) -> tuple[SupplierReturn, bool]:
    existing = db.scalar(select(SupplierReturn).where(SupplierReturn.idempotency_key == idempotency_key))
    if existing:
        ctx.ensure_resource(existing.location_id)
        return existing, False
    ctx.ensure_location(location_id)
    supplier = db.get(Supplier, supplier_id)
    if supplier is None:
        raise NotFound("Supplier not found")
    if not lines:
        raise ValidationFailed("At least one line is required")
    sr = SupplierReturn(id=uuid.uuid4(), number=next_number(db, "PRN"), supplier_id=supplier.id, location_id=location_id,
                        grn_id=grn_id, reason=reason, idempotency_key=idempotency_key, created_by=ctx.user_id)
    db.add(sr)
    db.flush()
    ref = Ref("SUPPLIER_RETURN", sr.id, sr.number)
    balances = inv.lock_balances(db, [(location_id, ln["book_id"]) for ln in lines])
    value = ZERO
    for ln in lines:
        book = db.get(Book, ln["book_id"])
        bal = balances[(location_id, ln["book_id"])]
        qty, bucket = int(ln["qty"]), ln.get("from_bucket") or "ON_HAND"
        if bucket not in ("ON_HAND", "DAMAGED", "QUARANTINED"):
            raise ValidationFailed("Invalid source bucket")
        cost = bal.avg_cost or ZERO
        copy_ids = ln.get("copy_ids") or []
        if book.tracking_mode == "COPY":
            status = inv.COPY_STATUS_FOR_BUCKET[bucket]
            copies = inv.pick_copies(db, book_id=book.id, location_id=location_id, qty=qty, status=status,
                                     copy_ids=copy_ids or None)
            for c in copies:
                inv.apply(db, bal, bucket=bucket, delta=-1, movement_type="PURCHASE_RETURN", ref=ref,
                          actor_id=ctx.user_id, unit_cost=cost, copy_id=c.id, check_available=bucket == "ON_HAND")
                inv.move_copy(db, c, event="RETURNED_TO_SUPPLIER", to_status="RETURNED_TO_SUPPLIER", ref=ref,
                              actor_id=ctx.user_id)
                db.add(SupplierReturnLine(supplier_return_id=sr.id, book_id=book.id, copy_id=c.id, from_bucket=bucket,
                                          qty=1, unit_cost=cost))
        else:
            inv.apply(db, bal, bucket=bucket, delta=-qty, movement_type="PURCHASE_RETURN", ref=ref, actor_id=ctx.user_id,
                      unit_cost=cost, check_available=bucket == "ON_HAND")
            db.add(SupplierReturnLine(supplier_return_id=sr.id, book_id=book.id, from_bucket=bucket, qty=qty, unit_cost=cost))
        value += r2(Decimal(qty) * cost)
    sr.value = value
    je = accounting.post(db, source_type="SUPPLIER_RETURN", source_id=sr.id, location_id=location_id,
                         actor_id=ctx.user_id, memo=f"Debit note {sr.number} — {supplier.name}",
                         legs=[Leg("AP", value), Leg("INVENTORY", -value)])
    sr.journal_entry_id = je.id if je else None
    audit(db, ctx, "purchasing.supplier_return", entity_type="supplier_return", entity_id=sr.id, location_id=location_id,
          details={"number": sr.number, "value": value})
    return sr, True

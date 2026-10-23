"""GST billing engine (pure functions; no I/O).

Rules implemented (documented in docs/GST.md):
  * Amounts are Decimal; every per-line figure is rounded to paise (ROUND_HALF_UP).
  * Line discount is an absolute amount on the line (same price basis as unit price).
  * Bill discount is allocated across lines in proportion to their post-line-discount amount;
    the rounding remainder goes to the largest line so allocations sum exactly.
  * GST is computed per line on the discounted taxable value.
      - exclusive pricing: taxable = amount;  half = round(taxable * rate / 200)
      - inclusive pricing: half = round(amount * rate / (2 * (100 + rate)));  taxable = amount - 2*half
    so CGST == SGST on every line (intrastate). Interstate uses IGST = 2-half-equivalent computed directly.
  * Invoice total = sum of line totals, optionally rounded to the nearest rupee with an explicit
    round-off line.
Tax rates and classification come from configuration (tax classes), never hard-coded.
"""

from dataclasses import dataclass, field
from decimal import Decimal

from app.core.money import ZERO, D, r2, round_rupee

HUNDRED = Decimal("100")


class BillingError(ValueError):
    pass


@dataclass
class LineInput:
    unit_price: Decimal
    qty: int
    tax_rate: Decimal
    line_discount: Decimal = ZERO


@dataclass
class LineResult:
    gross: Decimal
    line_discount: Decimal
    bill_discount_alloc: Decimal
    taxable_value: Decimal
    cgst: Decimal
    sgst: Decimal
    igst: Decimal
    line_total: Decimal

    @property
    def tax(self) -> Decimal:
        return self.cgst + self.sgst + self.igst


@dataclass
class BillResult:
    lines: list[LineResult] = field(default_factory=list)
    gross: Decimal = ZERO
    line_discount_total: Decimal = ZERO
    bill_discount: Decimal = ZERO
    taxable_total: Decimal = ZERO
    cgst_total: Decimal = ZERO
    sgst_total: Decimal = ZERO
    igst_total: Decimal = ZERO
    round_off: Decimal = ZERO
    grand_total: Decimal = ZERO

    @property
    def tax_total(self) -> Decimal:
        return self.cgst_total + self.sgst_total + self.igst_total

    @property
    def discount_total(self) -> Decimal:
        return self.line_discount_total + self.bill_discount


def split_tax(amount: Decimal, rate: Decimal, *, inclusive: bool, interstate: bool) -> tuple[Decimal, Decimal, Decimal, Decimal]:
    """Return (taxable, cgst, sgst, igst) for a post-discount line amount."""
    amount = r2(amount)
    rate = D(rate)
    if rate < 0:
        raise BillingError("Tax rate cannot be negative")
    if rate == 0:
        return amount, ZERO, ZERO, ZERO
    if interstate:
        igst = r2(amount * rate / (HUNDRED + rate)) if inclusive else r2(amount * rate / HUNDRED)
        taxable = amount - igst if inclusive else amount
        return taxable, ZERO, ZERO, igst
    half = r2(amount * rate / (2 * (HUNDRED + rate))) if inclusive else r2(amount * rate / (2 * HUNDRED))
    taxable = amount - 2 * half if inclusive else amount
    return taxable, half, half, ZERO


def allocate(total: Decimal, weights: list[Decimal]) -> list[Decimal]:
    """Split `total` proportionally to weights in paise; remainder to the largest weight."""
    total = r2(total)
    wsum = sum(weights, ZERO)
    if total == ZERO or wsum == ZERO:
        return [ZERO] * len(weights)
    parts = [r2(total * w / wsum) for w in weights]
    diff = total - sum(parts, ZERO)
    if diff != ZERO:
        idx = max(range(len(weights)), key=lambda i: weights[i])
        parts[idx] += diff
    return parts


def compute_bill(lines: list[LineInput], *, prices_include_tax: bool, interstate: bool,
                 bill_discount: Decimal = ZERO, rounding: str = "NEAREST_RUPEE") -> BillResult:
    if not lines:
        raise BillingError("A bill needs at least one line")
    gross, nets, ldisc = [], [], []
    for ln in lines:
        if ln.qty <= 0:
            raise BillingError("Quantity must be positive")
        if D(ln.unit_price) < 0:
            raise BillingError("Price cannot be negative")
        g = r2(D(ln.unit_price) * ln.qty)
        d = r2(ln.line_discount)
        if d < 0 or d > g:
            raise BillingError("Line discount must be between 0 and the line amount")
        gross.append(g)
        ldisc.append(d)
        nets.append(g - d)
    bill_discount = r2(bill_discount)
    if bill_discount < 0 or bill_discount > sum(nets, ZERO):
        raise BillingError("Bill discount must be between 0 and the bill amount")
    allocs = allocate(bill_discount, nets)

    res = BillResult(bill_discount=bill_discount)
    for ln, g, d, n, a in zip(lines, gross, ldisc, nets, allocs, strict=True):
        amount = n - a
        taxable, cgst, sgst, igst = split_tax(amount, ln.tax_rate, inclusive=prices_include_tax, interstate=interstate)
        lr = LineResult(gross=g, line_discount=d, bill_discount_alloc=a, taxable_value=taxable, cgst=cgst, sgst=sgst,
                        igst=igst, line_total=taxable + cgst + sgst + igst)
        res.lines.append(lr)
        res.gross += g
        res.line_discount_total += d
        res.taxable_total += taxable
        res.cgst_total += cgst
        res.sgst_total += sgst
        res.igst_total += igst
    pre = res.taxable_total + res.tax_total
    if rounding == "NEAREST_RUPEE":
        res.round_off = round_rupee(pre) - pre
    res.grand_total = pre + res.round_off
    return res


def prorate_return(*, sale_qty: int, return_qty: int, taxable: Decimal, cgst: Decimal, sgst: Decimal, igst: Decimal,
                   already_qty: int = 0, already: tuple[Decimal, Decimal, Decimal, Decimal] | None = None
                   ) -> tuple[Decimal, Decimal, Decimal, Decimal]:
    """Refundable (taxable, cgst, sgst, igst) for returning `return_qty` of a sold line.

    Uses the original line's actual taxable value and tax (so discounts and rounding of the original
    sale are honoured). When the final units of a line are returned, the remainder is used so the
    sum of all returns equals the original line exactly.
    """
    if return_qty <= 0 or already_qty + return_qty > sale_qty:
        raise BillingError("Return quantity exceeds quantity sold")
    if already_qty + return_qty == sale_qty:
        a = already or (ZERO, ZERO, ZERO, ZERO)
        return taxable - a[0], cgst - a[1], sgst - a[2], igst - a[3]
    f = Decimal(return_qty) / Decimal(sale_qty)
    return r2(taxable * f), r2(cgst * f), r2(sgst * f), r2(igst * f)


# ---------------------------------------------------------------- identifiers

STATE_CODES = {
    "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
    "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
    "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura",
    "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh",
    "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra",
    "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
    "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
    "97": "Other Territory",
}

_GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_checksum_char(first14: str) -> str:
    total = 0
    for i, ch in enumerate(first14):
        v = _GSTIN_CHARS.index(ch)
        p = v * (2 if i % 2 else 1)
        total += p // 36 + p % 36
    return _GSTIN_CHARS[(36 - total % 36) % 36]


def valid_gstin(gstin: str) -> bool:
    import re

    g = gstin.strip().upper()
    if not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]", g):
        return False
    if g[:2] not in STATE_CODES:
        return False
    return gstin_checksum_char(g[:14]) == g[14]


def state_from_gstin(gstin: str | None) -> str | None:
    return gstin[:2] if gstin and len(gstin) >= 2 else None

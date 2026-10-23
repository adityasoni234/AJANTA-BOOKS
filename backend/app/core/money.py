"""Decimal helpers. All money is Decimal; floats are never used for currency."""

from decimal import ROUND_HALF_UP, Decimal

ZERO = Decimal("0")
PAISE = Decimal("0.01")
COST_Q = Decimal("0.0001")


def D(value) -> Decimal:
    if value is None:
        return ZERO
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        return Decimal(str(value))
    return Decimal(value)


def r2(value) -> Decimal:
    return D(value).quantize(PAISE, rounding=ROUND_HALF_UP)


def r4(value) -> Decimal:
    return D(value).quantize(COST_Q, rounding=ROUND_HALF_UP)


def round_rupee(value) -> Decimal:
    return D(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP)

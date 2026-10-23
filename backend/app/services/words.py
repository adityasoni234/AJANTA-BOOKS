"""Indian-system amount in words (lakh / crore) for invoices."""

from decimal import Decimal

ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
        "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _two(n: int) -> str:
    if n < 20:
        return ONES[n]
    return (TENS[n // 10] + (" " + ONES[n % 10] if n % 10 else "")).strip()


def _three(n: int) -> str:
    h, rest = divmod(n, 100)
    parts = []
    if h:
        parts.append(ONES[h] + " Hundred")
    if rest:
        parts.append(_two(rest))
    return " ".join(parts)


def integer_in_words(n: int) -> str:
    if n == 0:
        return "Zero"
    parts = []
    crore, n = divmod(n, 10_000_000)
    lakh, n = divmod(n, 100_000)
    thousand, n = divmod(n, 1000)
    if crore:
        parts.append(integer_in_words(crore) + " Crore")
    if lakh:
        parts.append(_two(lakh) + " Lakh")
    if thousand:
        parts.append(_two(thousand) + " Thousand")
    if n:
        parts.append(_three(n))
    return " ".join(parts)


def amount_in_words(amount: Decimal) -> str:
    amount = Decimal(amount).quantize(Decimal("0.01"))
    neg = amount < 0
    amount = abs(amount)
    rupees = int(amount)
    paise = int((amount - rupees) * 100)
    text = f"Rupees {integer_in_words(rupees)}"
    if paise:
        text += f" and {_two(paise)} Paise"
    return ("Minus " if neg else "") + text + " Only"

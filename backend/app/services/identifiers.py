"""ISBN / EAN helpers."""

import re


def clean_isbn(value: str) -> str:
    return re.sub(r"[\s-]", "", value or "").upper()


def valid_isbn10(isbn: str) -> bool:
    s = clean_isbn(isbn)
    if not re.fullmatch(r"\d{9}[\dX]", s):
        return False
    total = sum((10 - i) * (10 if c == "X" else int(c)) for i, c in enumerate(s))
    return total % 11 == 0


def ean13_check_digit(first12: str) -> str:
    total = sum(int(c) * (3 if i % 2 else 1) for i, c in enumerate(first12))
    return str((10 - total % 10) % 10)


def valid_ean13(code: str) -> bool:
    return bool(re.fullmatch(r"\d{13}", code)) and ean13_check_digit(code[:12]) == code[12]


def valid_isbn13(isbn: str) -> bool:
    s = clean_isbn(isbn)
    return s[:3] in ("978", "979") and valid_ean13(s)


def isbn10_to_13(isbn10: str) -> str:
    s = clean_isbn(isbn10)
    core = "978" + s[:9]
    return core + ean13_check_digit(core)


def isbn13_to_10(isbn13: str) -> str | None:
    s = clean_isbn(isbn13)
    if not s.startswith("978"):
        return None
    core = s[3:12]
    total = sum((10 - i) * int(c) for i, c in enumerate(core))
    check = (11 - total % 11) % 11
    return core + ("X" if check == 10 else str(check))


def internal_ean13(prefix: str, number: int) -> str:
    """In-store EAN-13 (GS1 restricted range 200-299) for items without an ISBN."""
    body = f"{prefix}{number:09d}"
    if len(body) != 12:
        raise ValueError("Barcode sequence exhausted")
    return body + ean13_check_digit(body)

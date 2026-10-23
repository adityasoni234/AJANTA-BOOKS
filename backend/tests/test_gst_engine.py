"""Requirement 10: GST-inclusive/exclusive pricing, CGST/SGST vs IGST, discounts, rounding (pure engine)."""

from decimal import Decimal as D

import pytest

from app.services import gst
from app.services.gst import LineInput, compute_bill
from app.services.identifiers import internal_ean13, isbn10_to_13, valid_ean13, valid_isbn10, valid_isbn13
from app.services.words import amount_in_words


def test_inclusive_intrastate_splits_cgst_sgst_equally():
    b = compute_bill([LineInput(D("118"), 1, D("18"))], prices_include_tax=True, interstate=False)
    ln = b.lines[0]
    assert (ln.taxable_value, ln.cgst, ln.sgst, ln.igst) == (D("100.00"), D("9.00"), D("9.00"), D("0"))
    assert b.grand_total == D("118.00") and b.round_off == D("0")


def test_exclusive_intrastate_adds_tax_on_top():
    b = compute_bill([LineInput(D("100"), 2, D("12"))], prices_include_tax=False, interstate=False)
    ln = b.lines[0]
    assert ln.taxable_value == D("200.00")
    assert ln.cgst == ln.sgst == D("12.00")
    assert b.grand_total == D("224.00")


def test_interstate_uses_igst_only():
    for inclusive, price, taxable in ((True, D("118"), D("100.00")), (False, D("100"), D("100.00"))):
        b = compute_bill([LineInput(price, 1, D("18"))], prices_include_tax=inclusive, interstate=True)
        ln = b.lines[0]
        assert ln.cgst == ln.sgst == D("0")
        assert ln.igst == D("18.00")
        assert ln.taxable_value == taxable


def test_exempt_items_have_no_tax():
    b = compute_bill([LineInput(D("499"), 3, D("0"))], prices_include_tax=True, interstate=False)
    assert b.tax_total == 0 and b.taxable_total == D("1497.00")


def test_line_and_bill_discounts_allocate_exactly_and_tax_the_discounted_base():
    b = compute_bill(
        [LineInput(D("500"), 2, D("0"), line_discount=D("50")), LineInput(D("118"), 1, D("18"))],
        prices_include_tax=True, interstate=False, bill_discount=D("50"),
    )
    novel, pen = b.lines
    assert novel.line_discount == D("50.00")
    assert novel.bill_discount_alloc + pen.bill_discount_alloc == D("50.00")
    assert novel.bill_discount_alloc == D("44.48") and pen.bill_discount_alloc == D("5.52")
    # pen: 118 - 5.52 = 112.48 inclusive @18% -> half tax 8.58 each
    assert pen.cgst == pen.sgst == D("8.58")
    assert pen.taxable_value == D("95.32")
    assert b.discount_total == D("100.00")
    assert b.grand_total == D("1018.00")
    assert b.taxable_total + b.tax_total + b.round_off == b.grand_total


@pytest.mark.parametrize("price,expected_round,expected_total", [
    (D("99.50"), D("0.50"), D("100")), (D("100.40"), D("-0.40"), D("100")), (D("100.00"), D("0"), D("100")),
])
def test_rounding_to_nearest_rupee(price, expected_round, expected_total):
    b = compute_bill([LineInput(price, 1, D("0"))], prices_include_tax=True, interstate=False)
    assert b.round_off == expected_round
    assert b.grand_total == expected_total


def test_rounding_disabled():
    b = compute_bill([LineInput(D("99.50"), 1, D("0"))], prices_include_tax=True, interstate=False, rounding="NONE")
    assert b.round_off == 0 and b.grand_total == D("99.50")


def test_invalid_inputs_rejected():
    with pytest.raises(gst.BillingError):
        compute_bill([], prices_include_tax=True, interstate=False)
    with pytest.raises(gst.BillingError):
        compute_bill([LineInput(D("10"), 1, D("0"), line_discount=D("11"))], prices_include_tax=True, interstate=False)
    with pytest.raises(gst.BillingError):
        compute_bill([LineInput(D("10"), 1, D("0"))], prices_include_tax=True, interstate=False, bill_discount=D("10.01"))
    with pytest.raises(gst.BillingError):
        compute_bill([LineInput(D("10"), 0, D("0"))], prices_include_tax=True, interstate=False)


def test_allocation_remainder_goes_to_largest_weight():
    assert gst.allocate(D("0.10"), [D(1), D(1), D(1)]) == [D("0.04"), D("0.03"), D("0.03")]
    assert sum(gst.allocate(D("7.77"), [D("3.3"), D("1.1"), D("9.9")])) == D("7.77")


def test_prorated_returns_sum_exactly_to_original_line():
    args = dict(sale_qty=3, taxable=D("100.00"), cgst=D("9.00"), sgst=D("9.00"), igst=D("0"))
    first = gst.prorate_return(return_qty=1, **args)
    second = gst.prorate_return(return_qty=1, already_qty=1, already=first, **args)
    done = tuple(a + b for a, b in zip(first, second, strict=True))
    last = gst.prorate_return(return_qty=1, already_qty=2, already=done, **args)
    assert first == (D("33.33"), D("3.00"), D("3.00"), D("0"))
    totals = tuple(a + b + c for a, b, c in zip(first, second, last, strict=True))
    assert totals == (D("100.00"), D("9.00"), D("9.00"), D("0"))
    with pytest.raises(gst.BillingError):
        gst.prorate_return(return_qty=2, already_qty=2, **args)


def test_gstin_validation():
    assert gst.valid_gstin("27AAPFU0939F1ZV")
    assert gst.valid_gstin("29AAGCB7383J1Z4")
    assert not gst.valid_gstin("27AAPFU0939F1ZA")  # bad checksum
    assert not gst.valid_gstin("99AAPFU0939F1ZV")  # unknown state
    assert not gst.valid_gstin("27AAPFU0939F1Z")


def test_isbn_and_barcode_helpers():
    assert valid_isbn13("978-0-306-40615-7")
    assert not valid_isbn13("9780306406158")
    assert valid_isbn10("0-306-40615-2") and valid_isbn10("080442957X")
    assert isbn10_to_13("0306406152") == "9780306406157"
    code = internal_ean13("200", 42)
    assert code.startswith("200") and len(code) == 13 and valid_ean13(code)


def test_amount_in_words_indian_system():
    assert amount_in_words(D("1234567.50")) == "Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Fifty Paise Only"
    assert amount_in_words(D("100000")) == "Rupees One Lakh Only"

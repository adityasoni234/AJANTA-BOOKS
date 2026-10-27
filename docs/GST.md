# GST billing rules implemented

> **Not certified.** This document describes what the software does. Have a qualified accountant confirm
> your registration type, tax classification of each product, invoice format and filing process before
> using it for statutory invoices. The system does not generate e-invoices (IRN/QR), e-way bills or
> GST returns.

## Configuration

* **Organisation** (Settings → Organisation & GST): legal/trade name, GSTIN (format + checksum validated),
  registration type (`REGULAR`, `COMPOSITION`, `UNREGISTERED`), state, PAN, financial-year start month.
* **Locations** may carry their own GSTIN (e.g. an outlet in another state); its state code must match.
* **Tax classes** (Settings → Tax classes) define rates; each book has a tax class and HSN code. Seeded classes:
  0 % (nil/exempt), 5 %, 12 %, 18 %, 28 %. Printed books are commonly nil-rated under HSN 4901; stationery
  and other goods carry their own rates — **verify current rates**.
* **Pricing mode** (Settings → Policies): selling prices *include* GST (default, typical MRP retail) or
  *exclude* it.

## Calculation (per bill)

1. Line gross = unit price × qty (unit price = location override if set, else catalog price; the browser
   never supplies prices).
2. Line discounts (amount) are applied; a bill discount is allocated across lines in proportion to their
   post-discount amounts, with the paise remainder on the largest line so allocations sum exactly.
3. GST is calculated **per line** on the discounted amount, rounded to paise (half-up):
   * Exclusive: taxable = amount; CGST = SGST = round(taxable × rate / 200); IGST = round(taxable × rate / 100).
   * Inclusive: CGST = SGST = round(amount × rate / (2 × (100 + rate))); taxable = amount − CGST − SGST;
     IGST = round(amount × rate / (100 + rate)).
   * CGST always equals SGST on a line.
4. **Intrastate vs interstate:** place of supply = the customer's GSTIN state for registered buyers, otherwise
   the outlet's state (over-the-counter retail). The API accepts a per-bill `place_of_supply` override (not exposed in the POS screen). Place of supply ≠ outlet state
   → IGST; otherwise CGST + SGST.
5. Invoice total = Σ line totals, optionally rounded to the nearest rupee with an explicit round-off line.

## Documents

* **Tax invoice** when the business is regular-registered and any line is taxable; **bill of supply** when all
  lines are exempt or the business is under composition/unregistered (no tax charged).
* Numbering: one consecutive series per outlet per financial year, e.g. `FRT/2627/000123` (≤16 characters,
  letters, digits, `/`). Numbers are issued inside the sale transaction with a row lock, never reused — a
  voided invoice keeps its number and is marked *cancelled*.
* Each invoice stores a snapshot of seller and buyer details, so later master-data edits do not alter issued
  documents. A4 tax invoices and 80 mm thermal receipts print from the browser (Print → Save as PDF).
* **Credit notes** (`FRTC/2627/00012`) are issued for returns and reference the original invoice. Refund
  amounts come from the original lines' taxable value and tax (pro-rated; the final unit returns the exact
  remainder, and a full return includes the original round-off), never from current prices.

## Reports

* **Rate & HSN summary:** quantity, taxable value, CGST, SGST, IGST per HSN and rate, net of credit notes.
* **Sales register:** every invoice and credit note with GSTIN, place of supply, B2B/B2C, taxable value and
  taxes; cancelled invoices appear with zero value. Both export to CSV.
* Input tax on supplier invoices is posted to Input CGST/SGST/IGST accounts (visible in the trial balance).

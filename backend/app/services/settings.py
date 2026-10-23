"""Typed organisation policy settings stored in the `settings` table."""

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.models import Setting

SETTINGS_KEY = "policy"


class PolicySettings(BaseModel):
    # Pricing & tax
    prices_include_tax: bool = True
    rounding: Literal["NONE", "NEAREST_RUPEE"] = "NEAREST_RUPEE"
    # Discounts: users with pos.discount may give up to this % per bill without approval.
    max_discount_pct: Decimal = Field(default=Decimal("10"), ge=0, le=100)
    allow_below_min_price_with_override: bool = True
    # Approval thresholds (₹). 0 disables the approval requirement.
    po_approval_threshold: Decimal = Field(default=Decimal("50000"), ge=0)
    refund_approval_threshold: Decimal = Field(default=Decimal("2000"), ge=0)
    expense_approval_threshold: Decimal = Field(default=Decimal("5000"), ge=0)
    adjustment_approval_threshold: Decimal = Field(default=Decimal("1000"), ge=0)
    transfer_requires_approval: bool = True
    # Returns
    return_window_days: int = Field(default=15, ge=0, le=365)
    # Credit sales / receivables
    credit_sales_enabled: bool = False
    # Loyalty (points per ₹100 of net spend; value of one point in ₹)
    loyalty_enabled: bool = False
    loyalty_points_per_100: Decimal = Field(default=Decimal("1"), ge=0)
    loyalty_point_value: Decimal = Field(default=Decimal("0.25"), ge=0)
    # Catalog
    barcode_prefix: str = Field(default="200", pattern=r"^2\d{2}$")
    sku_prefix: str = Field(default="AB", pattern=r"^[A-Z]{1,5}$")
    copy_code_prefix: str = Field(default="CP", pattern=r"^[A-Z]{1,4}$")
    # Register
    register_variance_alert: Decimal = Field(default=Decimal("100"), ge=0)
    # Inventory analysis
    dead_stock_days: int = Field(default=180, ge=30)
    slow_moving_days: int = Field(default=90, ge=7)
    excess_stock_multiplier: int = Field(default=4, ge=2)
    # Balance sheet: set true only once opening balances are entered.
    opening_balances_configured: bool = False


def get_policy(db: Session) -> PolicySettings:
    row = db.get(Setting, SETTINGS_KEY)
    return PolicySettings.model_validate(row.value if row else {})


def save_policy(db: Session, policy: PolicySettings, user_id) -> PolicySettings:
    row = db.get(Setting, SETTINGS_KEY)
    data = policy.model_dump(mode="json")
    if row is None:
        db.add(Setting(key=SETTINGS_KEY, value=data, updated_by=user_id))
    else:
        row.value = data
        row.updated_by = user_id
    return policy

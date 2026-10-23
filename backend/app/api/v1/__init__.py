from fastapi import APIRouter

from app.api.v1 import (
    admin,
    approvals,
    auth,
    catalog,
    customers,
    finance,
    inventory,
    pos,
    purchasing,
    reports,
    transfers,
)

router = APIRouter()
for module in (auth, admin, catalog, inventory, purchasing, transfers, pos, customers, finance, reports, approvals):
    router.include_router(module.router)

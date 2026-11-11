from fastapi import APIRouter

from app.api.v1 import (
    admin,
    approvals,
    auth,
    catalog,
    customers,
    finance,
    inventory,
    outlets,
    pos,
    purchasing,
    reports,
    schools,
    transfers,
)

router = APIRouter()
for module in (auth, admin, catalog, inventory, purchasing, transfers, pos, customers, finance, reports, approvals, schools, outlets):
    router.include_router(module.router)

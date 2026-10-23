import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError, OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import request_id_ctx

log = logging.getLogger("app.errors")


class AppError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str, *, code: str | None = None, details: Any = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        self.details = details


class NotFound(AppError):
    status_code = 404
    code = "not_found"


class Forbidden(AppError):
    status_code = 403
    code = "forbidden"


class Unauthorized(AppError):
    status_code = 401
    code = "unauthorized"


class Conflict(AppError):
    status_code = 409
    code = "conflict"


class ValidationFailed(AppError):
    status_code = 422
    code = "validation_failed"


class RateLimited(AppError):
    status_code = 429
    code = "rate_limited"


def _body(code: str, message: str, details: Any = None) -> dict:
    return {"error": {"code": code, "message": message, "details": details, "request_id": request_id_ctx.get()}}


# Map known constraint names to friendly messages.
CONSTRAINT_MESSAGES = {
    "uq_books_isbn13": "A book with this ISBN-13 already exists",
    "uq_books_isbn10": "A book with this ISBN-10 already exists",
    "uq_books_barcode": "This barcode is already assigned to another book",
    "uq_books_sku": "This SKU is already in use",
    "uq_users_email": "A user with this email already exists",
    "uq_locations_code": "A location with this code already exists",
    "ck_inventory_balances_on_hand_nonneg": "Insufficient stock: this would make stock negative",
    "ck_inventory_balances_in_transit_nonneg": "Invalid in-transit quantity",
    "ck_inventory_balances_damaged_nonneg": "Insufficient damaged stock",
    "ck_inventory_balances_quarantined_nonneg": "Insufficient quarantined stock",
    "uq_supplier_invoices_supplier_number": "This supplier invoice number is already recorded",
    "uq_register_sessions_one_open": "This register already has an open session",
    "uq_individual_copies_copy_code": "Copy code already exists",
    "uq_customers_phone": "A customer with this phone number already exists",
}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError):
        return JSONResponse(status_code=exc.status_code, content=_body(exc.code, exc.message, exc.details))

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        details = [
            {"loc": [str(p) for p in e.get("loc", [])], "msg": e.get("msg"), "type": e.get("type")}
            for e in exc.errors()
        ]
        return JSONResponse(status_code=422, content=_body("validation_failed", "Request validation failed", details))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException):
        return JSONResponse(status_code=exc.status_code, content=_body("http_error", str(exc.detail)))

    @app.exception_handler(IntegrityError)
    async def _integrity(_: Request, exc: IntegrityError):
        constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        msg = CONSTRAINT_MESSAGES.get(constraint or "", "The request conflicts with existing data")
        log.warning("integrity_error", extra={"constraint": constraint})
        return JSONResponse(status_code=409, content=_body("conflict", msg, {"constraint": constraint}))

    @app.exception_handler(OperationalError)
    async def _operational(_: Request, exc: OperationalError):
        log.exception("database_operational_error")
        return JSONResponse(status_code=503, content=_body("database_unavailable", "Database temporarily unavailable"))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception):
        log.exception("unhandled_error")
        return JSONResponse(status_code=500, content=_body("internal_error", "An unexpected error occurred"))

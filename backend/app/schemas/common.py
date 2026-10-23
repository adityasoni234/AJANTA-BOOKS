from typing import Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings

T = TypeVar("T")


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


class PageParams:
    def __init__(self, page: int = Query(1, ge=1, le=100000), page_size: int = Query(25, ge=1)):
        self.page = page
        self.page_size = min(page_size, get_settings().max_page_size)

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


def paginate(db: Session, stmt: Select, params: PageParams, *, scalars: bool = True) -> tuple[list, int]:
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
    q = stmt.offset(params.offset).limit(params.page_size)
    rows = list(db.scalars(q).unique()) if scalars else list(db.execute(q))
    return rows, total


class Message(BaseModel):
    message: str

from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from vita29.settings import get_settings


def create_database_engine(database_url: str | None = None):
    url = database_url or get_settings().database_url
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    database_engine = create_engine(url, connect_args=connect_args, pool_pre_ping=True)
    if url.startswith("sqlite"):
        @event.listens_for(database_engine, "connect")
        def register_unicode_casefold(dbapi_connection, _connection_record) -> None:
            dbapi_connection.create_function(
                "casefold",
                1,
                lambda value: value.casefold() if isinstance(value, str) else value,
                deterministic=True,
            )
    return database_engine


engine = create_database_engine()
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session

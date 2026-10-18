import os
from collections.abc import Generator

from fastapi import Request
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker


def make_database(url: str | None = None) -> tuple[Engine, sessionmaker[Session]]:
    database_url = url or os.getenv("DATABASE_URL", "sqlite:///./newtonite.db")
    connect_args = {"check_same_thread": False, "timeout": 20} if database_url.startswith("sqlite") else {}
    pool_options = {} if database_url.startswith("sqlite") else {
        "pool_size": int(os.getenv("DB_POOL_SIZE", "10")),
        "max_overflow": int(os.getenv("DB_MAX_OVERFLOW", "20")),
        "pool_recycle": int(os.getenv("DB_POOL_RECYCLE_SECONDS", "1800")),
    }
    engine = create_engine(database_url, connect_args=connect_args, pool_pre_ping=True, **pool_options)
    return engine, sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db(request: Request) -> Generator[Session, None, None]:
    session_factory = request.app.state.session_factory
    with session_factory() as session:
        yield session

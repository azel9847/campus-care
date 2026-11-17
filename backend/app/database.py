
from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


is_sqlite = settings.database_url.startswith("sqlite")

connect_args = (
    {"check_same_thread": False}
    if is_sqlite
    else {}
)

engine_options = {
    "connect_args": connect_args,
    "pool_pre_ping": True,
}

# Limit PostgreSQL connections to avoid exhausting
# Supabase Session Pooler capacity.
if not is_sqlite:
    engine_options.update({
        "pool_size": 2,
        "max_overflow": 0,
        "pool_timeout": 30,
        "pool_recycle": 1800,
    })

engine = create_engine(
    settings.database_url,
    **engine_options
)

if is_sqlite:
    @event.listens_for(engine, "connect")
    def enable_sqlite_foreign_keys(connection, _record) -> None:
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    expire_on_commit=False,
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

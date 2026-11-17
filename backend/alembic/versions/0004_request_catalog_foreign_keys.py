from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision = "0004_catalog_fk"
down_revision = "0003_campus_catalog"
branch_labels = None
depends_on = None


def _insert_legacy_values(column_name: str, catalog_name: str) -> None:
    bind = op.get_bind()
    catalog = sa.table(
        catalog_name,
        sa.column("name", sa.String),
        sa.column("is_active", sa.Boolean),
        sa.column("created_at", sa.DateTime(timezone=True)),
    )
    values = bind.execute(sa.text(f"SELECT DISTINCT {column_name} FROM maintenance_requests")).scalars().all()
    for value in values:
        if value and bind.execute(sa.select(catalog.c.name).where(catalog.c.name == value)).scalar_one_or_none() is None:
            bind.execute(catalog.insert().values(
                name=value,
                is_active=True,
                created_at=datetime.now(timezone.utc),
            ))


def upgrade():
    _insert_legacy_values("category", "maintenance_categories")
    _insert_legacy_values("building", "campus_locations")
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("maintenance_requests") as batch:
            batch.create_foreign_key(
                "fk_maintenance_requests_category",
                "maintenance_categories",
                ["category"],
                ["name"],
            )
            batch.create_foreign_key(
                "fk_maintenance_requests_building",
                "campus_locations",
                ["building"],
                ["name"],
            )
    else:
        op.create_foreign_key(
            "fk_maintenance_requests_category",
            "maintenance_requests",
            "maintenance_categories",
            ["category"],
            ["name"],
        )
        op.create_foreign_key(
            "fk_maintenance_requests_building",
            "maintenance_requests",
            "campus_locations",
            ["building"],
            ["name"],
        )


def downgrade():
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("maintenance_requests") as batch:
            batch.drop_constraint("fk_maintenance_requests_building", type_="foreignkey")
            batch.drop_constraint("fk_maintenance_requests_category", type_="foreignkey")
    else:
        op.drop_constraint("fk_maintenance_requests_building", "maintenance_requests", type_="foreignkey")
        op.drop_constraint("fk_maintenance_requests_category", "maintenance_requests", type_="foreignkey")

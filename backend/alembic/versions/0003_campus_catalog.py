from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision = "0003_campus_catalog"
down_revision = "0002_delivery_support"
branch_labels = None
depends_on = None

CATEGORIES = (
    "Electrical",
    "Plumbing",
    "Furniture",
    "Computer / IT equipment",
    "Classroom facilities",
    "Building maintenance",
    "Other",
)
LOCATIONS = ("Main Campus", "Other")


def upgrade():
    created_at = datetime.now(timezone.utc)
    op.create_table(
        "maintenance_categories",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False, unique=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_maintenance_categories_name", "maintenance_categories", ["name"])
    op.create_table(
        "campus_locations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False, unique=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_campus_locations_name", "campus_locations", ["name"])
    op.bulk_insert(
        sa.table(
            "maintenance_categories",
            sa.column("name", sa.String),
            sa.column("is_active", sa.Boolean),
            sa.column("created_at", sa.DateTime(timezone=True)),
        ),
        [{"name": name, "is_active": True, "created_at": created_at} for name in CATEGORIES],
    )
    op.bulk_insert(
        sa.table(
            "campus_locations",
            sa.column("name", sa.String),
            sa.column("is_active", sa.Boolean),
            sa.column("created_at", sa.DateTime(timezone=True)),
        ),
        [{"name": name, "is_active": True, "created_at": created_at} for name in LOCATIONS],
    )


def downgrade():
    op.drop_index("ix_campus_locations_name", table_name="campus_locations")
    op.drop_table("campus_locations")
    op.drop_index("ix_maintenance_categories_name", table_name="maintenance_categories")
    op.drop_table("maintenance_categories")

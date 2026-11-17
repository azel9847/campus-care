import sqlalchemy as sa
from alembic import op

revision = "0002_delivery_support"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "attachments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("public_id", sa.String(36), nullable=False, unique=True),
        sa.Column("request_id", sa.Integer(), sa.ForeignKey("maintenance_requests.id")),
        sa.Column("work_order_id", sa.Integer(), sa.ForeignKey("work_orders.id")),
        sa.Column("uploader_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("content_type", sa.String(80), nullable=False),
        sa.Column("file_path", sa.String(500), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_attachments_public_id", "attachments", ["public_id"])
    op.create_index("ix_attachments_request_id", "attachments", ["request_id"])
    op.create_index("ix_attachments_work_order_id", "attachments", ["work_order_id"])
    op.create_table(
        "notification_receipts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("notification_id", sa.Integer(), sa.ForeignKey("notifications.id"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("notification_id", "user_id", name="uq_notification_user_receipt"),
    )
    op.create_index("ix_notification_receipts_notification_id", "notification_receipts", ["notification_id"])
    op.create_index("ix_notification_receipts_user_id", "notification_receipts", ["user_id"])


def downgrade():
    op.drop_index("ix_notification_receipts_user_id", table_name="notification_receipts")
    op.drop_index("ix_notification_receipts_notification_id", table_name="notification_receipts")
    op.drop_table("notification_receipts")
    op.drop_index("ix_attachments_work_order_id", table_name="attachments")
    op.drop_index("ix_attachments_request_id", table_name="attachments")
    op.drop_index("ix_attachments_public_id", table_name="attachments")
    op.drop_table("attachments")

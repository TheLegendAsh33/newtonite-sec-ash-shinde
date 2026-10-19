"""Add optional timezone-aware work-item deadlines.

Revision ID: 0003_deadlines
Revises: 0002_idempotency
Create Date: 2026-10-19
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0003_deadlines"
down_revision: Union[str, None] = "0002_idempotency"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("work_items", sa.Column("due_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_items_team_due", "work_items", ["team_id", "due_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_items_team_due", table_name="work_items")
    op.drop_column("work_items", "due_at")

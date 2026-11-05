"""Create the notes table, an example for the notes resource. Replace both with your own.

Revision ID: 0001
Revises:
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE notes (
          id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
          created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE notes")

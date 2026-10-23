"""Database-level integrity guarantees: append-only ledgers, immutable financial documents,
balanced journals.

Revision ID: 0002
Revises: 0001
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

APPEND_ONLY = ["inventory_ledger", "audit_logs", "journal_lines", "journal_entries", "copy_events", "customer_ledger", "sale_lines", "return_lines"]


def upgrade() -> None:
    # Non-gapless unique numbering for high-volume internal documents (journals, payments) so
    # concurrent outlets do not serialise on a counter row. Invoices/credit notes stay gapless.
    op.execute("CREATE SEQUENCE IF NOT EXISTS journal_entry_seq")
    op.execute("CREATE SEQUENCE IF NOT EXISTS payment_seq")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'Table % is append-only (% not permitted)', TG_TABLE_NAME, TG_OP
            USING ERRCODE = 'integrity_constraint_violation';
        END $$;
        """
    )
    for table in APPEND_ONLY:
        op.execute(
            f"CREATE TRIGGER trg_{table}_append_only BEFORE UPDATE OR DELETE ON {table} "
            f"FOR EACH ROW EXECUTE FUNCTION forbid_mutation();"
        )

    # Invoices: only the status may change (ISSUED -> CANCELLED); never deleted.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'Invoices cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF (NEW.number, NEW.doc_type, NEW.sale_id, NEW.return_id, NEW.location_id, NEW.financial_year,
              NEW.issued_at, NEW.seller, NEW.buyer, NEW.place_of_supply, NEW.original_invoice_id)
             IS DISTINCT FROM
             (OLD.number, OLD.doc_type, OLD.sale_id, OLD.return_id, OLD.location_id, OLD.financial_year,
              OLD.issued_at, OLD.seller, OLD.buyer, OLD.place_of_supply, OLD.original_invoice_id) THEN
            RAISE EXCEPTION 'Issued invoices are immutable' USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED' THEN
            RAISE EXCEPTION 'Cancelled invoices cannot be reinstated' USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER trg_invoices_guard BEFORE UPDATE OR DELETE ON invoices
          FOR EACH ROW EXECUTE FUNCTION invoices_guard();
        """
    )

    # Sales: financial figures are frozen once written; status/payment progress may change.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION sales_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'Sales cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF (NEW.location_id, NEW.register_session_id, NEW.customer_id, NEW.gross_amount, NEW.line_discount_total,
              NEW.bill_discount, NEW.taxable_total, NEW.cgst_total, NEW.sgst_total, NEW.igst_total, NEW.round_off,
              NEW.grand_total, NEW.created_at, NEW.created_by, NEW.idempotency_key)
             IS DISTINCT FROM
             (OLD.location_id, OLD.register_session_id, OLD.customer_id, OLD.gross_amount, OLD.line_discount_total,
              OLD.bill_discount, OLD.taxable_total, OLD.cgst_total, OLD.sgst_total, OLD.igst_total, OLD.round_off,
              OLD.grand_total, OLD.created_at, OLD.created_by, OLD.idempotency_key) THEN
            RAISE EXCEPTION 'Finalized sales are immutable' USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED' THEN
            RAISE EXCEPTION 'Cancelled sales cannot be reinstated' USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER trg_sales_guard BEFORE UPDATE OR DELETE ON sales
          FOR EACH ROW EXECUTE FUNCTION sales_guard();
        """
    )

    # Every journal entry must balance and have at least two lines; checked at commit time.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE d numeric; c numeric; n int;
        BEGIN
          SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) INTO d, c, n
            FROM journal_lines WHERE entry_id = NEW.entry_id;
          IF d <> c THEN
            RAISE EXCEPTION 'Journal entry % is unbalanced (debit %, credit %)', NEW.entry_id, d, c
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF n < 2 THEN
            RAISE EXCEPTION 'Journal entry % needs at least two lines', NEW.entry_id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NULL;
        END $$;
        CREATE CONSTRAINT TRIGGER trg_journal_balanced AFTER INSERT ON journal_lines
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_balanced();
        """
    )


def downgrade() -> None:
    op.execute("DROP SEQUENCE IF EXISTS journal_entry_seq")
    op.execute("DROP SEQUENCE IF EXISTS payment_seq")
    op.execute("DROP TRIGGER IF EXISTS trg_journal_balanced ON journal_lines")
    op.execute("DROP FUNCTION IF EXISTS journal_balanced()")
    op.execute("DROP TRIGGER IF EXISTS trg_sales_guard ON sales")
    op.execute("DROP FUNCTION IF EXISTS sales_guard()")
    op.execute("DROP TRIGGER IF EXISTS trg_invoices_guard ON invoices")
    op.execute("DROP FUNCTION IF EXISTS invoices_guard()")
    for table in APPEND_ONLY:
        op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_append_only ON {table}")
    op.execute("DROP FUNCTION IF EXISTS forbid_mutation()")

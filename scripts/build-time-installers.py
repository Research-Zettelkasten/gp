"""Build feature transactions independently of Supabase-managed Cron installation."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1] / "supabase"
base = [
    "2026-11-16-admin-clock-out.sql",
    "2026-11-17-clock-out-text-hours-fix.sql",
    "2026-11-23-weekly-time-and-auto-clock-out.sql",
]
approval = base + ["2026-11-23-clock-in-approval.sql"]
navigation = approval + [
    "2026-11-18-quote-callback-import.sql",
    "2026-11-23-navigation-and-admin-live-corrections.sql",
]
for name, migrations in [
    ("GLASSPRO-WEEKLY-TIME-INSTALL.sql", base),
    ("GLASSPRO-LIVE-PUNCH-APPROVALS-INSTALL.sql", approval),
    ("GLASSPRO-NAVIGATION-AND-LIVE-CORRECTIONS-INSTALL.sql", navigation),
]:
    parts = [
        "-- GLASSPRO feature installation for the existing portal.\n"
        "-- Run this COMPLETE file in Supabase SQL Editor. Atomic and rerunnable.\n"
        "-- Cron setup is separate: this transaction does not install extensions,\n"
        "-- change Cron permissions/jobs, or run an overdue clock-out sweep.\n"
        "-- Existing scheduled jobs remain in place. For new scheduling, see\n"
        "-- ENABLE-AUTO-CLOCK-OUT-CRON.sql after enabling Cron in the Dashboard.\n"
        "begin;\n"
    ]
    for migration in migrations:
        source = (root / "migrations" / migration).read_text()
        source = re.sub(r"^(?:begin;|commit;)\s*$", "", source, flags=re.M)
        parts.append(f"\n-- Included: migrations/{migration}\n{source}")
    parts.append("\ncommit;\n")
    (root / name).write_text("\n".join(parts))

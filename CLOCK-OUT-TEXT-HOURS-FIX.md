# GLASSPRO clock-out: text/numeric compatibility repair

The clock-out function compared the saved hours column directly with a numeric calculation. A legacy database where time_logs.decimal_hours is text therefore raised "operator does not exist: text = numeric" after attempting to insert the timecard.

The repair converts the saved value to numeric for that comparison and returns numeric hours consistently. It supports both text and numeric hours columns. It replaces only the existing clock-out function and its execution grants; it does not convert columns, rewrite historical timecards, or end any active shift while installing.

## Install
1. Open supabase/migrations/2026-11-17-clock-out-text-hours-fix.sql in Notepad.
2. Copy its entire SQL into Supabase → SQL Editor → New query.
3. Click Run and wait for success. This is SQL; no Edge Function change is needed.
4. Return to GLASSPRO, refresh with Ctrl+F5, and retry the administrator clock-out with the employee's actual departure date and time.

A website or Netlify redeployment is not needed for this database repair. The original administrator clock-out migration must already be installed.

## Validation
The regression reproduces the exact text = numeric error using a legacy text hours column. It checks rollback and active-punch preservation before the repair, then administrator and employee completion, one-minute rounding, lunch deduction, idempotent retries, audit-failure rollback, numeric-column compatibility, and access controls after applying the repair.

Run tests/clock-out-text-hours.sql only in the disposable gp_clock_test database, after the existing database and concurrency tests. Do not run the test fixture in the live Supabase project.

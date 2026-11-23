# Weekly timecards and missed clock-outs — November 23, 2026

## Install on the existing portal

1. In Supabase **SQL Editor → New query**, paste and run the complete contents of [`supabase/GLASSPRO-WEEKLY-TIME-INSTALL.sql`](supabase/GLASSPRO-WEEKLY-TIME-INSTALL.sql). Open **Raw** in GitHub to copy SQL only. The atomic bundle includes the rerunnable November 16/17 clock-out prerequisites and the November 23 migration. It does not install extensions or change Cron permissions/jobs.
2. Check **Supabase → Integrations → Cron** for an existing active `glasspro-missed-clock-out` job. If it is already running, keep it. Otherwise enable Cron through the Dashboard, then run `supabase/ENABLE-AUTO-CLOCK-OUT-CRON.sql` separately. This scheduler file does not install extensions or modify managed permissions.
3. Refresh the deployed website. No build command or new keys are required.
4. In Management → Time & Attendance → **Live Time Monitoring**, open **Automatic clock-out reviews**. Running the scheduler file or the existing scheduled job processes overdue sessions, including old active clocks with matching saved timecards. Check and correct their hours before marking them reviewed.

This code update does not directly change your live Supabase data. The SQL installation is required. Existing Auth/RLS, active-session, exact-lunch and lunch-review tables must already exist. The installer does not replace the entire schema, delete past weeks or convert payroll column types.

For projects where the earlier clock-out SQL is already installed, the two new components can also be run separately, in this order:

1. `supabase/migrations/2026-11-23-weekly-time-and-auto-clock-out.sql`
2. `supabase/ENABLE-AUTO-CLOCK-OUT-CRON.sql`

The scheduler file's final query should show one active job named **glasspro-missed-clock-out** with schedule `* * * * *`. Re-running the scheduler file updates the same named job for the SQL Editor role. Re-running the feature installer leaves jobs unchanged. In Supabase Cron, check **Job runs** to confirm successful executions. The worker runs inside Supabase while browsers and employee devices are closed. It does not depend on a ChatGPT reminder or browser timer.

## Exact policy

All dates and cutoffs use **America/New_York**, including daylight-saving changes.

| Clock-in | Scheduled check | Recorded default end | Review |
| --- | --- | --- | --- |
| At or before 6:00 PM | 12:01 AM the following calendar day | 5:00 PM on the clock-in date | Required |
| After 6:00 PM | 7:30 AM the following calendar day | 7:30 AM that following day | Required |

The worker checks every minute, but the recorded default time is exactly 5:00 PM or 7:30 AM. A delayed execution uses the original shift's cutoff and default, not the later time the worker happens to run. The first run catches up older overdue sessions using the same rule.

Examples:

- Monday 7:51 AM clock-in, still active Tuesday at 12:01 AM: save Monday's end as **5:00 PM**, subtract recorded unpaid lunch, remove the active clock and flag manager review.
- Monday 7:00 PM clock-in: leave active through midnight; if still active Tuesday at 7:30 AM, close at **7:30 AM**, flag review and retain Monday as the work date.
- Monday 5:30 PM clock-in: the regular 5 PM default would precede clock-in. Close the stale active clock into the review queue and preserve all original punches. **No negative or guessed payroll timecard is created.** A manager records the actual end time.

An automatic entry is an estimate awaiting verification. It never silently approves the hours. Confirming clock-out review does not approve a separate no-lunch exception; that existing lunch-review workflow remains in effect.

## Existing saved timecard / stale active clock repair

Older clients could save a completed timecard and then fail to delete the separate active-clock row. The old duplicate-prevention check deliberately blocked another save. This update provides a recovery action:

1. In Live Time Monitoring, select **Clock Out** for the employee.
2. If matching completed records exist, inspect the displayed saved timecard date, punches, hours, lunch and notes. Choose the correct record if more than one appears.
3. Enter a verification reason and choose **Keep timecard & clear active clock**.

The server links the existing record to that session, records an audit entry and removes only the matching active clock. Existing hours, punches, notes and lunch decisions remain intact. If the saved timecard itself is wrong, correct it with **Edit Punch**; clearing the stale clock does not overwrite payroll with a new guessed time.

The automatic worker can retain one matching valid saved record as well. Multiple matches, malformed timecards, missing exact break information or punches inconsistent with the default are held in the review queue with the original session and candidate record IDs. They do not generate another payroll record. Active clocks are cleared so an employee can start the next shift.

## Manager review queue

Open Management → Time Hub → **Live Time Monitoring → Automatic clock-out reviews**. Every automatic closure has its own persistent review entry, original active-session snapshot, due time, intended default time, reason and saved timecard reference.

- For a generated or retained timecard: locate its ID in the shift register, verify/correct punches through **Edit Punch**, then enter a manager explanation and mark the clock-out reviewed.
- If no payroll timecard was created: use the retained evidence to save a corrected shift or identify the correct existing card. Enter that timecard ID in the review entry, add a verification note and approve. The server rechecks employee, work date, clock-in and session identity before attaching it.
- Approved review entries and audit records remain in the database. Approving after correcting clock-out also updates completion metadata to the corrected actual end.

Only active administrators can perform recovery and review actions. Employees may read their own automatic-close evidence; other employees' evidence remains private. Browsers cannot execute the scheduling worker or forge its automatic-review flags. Timecard creation/recovery, audit records and active-clock removal commit atomically. Concurrent employee, manager and scheduler actions use the same account lock and unique session identity.

## Weekly employee history

The employee history defaults to the current **Monday–Sunday** week in Eastern time. It changes to the new week while the page is open and refreshes when returning to the page. Changing weeks changes the view; it does not erase or move any timecards.

Use **Previous week**, **Next week**, **This week**, or **Jump to a date**. A selected historical week stays selected until changed. All matching shifts appear, including more than ten records. The top summary and table footer total every recorded paid-hour value in that week. Lunch deductions and pending reviews remain visible.

An active shift estimate appears separately, with a combined estimate for the selected week when applicable. It is not counted as a saved timecard. Overnight shifts belong entirely to the clock-in/work date, matching the administrator register; a Sunday emergency shift appears in the preceding week even when it ends Monday morning. The current weekly cap banner follows the current week, regardless of which historical week is being viewed.

## Validation and references

Checks cover Eastern Monday rollover from a browser in another timezone, previous weeks, all-shift totals, exact cutoffs, daylight-saving changes, exact lunches, impossible defaults, legacy saved-card recovery, manager corrections, permissions, audit rollback, text/numeric hour storage, and concurrent scheduled/manual clock-outs. Browser workflows exercise week navigation, automatic rollover, stale-clock recovery and manager review using synthetic records.

Scheduling follows the official [Supabase Cron installation](https://supabase.com/docs/guides/cron/install) and [job scheduling](https://supabase.com/docs/guides/cron/quickstart) interfaces. The separate scheduler file sets up the database job after Cron is enabled in the Dashboard; the feature bundle and GitHub deployment do not enable it.

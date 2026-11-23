# Live punches, clock-in approval and appearance — November 23, 2026

## Assessment

Live-only employee entry is a reasonable choice when it includes an audited correction process. It keeps the original punch and GPS evidence while allowing a manager to verify an employee's actual start. Removing unrestricted manual shifts also prevents an old browser page from adding unapproved timecards.

The tradeoff is that an employee who completely missed a clock-in, or could not connect, needs an administrator to add the missing shift. **Management → Time & Geotags → Add Missing Shift** remains available. A request for an earlier start applies to an existing live session; it is not a replacement for an entirely missing shift. Managers should check the pending queue regularly so actual hours are corrected promptly.

## Install

1. Open [`supabase/GLASSPRO-LIVE-PUNCH-APPROVALS-INSTALL.sql`](supabase/GLASSPRO-LIVE-PUNCH-APPROVALS-INSTALL.sql) in GitHub and choose **Raw**.
2. Copy the complete SQL into **Supabase → SQL Editor → New query** and run it on the existing GLASSPRO project.
3. Refresh the deployed website. The new release removes employee Manual Shift Entry and exposes the approval queue in Management → Time & Geotags.

The installer includes the earlier clock-out prerequisites, weekly/missed-clock-out migration and the new approval migration. It is additive, rerunnable and atomic. It retains existing histories and requests and leaves Cron setup, permissions and jobs unchanged. Existing Auth/RLS and exact-lunch tables are required. GitHub deployment alone does not apply SQL to the live project.

For new automatic clock-out scheduling, enable Cron in **Supabase → Integrations → Cron**, then separately run `supabase/ENABLE-AUTO-CLOCK-OUT-CRON.sql`. Existing active jobs can continue unchanged. The scheduler file processes overdue sessions when it is run; the feature installer does not. See the weekly setup guide for job verification.

If every earlier timekeeping migration is already installed, `supabase/migrations/2026-11-23-clock-in-approval.sql` can be run by itself instead. Do not paste JavaScript into SQL Editor.

## Employee workflow

1. Clock in with **Live Punch Clock**. The database records the actual server timestamp and retains its original session identifier.
2. If the start is wrong, expand **Request a clock-in correction**, enter the actual date/time and explain why it differs. Requested times must be within 24 hours of the recorded punch and cannot be in the future.
3. Choose **Send for administrator approval**. The original time and paid-hours calculation remain in effect while the request is pending.
4. The request's status and manager explanation appear under the form. The employee can withdraw a pending request. Only one pending request is allowed for a shift.

Employees continue to clock out normally while waiting for review. Approval can be applied to the active session or to its completed timecard. A manager does not need to keep the employee clocked in while investigating a request.

An entirely missed clock-in requires administrator missing-shift entry. A stale active clock with an already-saved timecard must first be recovered using the existing **Keep timecard & clear active clock** workflow.

## Administrator workflow

Open **Management → Time & Geotags → Clock-in correction approvals**. Compare the recorded and requested times, verify the explanation, add a review note, and approve or reject.

- Approval of a live session stores a separate approved start. It does not overwrite the original recorded timestamp or session identifier. Live elapsed hours and later completion use the approved start.
- If the shift ended before approval, the same timecard is updated and its paid hours recalculated. No second timecard is created. The recorded clock-out, exact lunch punches, location evidence and separate lunch-review decisions remain intact.
- Rejection changes no punches or payroll hours. Withdrawal and all manager decisions remain in the request history. Manager decisions also create audit records with the before-record, original/requested starts, reasons and reviewer identity.
- A stale request cannot overwrite a timecard another administrator already corrected. An impossible duration, a start after recorded lunch, or inconsistent payroll calculation remains pending for investigation.
- Clock-in approval does not approve a separate automatic-clock-out or no-lunch review. Those queues remain distinct.

All request ownership, administrator permissions, direct-write restrictions and calculation checks are enforced in the database. The original active-clock timestamp cannot be edited directly, including from an older page. Regular employee timecards can be created only by the protected live clock-out function. Administrators retain their existing audited correction/missing-shift tools.

## Automatic cutoffs

The previous policy remains: a regular missed clock-out checked at **12:01 AM Eastern** defaults to **5 PM on its clock-in date** and requires review. Starts **after 6 PM** use the following day's **7:30 AM** cutoff. Once a clock-in correction is approved, the active session's cutoff and payroll duration use the approved actual start. The original punch and all earlier automatic-close evidence remain retained.

## Stable layouts

Live Time Monitoring uses fixed column proportions and a scrollable minimum-width table. Timer ticks update elapsed text in the existing rows instead of rebuilding the entire table. Tabular digits and reserved dimensions prevent a change such as 9.99 → 10.00 from resizing the panel. Genuine employee/lunch changes can still update the content.

Unchanged home cards and weekly history rows are reused as well. Refreshing history does not overwrite a date field while the employee is selecting a week. Approval and automatic-close queues keep a manager's draft explanation during background refresh and preserve existing forms when a refresh fails.

## Dark appearance

Open the sidebar's **Display preferences** and use the **Color theme** control. The header toggle has been removed. The selected appearance restores before the first paint, saves locally, and syncs to the signed-in account when available. A late preference fetch cannot reverse a theme selection just made by the user.

The shared theme covers legacy cards, tables, utility-styled quote panels, lunch areas, status badges, form controls, dialogs and management controls. Header/sidebar navigation keeps its navy styling. Printed records use light backgrounds. Display preferences also work when the sidebar starts collapsed.

## Validation

Checks include 48 core/asset tests, actual PostgreSQL request permissions and RLS, immutable server punches, direct manual-entry denial, pending/approved/rejected/withdrawn requests, approval after clock-out, automatic-close interaction, exact lunches, idempotence, audit rollback and concurrent approval/clock-out. Existing collection, customer registry and missed-clock-out tests continue to run. Browser coverage includes request/withdraw/approve flows, hidden theme controls, saved dark appearance, unchanged row identity and panel dimensions through a timer digit rollover, plus desktop/mobile layouts. Automated fixtures contain synthetic employee/customer data.

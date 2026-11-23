# Personal menus, Team Management, live corrections and quote uploads

## Install

Deploy the current `main` branch. For account menu synchronization and direct administrator live corrections, run the complete contents of [`supabase/GLASSPRO-NAVIGATION-AND-LIVE-CORRECTIONS-INSTALL.sql`](supabase/GLASSPRO-NAVIGATION-AND-LIVE-CORRECTIONS-INSTALL.sql) in the existing project's **Supabase → SQL Editor → New query**. Open the file's **Raw** view in GitHub to copy it, then refresh the portal after the SQL completes.

The combined installer includes the earlier timekeeping/clock-in approval prerequisites, quote import RPC, this update and the existing automatic clock-out schedule. It is additive, rerunnable and atomic, retains histories and processes already-overdue sessions using the existing 12:01 AM / 5 PM and emergency-call rules. It does not import the supplied customer CSV into the public repository or database. Existing portal Auth, employee, timekeeping and quote tables are prerequisites.

If every earlier live-punch approval migration and quote-import RPC is already installed, only `supabase/migrations/2026-11-23-navigation-and-admin-live-corrections.sql` is needed. GitHub deployment does not apply SQL to the live project. The CSV precision fix and Tuesday lunch review controls are frontend changes and do not require additional SQL.

## A simpler sidebar

- **My Home** always remains available.
- **My Tools** contains the employee's permitted workspaces in one group.
- **Management** contains Command Center, MultiplyOS Hub and Team Management for administrators.
- **Team Management** contains People & Access, Work Orders & Commissions, Time & Attendance and Activity History as in-page tabs. Existing `admin.html#adminUsersPane`, `#adminCommissionsPane`, `#adminTimePane` and `#adminFleetPane` links still open their original workflows.

Open **Customize menu** at the bottom of the sidebar:

1. Choose **Show** for tools to keep in the menu. A tool's Open link and navigation search can recover a personally hidden tool.
2. Choose **Favorite** to add a shortcut at the top. **Show favorites only** reduces the regular menu to the favorites and the active tool.
3. Use the up/down buttons to reorder permitted tools within My Tools or Management. Favorites follow the same order.
4. Choose whether to show sidebar section shortcuts, hide individual shortcuts or Team Management tabs, and use compact cards/tables. When sidebar section shortcuts are turned off, each workspace's own section controls remain visible.
5. **Save menu** saves the choices; **Cancel** leaves existing choices in place. **Restore defaults** resets the draft and takes effect when saved.

Each signed-in user has a separate browser cache. After the SQL update, preferences also sync to that user's account. Unsynced local edits remain available if the network or schema is unavailable and are retried at the next authenticated load. A late account response cannot replace a menu just edited in the browser. An administrator does not inherit another user's preferences. Preferences never grant module access.

The current tool/tab remains visible while in use, even when personally hidden, so an employee is not stranded. My Home and Customize menu remain available even if every other tool is hidden. Search can find hidden permitted tools and management workflows. Display preferences still contains the theme switch.

## Correct a live clock-in immediately

Open **Team Management → Time & Attendance → Live Time Monitoring** and choose **Correct clock-in** beside the employee. The portal reads the current active session again before editing it.

Enter the verified actual start date/time and a reason of 10–1000 characters, then choose **Apply correction now**. An administrator's correction takes effect immediately without an employee request. Original server punches, GPS evidence and session identity stay unchanged; the approved start recalculates live elapsed time, later payroll hours and the existing automatic-cutoff policy. Lunch punches stay in place, and the employee remains clocked in.

A conflicting pending employee request is marked as superseded, with its explanation and manager decision retained in request history. The direct correction has its own audit record. All request decisions, time changes and audit writes succeed together or roll back together. An identical retry does not duplicate history.

Future starts, times more than 24 hours from the original punch, starts after the recorded lunch and invalid shifts are rejected. If the employee already clocked out or began a different session, refresh and use the completed timecard's Edit Punch workflow. If an existing timecard matches a stale active clock, recover that record first using Keep timecard & clear active clock.

## Mainstreet Quotes CSV

Mainstreet exports amounts such as `397.7400`. The importer now accepts up to four decimal places and rounds exact decimal values to cents, including negative line-item amounts. Invalid amounts still stop the import and identify the source row and column.

Rows sharing a quote number are grouped as one quote with its line items. Existing quote numbers are skipped; new quote numbers for returning customers are accepted. Existing callback status, receipts and notes remain unchanged. The supplied private example was checked locally. Automated tests contain synthetic examples only.

## Validation

Coverage includes 55 core checks, actual PostgreSQL request permissions and navigation RLS, administrator attribution, superseded-request history, audit rollback, duplicate retries, exact lunches and concurrent direct correction/clock-out. Browser checks cover menu hiding/favorites/order, reload and account separation, cancellation/default recovery, hidden-tool search, active-page recovery, old management links, live correction failures/retries, late preference responses, mobile focus, both themes and four-decimal quote uploads through the file input. The earlier collections/customer/timekeeping regression suites also run.

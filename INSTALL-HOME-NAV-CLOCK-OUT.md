# GLASSPRO home, navigation and administrator clock-out
Release 2026.11.17.1

## What changed
- Home now shares the program's navy header, red accents, card spacing and light/dark appearance.
- Home shows recorded weekly hours, the current shift status, and assigned modules. Failed reads display an unavailable state instead of invented zero totals.
- Employees can choose columns, hide cards, and reorder them with accessible up/down controls. Save persists the layout through the existing UI-preferences RPC.
- Sidebar marks My Home as active, adds workspace/section search, preserves favorites and nested views, and improves mobile keyboard focus and permission visibility.
- Management → Time & Geotags → Live Time Monitoring has a Clock Out action for confirmed active sessions.
- An administrator can use server time or enter the actual end time, with a required 10–500 character audit reason.
- Open lunch must be explicitly ended at clock-out; that entire lunch interval remains unpaid. A shift without lunch stays pending in the existing lunch-review queue.
- Employee and administrator clock-outs now use the same atomic database operation. Timecard creation, audit insertion and active-session removal succeed together or roll back together.
- Repeat requests do not duplicate a shift, and an old request cannot end a newer shift.
- Employee clocks refresh from Supabase every 15 seconds and when the tab becomes visible, clearing stale local punches after an administrator clock-out.

## Install in this order
1. Back up your current website and Supabase database.
2. Schedule a short update window with no active clock-out submissions. All open employee clock pages must be refreshed after the website update; an older page still uses the previous multi-request clock-out flow.
3. In Supabase → SQL Editor → New query, paste the entire contents of **supabase/migrations/2026-11-16-admin-clock-out.sql**, then Run. This file contains SQL only. Confirm success before publishing the website.
4. Publish the website code from this branch through your normal GitHub/Netlify process. The existing account provisioning/archive and accounting integrations are retained.
5. Refresh every open GLASSPRO page with Ctrl+F5. Have employees verify their current shift status.
6. Test with a designated test employee: clock in, then as an administrator open Management → Time & Geotags → Live Time Monitoring → Clock Out. Enter a reason and confirm.
7. Confirm one completed timecard and one TIME_CLOCK_OUT audit entry, with no remaining active session. The employee page should show Off Clock within 15 seconds or on refocusing the tab.

The SQL requires your existing Auth/RLS and November 12 lunch-review setup. It refuses to run over the older compatibility schema with RLS disabled. It adds completion metadata and one database function; it does not drop business tables, remove historical records or weaken policies.

No new Edge Function, service-role credential, or QuickBooks configuration is required.

## Time and lunch rules
- Stored work dates and clock text use America/New_York. The administrator's date/time input explicitly identifies the device timezone.
- A custom end must be after clock-in, in the past, and within 24 hours of the shift start. Stale punches can be closed at their actual historical end; records needing longer shifts require manual timecard review.
- Payroll uses whole recorded minutes; the exact completion and lunch timestamps are retained.
- A partially saved shift from an older client is flagged for review rather than inserted again.
- Existing lunch-validation triggers remain in force. If their wall-clock rules disagree with elapsed time during a daylight-saving transition, the operation rejects and preserves the active shift for manual review.

## Validation
The included GitHub Actions workflow checks JavaScript syntax, local assets, strict module permissions, layout persistence, desktop/mobile layout, dark mode, remote employee clock clearing, and the administrator dialog.

Its disposable PostgreSQL database tests authorization, inactive administrators, invalid times, no-lunch review, exact lunch deduction, explicit lunch closing, idempotent retries, stale requests, rollback after audit failure, metadata protection, and a concurrent employee/administrator clock-out.

The PostgreSQL fixture is restricted to a database named gp_clock_test. **Never run tests/clock-out.sql against your Supabase project.** The production migration is the separate file under supabase/migrations.

## Rollback
The migration is additive and can remain installed if the website is rolled back. Prefer keeping the new atomic employee clock-out code while reverting only appearance changes. Reverting all clock code restores the older non-atomic submission path; do so only during a maintenance window with administrators no longer using the new action.


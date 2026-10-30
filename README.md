[README.md](https://github.com/user-attachments/files/34202396/README.md)
# GLASSPRO Portal — reviewed edition

This ZIP contains the five original HTML modules, their existing styling and data, plus a small shared `portal-utils.js` helper, tests, and a review report. It is a **client-side prototype**, **not a production-secure employee/customer portal**.

## Pages

- `index.html`: demo PIN login, shift entry, live time clock, hours summary
- `quotes.html`: quote board, follow-up workflow, competitor registry, CSV import
- `commissions.html`: work-order logs
- `fleet.html`: inspections and vehicle assignment
- `admin.html`: administrative reports and configuration

## Preview

Unzip without separating files and run `python -m http.server 8000` from the extracted folder. Open `http://localhost:8000/index.html`. The HTML also has inline styles/scripts but references online CDNs for several UI/data libraries, so an internet connection may be needed for full functionality.

Original browser storage records are not modified by unzipping this ZIP. Before replacing a deployed site, **back up your databases and browser records**. These files do not include a database schema, a Supabase project export, server code, or RLS policies.

## Critical security requirements before production

1. **Replace demo PIN login** and all localStorage-managed user/role permissions with server-authenticated identities (e.g., Supabase Auth with unique users, MFA where appropriate, secure session management and recovery). The four-digit PINs and user permissions in JavaScript are public and forgeable.
2. **Audit Supabase row-level security on every table** (`app_users`, `time_logs`, `commission_logs`, `vehicle_inspections`, `fleet_vehicles`, `outstanding_quotes`, `audit_logs`) with rules keyed to the authenticated user and enforced server-side. Never rely on client UI checks or publish a service-role secret. The existing key is a *publishable* key, not proof of access controls.
3. **Remove real client and employee sample data from public HTML** and import it only behind a secure backend. `quotes.html` contains records in its initial fixture. Anyone who can fetch the public HTML can read those records, even without logging in.
4. **Avoid sensitive personal data in localStorage**, including PINs, location history and customer details. Browser storage is accessible to scripts running in the origin and should not be a confidential source of truth.
5. Establish an **authoritative server-side workflow** for timecards, payroll, commission approvals, audit logs, and employee roles. Offline local-only records currently require reconciliation, and client time/role data can be edited by end users.
6. Validate business rules (overtime period, break handling, employee identity, rates and approvals) with the business owner before using data for pay decisions.

**Do not publicly deploy this prototype with real business/customer data until these controls are implemented and audited.**

## Behavior changes in this edition

- Current-week hours and overtime warnings use **Monday–Sunday, local timezone** instead of adding every historical shift. Payroll summaries in the time clock and the relevant admin watchlist, payroll table, and employee modal now use the current week. Other historical dashboards can still show all-time values.
- The time clock's date fields use local dates, not UTC ISO dates (avoids midnight timezone shifts); the clock-out record uses the clock-in work date.
- Invalid manual shift dates/durations, duplicate work orders, and invalid vehicle mileage have additional validation.
- Manual shifts, work orders and vehicle inspection records are preserved locally even when Supabase returns an error. The UI distinguishes 'saved locally only' from 'saved to cloud and locally'. Cloud read refresh no longer silently overwrites these unsynced local records; **there is not yet a reliable automatic retry/synchronization queue**.
- HTML escaping protects a variety of imported/user-entered strings in main tables, print views, admin tables and quote cards; a regression test checks representative malicious-looking content. This is not a comprehensive penetration test.
- CSV exports guard against spreadsheet formula injection and escape quotes; temporary download URLs are revoked.
- The visible role checks hide the quote admin tab and redirect non-admin users from the admin page. **These are UX checks only**; enforce security on the backend.
- The Supabase label now states 'configured (not verified)' when the library loads. It never certifies connectivity or RLS.
- The quote follow-up target date uses three calendar days from today instead of a hardcoded 2026 date; CSR stamps no longer print PIN codes.

## Tests

- `node tests/helpers.test.cjs` (six deterministic utility checks)
- `python tests/browser_smoke.py` (offline simulated-browser rendering/injection and permissions, requires `playwright` and `beautifulsoup4` and Chromium)
- `python tests/form_smoke.py` (offline browser form submission for time, commissions and fleet)

The browser tests deliberately mock online CDNs and Supabase; they **do not** exercise actual cloud access, CSV import through a live PapaParse CDN, geolocation, or production network permissions.

See `REVIEW.md` for findings and remaining work.

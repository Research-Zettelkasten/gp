# GLASSPRO team portal

Current release: **2026.11.23.6 — fleet records, callback tools and announcements**.

Apply [the fleet, callbacks and announcements migration](supabase/migrations/2026-11-23-fleet-callbacks-announcements.sql) in the GLASSPRO Supabase SQL Editor. It expects the existing fleet, quote and employee tables and Supabase Storage. This update has no Cron setup step.

- **Fleet → Fleet Garage**: choose Vehicle or Trailer, add the tag expiration and last renewal date, and filter the directory by renewal status. Open **Photos** on a saved unit to attach JPEG, PNG, or WebP images. Fleet viewers can open photos. Administrators can upload and remove them. Trailers remain separate from the motor-vehicle inspection checklist.
- **Safety** has its own navigation entry and keeps the existing Safety permission. Fleet continues to use the vehicle-view and submit permissions.
- **Quote Call-Backs** uses rule-based priority and filters for due dates, quote dates, minimum amount and phone availability. In a quote, Call, Text and Email open drafts on the user's device. Staff select the contact method when recording the receipt. Use **Manager close or escalation** to send the quote and notes into Admin Review. A manager can requeue, close or convert it to Won.
- **Management → Command Center → Team announcements** lets administrators publish, pin, edit, expire and archive notices for signed-in staff Home pages.
- Background database polling uses a one-minute fallback on visible pages. Saves and supported Realtime updates refresh immediately. Live clock displays continue to update locally between server reads.


The timekeeping feature installers no longer install extensions, modify Cron permissions/jobs, or sweep overdue sessions. If a previous install failed in Supabase Cron setup, rerun the current complete feature installer in a new SQL query. Existing scheduled jobs remain in place; new scheduling is configured separately through Supabase Integrations → Cron and `supabase/ENABLE-AUTO-CLOCK-OUT-CRON.sql`.

See [personal navigation, live corrections and quote uploads](NAVIGATION-LIVE-CORRECTIONS-AND-QUOTE-UPLOADS.md) for the combined SQL installer, personalized sidebar controls, consolidated Team Management tabs, immediate administrator clock-in correction and four-decimal CSV support.

Lunch Exception Review now has independent Monday–Sunday week navigation. The current review week stays on the prior week throughout Monday for weekend follow-up and advances at midnight Eastern on Tuesday. Use Previous/Next week, Jump to a date, or All outstanding to review older pending and rejected items. Rollover never resolves or deletes exceptions. See [lunch review weeks](LUNCH-REVIEW-WEEKS.md). This release requires no new SQL.

See [live punch approval and appearance setup](INSTALL-LIVE-PUNCH-APPROVALS-AND-THEME.md) for installation, employee requests, administrator review and Display preferences.

See [weekly time and missed clock-out setup](INSTALL-WEEKLY-TIME-AND-AUTO-CLOCK-OUT.md) for the SQL installer, 12:01 AM / 5 PM policy, emergency-call exception, saved-timecard recovery and manager review queue.

See [installation and usage](INSTALL-CUSTOMERS-AND-AUTO-COLLECTIONS.md) for the combined SQL install, private customer-directory import, note permissions, identity review and payment-verification behavior.

The static portal uses Supabase Auth, role-controlled database functions and row-level security. Customer records stay in the protected database; the public repository and automated tests do not contain the supplied customer directory.

## Workspaces

- My Home: customizable module cards, shared navigation and light/dark themes.
- Customers: contact directory, linked quotes and invoices, scoped notes, source history and identity review.
- Collections: Mainstreet/QBO/GlassQuest reports, detailed filtering, notes and audited invoice reconciliation.
- Quote Call-Backs: quote import, follow-up conversations and active-board refresh.
- Time Clock, Commission & WOs, Vehicle Check & Safety, and Management retain their assigned-role workflows.

Install SQL before deploying the website. The update does not apply migrations to the live project automatically. Existing portal Auth and Collections tables are prerequisites.

## Earlier setup guides

- [Collections and Quote Call-Backs](INSTALL-COLLECTIONS-AND-QUOTES.md)
- [Home, navigation and administrator clock-out](INSTALL-HOME-NAV-CLOCK-OUT.md)
- [Original prototype review](REVIEW.md), retained as historical findings rather than current release instructions.

## Checks

Run `node --test tests/portal-core.test.cjs tests/collections-core.test.cjs tests/customers-core.test.cjs tests/time-week.test.cjs`. GitHub Actions additionally runs PostgreSQL permission/transaction tests, clock-out concurrency regressions and browser workflows with synthetic data. Preview screenshots cover desktop/mobile and both themes.

# GLASSPRO team portal

Current release: **2026.11.23.7 — team announcement push and the GLASSPRO app icon**.

[Set up Web Push](WEB-PUSH-SETUP.md) for opt-in device alerts. The static site supplies the Home Screen icon and one app manifest across GLASSPRO.

**Live Time Monitoring** supports one-time location requests during a shift. The employee chooses to share or decline, and managers see the shared pin with the reported accuracy. GLASSPRO targets a radius of 50 feet when capturing a location. The [setup guide](WEB-PUSH-SETUP.md#request-a-location) links the SQL update and explains how to enable alerts for requests.

Apply [the fleet, callbacks and announcements migration](supabase/migrations/2026-11-23-fleet-callbacks-announcements.sql) in the GLASSPRO Supabase SQL Editor. It expects the existing fleet, quote and employee tables and Supabase Storage. This update has no Cron setup step.

- **Fleet → Fleet Garage**: choose Vehicle or Trailer, add the tag expiration and last renewal date, and filter the directory by renewal status. Open **Photos** on a saved unit to attach JPEG, PNG, or WebP images. Fleet viewers can open photos. Administrators can upload and remove them. Trailers remain separate from the motor-vehicle inspection checklist.
- **Safety** has its own navigation entry and keeps the existing Safety permission. Fleet continues to use the vehicle-view and submit permissions.
- **Quote Call-Backs** uses rule-based priority and filters for due dates, quote dates, minimum amount and phone availability. In a quote, Call, Text and Email open drafts on the user's device. Staff select the contact method when recording the receipt. Use **Manager close or escalation** to send the quote and notes into Admin Review. A manager can requeue, close or convert it to Won.
- **Management → Command Center → Team announcements** lets administrators publish, pin, edit, expire and archive notices for signed-in staff Home pages.
- Background database polling uses a one-minute fallback on visible pages. Saves and supported Realtime updates refresh immediately. Live clock displays continue to update locally between server reads.


The timekeeping feature installers no longer install extensions, modify Cron permissions/jobs, or sweep overdue sessions. If a previous install failed in Supabase Cron setup, rerun the current complete feature installer in a new SQL query. Existing scheduled jobs remain in place; new scheduling is configured separately through Supabase Integrations → Cron and `supabase/ENABLE-AUTO-CLOCK-OUT-CRON.sql`.

See [personal navigation, live corrections and quote uploads](NAVIGATION-LIVE-CORRECTIONS-AND-QUOTE-UPLOADS.md) for the combined SQL installer, personalized sidebar controls, consolidated Team Management tabs, immediate administrator clock-in correction and four-decimal CSV support.

Administrators can use **Team Management → Time & Attendance → Live Time Monitoring → Correct Lunch** to enter or fix Lunch Out and Lunch Back, record an ongoing break, or clear a mistaken lunch. The active shift and the audit record save together. Run the [live lunch correction SQL](supabase/migrations/2026-11-23-admin-live-lunch-correction.sql) in Supabase after the Live Punch Approvals update. For a completed shift, use **Edit Punch** in **Shift History & Geotags**.

Employees can expand **Request a lunch correction** below the clock-in correction on **Time Clock**, select the live shift or one of their saved shifts, and send the actual Lunch Out and Lunch Back times with a reason. Managers review these under **Team Management → Time & Attendance → Lunch Correction Requests**. Approval recalculates paid time. Employees can reopen the section to check the decision and review note. The [employee lunch request SQL](supabase/migrations/2026-11-23-employee-lunch-requests.sql) applies after the administrator live lunch update.

Lunch Exception Review now has independent Monday–Sunday week navigation. The current review week stays on the prior week throughout Monday for weekend follow-up and advances at midnight Eastern on Tuesday. Use Previous/Next week, Jump to a date, or All outstanding to review older pending and rejected items. Rollover never resolves or deletes exceptions. See [lunch review weeks](LUNCH-REVIEW-WEEKS.md). The Tuesday rollover needs no separate SQL.

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

## Pilot tools and workspace permissions

In **Management → People & Access → Workspace permissions**, set each feature to hidden, administrators only, administrators and selected staff, or everyone with the existing parent workspace permission. Use **Employee override** to grant pilot access or block one account. An override requires the parent workspace permission. Changes appear in the Audit Trail. All four features start hidden.

| Feature | Where to find it | Pilot workflow |
| --- | --- | --- |
| Photo-to-quote | Quote Call-Backs, including an open callback | Upload a JPG, PNG or WebP, mark areas on the photo, add observations, and select the next step. Link the intake by quote or work order number. Staff with intake access can open linked photos from Work Orders. |
| Customer quote link | Inside a quote callback | Enter up to three customer-facing options and totals, choose an expiration, then copy or share the link. Reopen the tool to see approvals, questions, and photos. Reply there or revoke the link. A customer approval records a response for staff to process through the existing callback workflow. |
| Dispatch map | Work Orders & Commissions | Select a date and add installs, service calls, pickups or emergencies. Enter a crew and time window, verify and pin the site, and save. The board checks overlapping crew assignments. Availability reflects the stops recorded for that day. |
| Past-job search | Work Orders & Commissions, Quote Call-Backs and Customers | Search for a job type, material, quote or work order. Customer profiles can limit the search to linked records. Results respect the existing visibility of source records. |

### Installation and verification

1. Apply [the workspace feature migration](supabase/migrations/20261125152759_workspace_features.sql) to a staging Supabase project with the Quotes, Work Orders, and Customer Registry schema installed. For this repository’s hosted projects, the file can also be run as one script in the Supabase SQL Editor.
2. Deploy the branch to an HTTPS preview site backed by staging. As an admin, verify the release buttons begin hidden and that the original Quotes and Work Orders screens are available. Enable one feature in pilot mode and add a single test user with its parent workspace access.
3. For customer links, publish a synthetic quote and open it on a separate phone or in a private window. Submit a question, approve an option and upload a photo. Verify these in the originating quote callback, then revoke the link. Switching the feature off also pauses all unexpired links. Turning it on again restores access to eligible unexpired, unrevoked links.
4. For dispatch, schedule a synthetic crew and try an overlapping stop. Verify that the overlap is blocked. Verify pin placement before saving. The map starts in Valdosta and uses OpenStreetMap tiles. The schedule uses Eastern Time, manual pins and scheduled crew stops. Directions open the selected pin in Google Maps.
5. Once staging is verified, repeat the migration on production and deploy the site. A newly applied migration still leaves all four features hidden.

The anonymous quote page uses an unguessable link as the customer's access credential. Send it directly to the intended recipient. Only published option details appear there. Photos are stored in private buckets. Authorized staff request short-lived photo URLs.

### Optional AI photo drafting

The checklist works immediately with the intake title and staff-entered markers. To enable image-based suggestions, deploy the `gp-photo-draft` Supabase Edge Function and set these secrets in the staging project first.

- `GP_PHOTO_DRAFT_ENABLED=true`
- `GP_PHOTO_DRAFT_ORIGINS` with the exact HTTPS site origins, comma-separated
- `OPENAI_API_KEY` from the OpenAI project that should be billed for drafting

The user confirms before sending a photo. The function checks the caller’s existing intake access and limits use to ten requests per employee per Eastern calendar day. It sends the resized photo and a fixed prompt. Staff review draft observations and questions before saving. The request uses the Responses API with response storage disabled. [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision)

### Checks

`tests/workspace-features.sql` uses a fresh PostgreSQL fixture and covers release permissions, the original source limits, link lifecycle, upload limits and dispatch conflicts. `tests/workspace-features-browser.cjs` exercises the portal and customer page in Chromium with synthetic data. Production records and registered customer links are outside the test fixture.

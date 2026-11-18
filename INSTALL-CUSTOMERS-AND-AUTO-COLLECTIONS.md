# Customer registry and automatic Collections reconciliation

## Install the update

This update extends the existing GLASSPRO Supabase project. It does not create a new Auth project or replace existing records.

1. Open **Supabase → SQL Editor → New query**.
2. Open [`supabase/GLASSPRO-CUSTOMERS-AND-COLLECTIONS-INSTALL.sql`](supabase/GLASSPRO-CUSTOMERS-AND-COLLECTIONS-INSTALL.sql) in GitHub, select **Raw**, copy its complete contents, and run it in SQL Editor. The file contains SQL only. It includes the two earlier Collections/Quotes prerequisites and both new migrations, in order. They are additive and rerunnable against the existing portal schema.
3. Deploy the updated website from `main`, then refresh the browser. Existing role assignments remain in effect.
4. Sign in as an active administrator. Open **Customers → Import customer directory & review source matching**. Select the privately supplied `GLASSPRO-Customer-Registry-Import.csv`, review the preview, then save it. The actual customer CSV is deliberately separate from the public source repository.
5. Open **Needs review** to check scanned identity/contact fields. Use the PDF filename, file page, printed page and original excerpt on each profile to verify it. Save an explanation when confirming or changing a profile.
6. Upload normal reports in **Collections**, and quote CSVs in **Quote Call-Backs**. Customer links update as reports finish. Use **Refresh source links** after verifying customer identities or adding aliases.
7. For existing QBO verification uploads, choose **Collections → Reconcile verified balances**. New eligible uploads reconcile automatically when their import completes.

The code update does not itself run SQL against the live Supabase database or import private customer records. Until the SQL is installed, the new page shows setup guidance. The original portal Auth/Collections migrations must already be present; see the earlier installation guides if installing on a fresh project.

The combined install contains these exact files:

| Order | Migration |
| --- | --- |
| 1 | `supabase/migrations/2026-11-18-collections-intelligence.sql` |
| 2 | `supabase/migrations/2026-11-18-quote-callback-import.sql` |
| 3 | `supabase/migrations/2026-11-18-customer-registry.sql` |
| 4 | `supabase/migrations/2026-11-18-automatic-collections.sql` |

## Customer workspace

The directory combines customer numbers and contact details with linked quotes, collection invoices and a searchable history. Search names, customer numbers, phones, email and location; combine review, category and activity filters. Exports use the current filters.

Each customer has three views:

- **Timeline & notes:** customer notes, original collection actions and account notes, quote conversation snapshots, linked work-order notes and optional report snapshots. Notes retain authors, timestamps, source references and structured details. Search payment references or other text, filter the source, and export the visible history.
- **Quotes & invoices:** current linked records with direct links to the original workflow, invoice balances by source, follow-up dates and verified-clearance history.
- **Profile & matching:** contact information, original PDF provenance, alternate report names confirmed by an administrator, and explicit links for records whose identity cannot be determined automatically. Every profile edit and identity decision requires a reason and produces an attributed audit entry.

Unique exact normalized names link automatically. Punctuation and case differences normalize; legal suffixes remain significant. Similar names are not fuzzy-merged. If two directory records have the same normalized name or a scanned identity needs review, automatic matching pauses. Confirm an alternate name with an **alias**, or link a specific record after checking its exact reference. An alternate customer name alone never matches all invoice numbers: cross-name accounting evidence also requires the same invoice number, date and an explicit identity decision.

Work orders generated as `Q-<quote number>` link through their quote. Other work orders can be linked explicitly using their database record ID. Linking a job exposes no employee compensation fields in the customer timeline. Existing job visibility still applies.

Current quote conversations and work-order notes are captured during migration, with later changes retained as new snapshots. Information already overwritten before this update cannot be reconstructed. Original collection notes and actions remain in their original tables and appear in the unified view.

## Access and notes

Active administrators and staff assigned either Collections or Quote Call-Backs can open Customers. Only administrators import the directory, change master contact details, confirm aliases or make manual identity links. Customer notes are append-only through the protected database function.

| Note or source | Who can read it |
| --- | --- |
| Shared customer notes and basic directory | Staff with Customers access |
| Collections notes, invoice actions and report balances | Collections staff and administrators |
| Quote conversations | Quote Call-Backs staff and administrators |
| Administrator customer notes and identity/profile audit | Administrators |
| Work-order history | Administrators, or the owning employee with Commission access |

The unified views preserve the source tables' row-level security. Customers access does not grant another module's private records. No customer directory is embedded in HTML, JavaScript, test fixtures or browser storage.

## When accounts leave active Collections

Clearance occurs **per invoice**, not per customer. A customer with another unpaid invoice remains in Collections. Archival removes the settled invoice from normal active work while keeping its notes, source evidence, original GlassQuest balance and audit history searchable.

| New QBO evidence | Result |
| --- | --- |
| Matched invoice with an explicit zero remaining balance in a dated verification report | Automatically archive when identity, date, amounts and pending-correction checks agree |
| Partially paid invoice with a positive remaining balance | Keep active for the remaining balance |
| Payment, deposit, credit memo or journal entry by itself | Retain as context; do not clear an invoice |
| Invoice missing from an open-invoice report | Flag for verification; keep active |
| Zero with a disputed invoice, uncertain identity, different invoice date or original-amount mismatch | Retain for collector review and show the reason |
| Newer Mainstreet evidence still showing a positive balance | Retain for research |
| Manually reopened case after the verification export | Keep open until newer qualifying evidence arrives |
| Newer matched QBO invoice with a positive balance after verified archival | Automatically reopen and append an audit entry |

Automatic archival runs when an active administrator completes an eligible QBO verification import. It also works on retained imports via **Reconcile verified balances**. Repeating reconciliation does not duplicate a clearance. Each run records counts and up to 200 review reasons; the queue links back to cases needing attention. No payments are posted and no accounting entries are changed in QBO or Mainstreet.

A zero balance verifies no remaining receivable; it may result from payment, credit or write-off. It does not establish which of those occurred. Record the actual explanation and payment reference in a customer or invoice note when known.

## QBO report to upload

Keep using **Collections Report** to refresh open balances. To verify invoices that have disappeared from that report, export **Invoice List** with the relevant full date range and **both paid and unpaid** invoices. Include customer/name, invoice number, invoice date, transaction type, original amount, **Open Balance**, and **A/R Paid** where offered. A blank balance is rejected, never interpreted as zero. Confirm that the import preview identifies the file as **invoice verification** and shows actual zero-balance invoice rows.

**Invoices and Received Payments** can help investigate which payment applies to an invoice. Its payment rows alone are insufficient. Only an invoice row with an explicit remaining balance is usable verification evidence.

Use the export's actual as-of date. An older report uploaded today remains older evidence. Mark coverage Complete only when the export includes the full intended account population. Report names, columns and customization controls can vary by QuickBooks edition; the preview is the final check that required data is present.

Intuit references: [report availability](https://quickbooks.intuit.com/learn-support/en-us/help-article/purchase-orders/reports-included-quickbooks-online-subscription/L0s4KrGgr_US_en_US), [report customization](https://quickbooks.intuit.com/learn-support/en-us/help-article/customize-reports/create-custom-reports-quickbooks-online-advanced/L1LHo5Ti2_US_en_US), and [invoice transaction statuses and exports](https://quickbooks.intuit.com/learn-support/en-us/help-article/journal-posting/view-sales-transactions/L2Do6c0jS_US_en_US).

## Scanned legacy directory

The supplied July 10, 2026 report contains 137 supplied pages out of 141 printed pages. The prepared CSV contains **1,364 named entries**, including **49 rows flagged for contact or identity review**; **40 require identity review**. Five unnamed source rows were excluded because no customer identity could be established. Printed pages **12, 81, 112 and 113** were absent from the supplied PDFs. These gaps are not filled with invented records.

Leading zero customer numbers and multiline addresses are preserved as text. Each entry retains the original filename, file page, printed page, row, OCR confidence and source excerpt. Scanning confidence is a review aid, not a guarantee of accuracy. The directory is historical contact information, not current payment evidence. Reimports cannot overwrite administrator-verified profile fields. Identical files are rejected; stable import keys prevent a repeat upload from creating another copy of the same directory row.

## Validation

The update has 40 core/asset checks plus PostgreSQL integration and browser workflows in GitHub Actions. Coverage includes rerunnable migrations, role and note visibility, append-only histories, manual identity decisions, preserved verified contacts, zero-balance archival, disputed/date/amount/identity safeguards, manual reopening, newer positive-balance reopening, duplicate import protection, desktop/mobile layouts, filters, note saves, profile edits, aliases and directory upload. All automated customer fixtures are synthetic. Live Supabase installation and the private directory import remain the administrator's setup steps.

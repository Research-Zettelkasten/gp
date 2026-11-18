# Collections and Quote Call-Backs update

## Install on the existing GLASSPRO project

1. In Supabase → SQL Editor → New query, paste and run **only the SQL** from `supabase/migrations/2026-11-18-collections-intelligence.sql`.
2. In a second query, run `supabase/migrations/2026-11-18-quote-callback-import.sql`.
3. Deploy the updated website files from this PR. Both migrations are additive and rerunnable. The original Collections/Auth tables must already exist. No QBO OAuth changes are required.
4. Sign in as an administrator. Refresh the browser. CSV uploads are now in their respective workspaces: **Collections → Import center** and **Quote Call-Backs → active board → Upload Mainstreet Quotes CSV**. The Management header upload was removed.

The migrations have not been run against your live Supabase project by this code update. JavaScript files belong in the website; never paste JavaScript into SQL Editor.

## Choose and review reports

| Source | Supported input | Purpose |
| --- | --- | --- |
| Mainstreet | AR Aging CSV or one-sheet XLSX; Customer, Inv #, Type, Date, Amt, Balance | Open invoices, contact information, imported collection notes and aging |
| QBO | Collections Report CSV or XLSX, including customer headings, Date, Transaction type, Num, Amount, Open balance | Current open invoice evidence; payments, credits, deposits and journal entries remain separate |
| QBO verification | **Invoice List**, all relevant dates, paid and unpaid, with **Name / Customer, Date, Num, Transaction type, Amount, Open Balance, A/R Paid** | Explicit remaining invoice balances; zero balance supports documented clearance |
| QBO account summary | A/R Aging Summary | Customer totals only; never proof that a particular invoice is paid |
| GlassQuest | Retired receivables CSV or XLSX, one baseline only | Gradually work down historical invoices without repeated uploads |

In QBO, use Reports → search **Invoice List** → choose all relevant dates and both paid/unpaid invoices → customize columns to include Open Balance and A/R Paid → export. **Invoices and Received Payments** is also useful to investigate which payment was applied to an invoice. Its invoice rows can be imported when they contain the same explicit customer, invoice, transaction type, date and Open Balance fields; payment rows alone do not prove an invoice is settled.

After selecting a file, check the preview. Enter its **actual as-of date**, including for reports that do not contain one. Do not enter today's date for an old export. Mark coverage **Complete** only when all customers and all open invoices are included. Partial or unknown-scope reports do not generate missing-in-QBO assumptions. The app detects the report purpose from its headings/title.

The supplied replacement QBO sample is a Collections Report with 532 invoice rows and 216 other transactions. It is the QBO layout used for this update. The original summary sample is supported as customer context, not invoice evidence. The supplied Mainstreet workbook contains 151 invoices and 67 other transactions. GlassQuest contains 289 invoice rows plus payments, credit invoices and applied-credit entries. These samples were examined privately; no real customer data is bundled with the code or automated tests.

## What the intelligence does

- Chooses current evidence by report as-of date, then completion time. An old file uploaded later cannot replace a newer report's balances. Older imports remain retained history.
- Detects identical files and prevents another finalized copy. Exact repeated invoice rows within one file count once. Conflicting rows for the same customer/invoice block the import rather than adding balances together.
- Rejects invalid dates, missing invoice numbers, malformed amounts and blank invoice balances. Blank does not mean zero. QBO trailing-minus amounts such as `199.19-` remain credits.
- Matches named invoices by normalized customer **and** invoice number. Different customer names and similar invoice numbers are not automatically merged.
- Flags an invoice missing from a newer complete QBO open-invoice report as **Missing from QBO · verify**. It might be paid, credited, excluded, or never migrated. It remains in review until verified.
- Recognizes an explicit zero balance in the newest matched QBO verification invoice row. Newer positive invoice evidence defeats an older zero. Newer Mainstreet positive balances require research first.
- Allows a collector to **Archive verified settlement** with a required explanation. The database rechecks the newest evidence and pending accounting corrections; the archive and attributed audit entry commit together. A zero balance may be payment, credit, or write-off, so document the actual reason.
- Retains archived cases, notes, historical evidence, assignments and original GlassQuest values. If a newer QBO report shows a positive balance after verified clearance, **Balance reappeared** returns the item to the attention queue for review/reopening.
- Never posts payments or changes either accounting system. Import staging is atomic: incomplete uploads cannot update the queue. Only administrators can upload or match GlassQuest customers; Collections permission is required to work or clear cases.

## Clear the retired GlassQuest list

Upload the final historical export once. Its baseline locks after completion. The sample `Report.xlsx` has no headings or customer names: columns A–D are invoice number, Excel date, transaction type and original amount; **E+F+G+H is the remaining balance**, including partially paid invoices. The preview states this interpretation explicitly. Unnamed invoices enter **Match customer** and cannot be cleared as verified until linked.

1. Filter Source → **GlassQuest backlog** and Evidence → **GlassQuest · match customer**.
2. Open an invoice. Verify its customer in the original system or invoice documents. Select an existing customer invoice or enter the verified customer name and explain how identity was checked. Invoice-number suggestions are never accepted automatically.
3. Upload the QBO Invoice List verification report. Filter Evidence → **Verified zero · ready to clear**.
4. Review the evidence, add the payment/credit/write-off explanation and archive the verified item. The GlassQuest wind-down panel shows the original positive baseline count, remaining count, unmatched count and archived progress. Original linked records and notes stay in the registry.

If a record requires a manual accounting decision rather than zero-balance verification, the existing **Record a collections action** workflow remains available. Document the facts and outstanding source-system corrections. Do not treat a customer-level payment, negative credit or missing invoice as automatic clearance.

## Filters and notes

The queue supports customer/invoice/phone/source-note search, source (including GlassQuest), work status, evidence state, priority, invoice age, follow-up due/unset, assigned-to-me/unassigned, balance range and sorting. Export uses the current filtered queue and includes separate source amounts and evidence dates.

**Notes registry** combines append-only invoice actions and customer-wide notes. Filter by text or payment reference, customer, category/action, record type, author and Eastern-time date range. Verification/matching decisions have their own record-type filter. Open the original invoice from a note or export all matching entries and structured references to CSV. Existing source-imported Mainstreet notes remain in invoice evidence; add collector decisions through the audited invoice or customer-wide note forms.

## Quote Call-Backs repair

The old importer rejected every returning customer name, even with a new quote number. New quote numbers for returning customers are now accepted. Existing quote numbers are skipped in the database transaction, preserving callback status, receipt details and notes even if two administrators import concurrently. Mainstreet part rows group under one quote.

Quote reads paginate through all permitted records and show refresh success/failure in the board. The board refreshes on visibility changes and every minute while visible, so it does not depend solely on a Realtime publication being configured. A failed refresh retains the last successfully loaded records and shows an error. CSV uploads recheck current server records before saving, then read the saved records back. No test-data upload controls are included in the production UI.

## Validation

Automated checks include source/date selection, duplicate handling, partial coverage, zero-balance evidence, balance reappearance, GlassQuest and advanced filters, quote grouping and returning customers. PostgreSQL integration covers permissions (including inactive administrators), atomic finalization, one-time baseline, audited identity linking, verified archival and existing note/receipt preservation. Browser checks exercise compressed XLSX imports, preview/save, filters, registry search, archival, desktop/mobile layouts, quote upload, failed refresh recovery and new quote loading. Browser/accounting tests use synthetic fixtures, not the attached customer records.

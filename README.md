# GLASSPRO team portal

Current release: **2026.11.18.2 — customer registry and automatic Collections reconciliation**.

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

Run `node --test tests/portal-core.test.cjs tests/collections-core.test.cjs tests/customers-core.test.cjs`. GitHub Actions additionally runs PostgreSQL permission/transaction tests, clock-out concurrency regressions and browser workflows with synthetic data. Preview screenshots cover desktop/mobile and both themes.

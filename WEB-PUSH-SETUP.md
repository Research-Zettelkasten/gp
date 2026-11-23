# Activate Web Push in GLASSPRO

GLASSPRO can send a lock screen alert when Management publishes a team announcement. Staff opt in on each device. The alert opens the announcement in GLASSPRO after sign-in.

## Supabase setup

1. Open the GLASSPRO project's **SQL Editor**. If the announcement updates are still pending, apply [fleet, callbacks and announcements](supabase/migrations/2026-11-23-fleet-callbacks-announcements.sql) first. Apply [the Web Push migration](supabase/migrations/2026-11-23-announcement-web-push.sql) in its own query.
2. In a terminal on a computer with Node.js, generate the Web Push keys once.

   ```sh
   npx --yes web-push@3.6.7 generate-vapid-keys --json
   ```

3. In **Supabase → Edge Functions → Secrets**, add these three values. Keep the private key in Supabase secrets and save a backup in your password manager.

   | Name | Value |
   | --- | --- |
   | `GP_PUSH_PUBLIC_KEY` | The generated `publicKey` |
   | `GP_PUSH_PRIVATE_KEY` | The generated `privateKey` |
   | `GP_PUSH_SUBJECT` | An address you monitor in `mailto:someone@your-company.example` form |

4. From the GLASSPRO repository directory, log in to the Supabase CLI and deploy the sender. Replace `YOUR_PROJECT_REF` with the reference shown in your Supabase project settings.

   ```sh
   npx supabase login
   npx supabase functions deploy gp-announcement-push --project-ref YOUR_PROJECT_REF --no-verify-jwt
   ```

   The handler checks the signed-in user's access token against Supabase Auth and verifies administrator status in the database before claiming any deliveries. Use the same key pair for future deployments so enrolled devices keep receiving alerts.

## Enable and send

1. On iPhone or iPad, open the site in Safari and choose **Share → Add to Home Screen**. If offered, turn on **Open as Web App**. To refresh a cached icon, remove the old Home Screen shortcut and add it again.
2. Launch GLASSPRO from the new Home Screen icon, sign in, and open **Home → Team announcements**.
3. Tap **Enable notifications**, then **Allow**. The same control supports opt-out.
4. In **Management → Command Center → Team announcements**, publish with **Notify opted-in devices** checked, or use **Notify devices** on an already published announcement. For a delivery check, send an announcement after opting in, then look for the GLASSPRO alert on your device.
5. Management shows how many push services accepted the alert. Retry pending items with **Notify devices** after five minutes. The queue skips completed deliveries. Staff can open any current notice directly in GLASSPRO.

The app icon and manifest are static so Apple can fetch them as soon as you choose **Add to Home Screen**. The sender uses the existing Supabase project and can send even when the recipient's browser tab is closed.

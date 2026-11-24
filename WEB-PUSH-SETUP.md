# Activate Web Push in GLASSPRO

GLASSPRO can send a lock screen alert for a team announcement or an on-shift location request. Staff opt in on each device and open GLASSPRO to read the announcement or respond to the request.

## Supabase setup

1. Open the GLASSPRO project's **SQL Editor**. If the announcement updates are still pending, apply [fleet, callbacks and announcements](supabase/migrations/2026-11-23-fleet-callbacks-announcements.sql) first. Apply [the Web Push migration](supabase/migrations/2026-11-23-announcement-web-push.sql) in its own query, then run the [live location requests migration](supabase/migrations/2026-11-23-live-location-requests.sql) in a new query.
2. For automatic setup, apply [the Vault signing key migration](supabase/migrations/2026-11-24-web-push-vault-keys.sql). The sender generates a keypair if needed and saves it in Supabase Vault. If this project already uses Edge Function signing key secrets, keep the existing pair. To provision keys manually on a new project, generate them once.

   ```sh
   npx --yes web-push@3.6.7 generate-vapid-keys --json
   ```

3. For manual setup only, add these values in **Supabase → Edge Functions → Secrets**. Keep the private key in Supabase secrets and save a backup in your password manager.

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
2. Launch GLASSPRO from the new Home Screen icon and sign in. Open **Home → Team announcements** or **Time Clock → Device notifications**.
3. On Time Clock, Device notifications opens for devices that need to opt in. Tap **Enable notifications**, then **Allow** in the system prompt. The same control supports opt-out.
4. In **Management → Command Center → Team announcements**, publish with **Notify opted-in devices** checked, or use **Notify devices** on an already published announcement. For a delivery check, send an announcement after opting in, then look for the GLASSPRO alert on your device.
5. Management shows how many push services accepted the alert. Retry pending items with **Notify devices** after five minutes. The queue skips completed deliveries. Staff can open any current notice directly in GLASSPRO.

On **Android**, open GLASSPRO in Chrome and choose **Enable notifications → Allow**. On **Windows**, use Chrome, Edge, or Firefox. On **Mac**, use Safari, Chrome, or Firefox. Use the same in-app control and allow the browser permission. Repeat for each device and browser profile you want to receive alerts. The same button switches alerts off for the device. Choosing **Sign Out** disconnects its subscription, so enable alerts again after signing back in.

## Request a location

1. If Web Push is already configured, keep your existing keys. Apply the live location requests SQL and redeploy `gp-announcement-push` from the latest code using the command above.
2. Open **Team Management → Time & Attendance → Live Time Monitoring** and choose **Request Location → Send request** for a clocked-in employee.
3. The employee can choose **Share my location** or **Decline** from the notification, or from the request card on **Home** or **Time Clock**. GLASSPRO captures one fresh reading when the employee chooses to share.
4. Open the request again or click **Refresh status** to see the latest response. The shared pin includes the reported accuracy radius. Requests allow 10 minutes for a response. GLASSPRO removes the latest request and shared point when the shift ends and retains the request and response in the audit log without coordinates.

Location capture waits up to six seconds for a stronger reading and finishes early when the reported radius is 50 feet or less. A weaker reading still works and displays its accuracy. If the device cannot get a reading or permission is denied, staff can retry or decline a location request, and can still clock in or out.

The app icon and manifest are static so Apple can fetch them as soon as you choose **Add to Home Screen**. The sender uses the existing Supabase project and can send even when the recipient's browser tab is closed.

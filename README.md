# ExpenseChat

ExpenseChat is a chat app for recording and approving expenses, in the style of WhatsApp. One Expo codebase runs on iOS, Android and the web. The backend is a small Node API (`server/`, Express) backed by MySQL 8. All permission checks happen in the API, and the status rules in `src/lib/workflow.ts` are shared by the app and the server.

## Deploying
See [docs/DEPLOY.md](docs/DEPLOY.md) for the full Proxmox LXC guide.

## Database: SQLite or MySQL
`DATABASE_URL` in `.env` picks the backend:
- `sqlite:./data/expensechat.db`: one file, created on first start, nothing to install. Uses Node's built-in `node:sqlite` (Node 22.5+). One writer at a time, which suits testing and small teams.
- `mysql://user:pw@127.0.0.1:3306/expensechat`: MySQL 8, for real concurrency (setup below).

Same schema (`server/schema.ts`, translated for SQLite by `server/sqlDialect.ts`) and the same tests: `npm test` runs against whichever backend `.env` names (`TEST_DATABASE_URL` overrides).

## Offline mode (phone only)
On the login screen of the phone app, **Use offline on this phone** skips the server entirely: the app keeps its own SQLite database (expo-sqlite) and files on the device.
- Same rules as the server: the route handlers live in `server/core.ts` and run both in Express and on the phone (`src/lib/local.ts`), over the same schema (`server/schema.ts`) and SQL translation (`server/sqlDialect.ts`).
- Single user ("You", owner of everything). A starter workspace **My expenses** with channel **General** (no approval step) is created on first use.
- Not available offline: shared channels with other people, AI receipt reading / transcription, exports.
- Signing in with an account switches the app back to server mode; the offline data stays on the phone.

## Run locally
```bash
npm install
# one-time: create the DB + user (values must match DATABASE_URL in .env)
sudo mysql -e "CREATE DATABASE expensechat; CREATE DATABASE expensechat_test;
  CREATE USER 'expensechat'@'localhost' IDENTIFIED BY '<pw>'; CREATE USER 'expensechat'@'127.0.0.1' IDENTIFIED BY '<pw>';
  GRANT ALL ON expensechat.* TO 'expensechat'@'localhost','expensechat'@'127.0.0.1';
  GRANT ALL ON expensechat_test.* TO 'expensechat'@'localhost','expensechat'@'127.0.0.1';"
cp .env.example .env        # fill DATABASE_URL, JWT_SECRET (32+ chars)
npm run seed                # creates tables + demo data
npm run api                 # API on :4000 (creates tables on start)
npx expo start --web        # UI on :8081  (or press a / i for Android / iOS)
```
Demo logins (password `password123`): `head@demo.com` (owner), `acct@demo.com` (approver), `ali@demo.com` (member), `sara@demo.com` (viewer).

On a phone running Expo Go, set `EXPO_PUBLIC_API_URL` to your machine's LAN IP, for example `http://192.168.1.5:4000`. `localhost` on the phone means the phone itself.

## Features by phase
- **Phase 1:** login, workspaces, channels, roles, form threads, the status workflow, comments, attachments, ledger.
- **Phase 2:**
  - Voice notes: tap 🎙️ to record; the server transcribes them with any Whisper-compatible API (English and Urdu).
  - Receipts: tap 📷 for camera, gallery or PDF.
  - **Convert to form**: Claude (`claude-opus-5-5`, structured JSON output) extracts amount, tax, date, vendor, category, line items and notes, with a confidence score per field. Fields under 70% are highlighted for the user to check.
  - Requires `OPENAI_API_KEY` (for transcription) and `ANTHROPIC_API_KEY` (for extraction). Server-side refusal fallback (`fallbacks: "default"`) is enabled.
- **Phase 3:**
  - Owner approval limit per channel: above the limit, an approver's OK is step 1 and an owner must give step 2.
  - Partial and full payments, with method, reference, date and an optional proof file.
  - Exchange rate per expense for foreign currencies.
  - In-app notifications: mentions, approval requests, status changes, comments, overdue items.
  - Dashboard: totals, plus breakdowns by category, member and month.
  - Exports: CSV, Excel, PDF, and a receipts .zip.
- **Phase 4:**
  - Offline capture: a queue of creates and uploads that replays when the network returns, made safe to retry with client-generated ids. Edits made offline are checked against the server's version (409 on conflict).
  - English and Urdu, with RTL layout.
  - Duplicate warning on submit (same amount + vendor + date, or an identical file).
  - Audit log screen.
  - Global search and saved views.
  - Paginated lists everywhere.

Not built: push notifications, which need an EAS project and APNs/FCM credentials (the in-app center polls every 30s instead), plus phone OTP and Google login.

## Test
```bash
npm test           # status machine + HTTP permission/workflow tests against expensechat_test
npm run typecheck
```

## Deploy
- **API:** run `node server/index.ts` (Node 24+) on any VM or container, with the variables `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN` and `PUBLIC_API_URL`. Put it behind HTTPS. Keep `server/uploads/` on persistent disk, or move file storage to S3 later.
- **Web:** run `npx expo export --platform web` and host the resulting `dist/` folder on any static host.
- **Mobile:** run `npx eas-cli@latest build -p android|ios` with `EXPO_PUBLIC_API_URL` set.

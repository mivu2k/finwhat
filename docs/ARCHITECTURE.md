# ExpenseChat — Architecture

> **Update:** the backend is now **Node/Express + MySQL 8**, at the user's request. Supabase is gone, so its pieces are replaced: login uses JWTs with scrypt-hashed passwords, uploaded files sit on local disk behind HMAC-signed links, the thread screen polls every 5 seconds instead of getting live updates, and all permission checks run in `server/app.ts` (MySQL has no row-level security). The schema is in `server/schema.sql`. Sections below that mention Supabase, RLS or RPCs describe the original design.

## 1. Assumptions (defaults I picked; say if any are wrong)
1. **Default currency is PKR**, since Urdu is the second language. Each workspace has a `base_currency`. Exchange rates are stored per ledger entry (`fx_rate`, 1 until Phase 3 adds rate lookup).
2. **A workspace is created by whoever signs up first.** Channel owners add people by email, and those people must have signed up already. Email invites for people without an account come later.
3. **Approval starts as a single step.** The channel flag `approval_required = false` auto-approves on submit. Amount limits and multi-step approval are Phase 3.
4. **The ledger entry is written when a thread is approved.** It then follows the thread's status (unpaid / paid / closed). If an approver edits a posted thread, the ledger entry is synced from it.
5. **Reopen sends a thread back to `under_review`** and requires a reason.
6. **AI provider (Phase 2):** OpenAI Whisper (or a compatible API) for speech-to-text, and Claude (`claude-sonnet-5-5`) with structured JSON output for extracting fields from transcripts and OCR text. Both run behind Supabase Edge Functions, so API keys never reach the client.
7. **Stack:** I kept the one suggested in the brief (Expo SDK 58 + Expo Router on Supabase) unchanged.

## 2. Architecture
```
 Expo app (iOS / Android / Web, one codebase)
   │  supabase-js: Auth, PostgREST, Storage (signed URLs), Realtime
   ▼
 Supabase
   ├─ Postgres ── RLS on every table; money-state changes only via SECURITY DEFINER RPCs
   │     transition_thread()   status machine + system message + ledger posting
   │     create_workspace() / create_channel() / add_channel_member()
   │     triggers: status guard, ledger sync, append-only audit_logs, profile on signup
   ├─ Storage ── private bucket "attachments", path <channel_id>/<thread_id>/<file>, RLS by channel role
   ├─ Realtime ── threads + thread_messages
   └─ Edge Functions (Phase 2+) ── transcribe, extract, ocr, notify, export
```
The status machine has a single source of truth: the SQL function `transition_thread`. `src/lib/workflow.ts` is a mirror of it that the UI uses to decide which buttons to show. Both copies are tested.

## 3. Database
See `supabase/migrations/0001_init.sql`. Phase 1 tables:
`profiles, workspaces, workspace_members, categories, channels, channel_members, threads, attachments, thread_messages, ledger_entries, audit_logs`.

Later phases add tables in their own migrations: `transcripts`, `extractions` (field → value + confidence), `approvals` (multi-step), `payments` (partial payments), `notifications`, `push_tokens`, `saved_views`.

**Permission summary (enforced in Postgres):**

| Action | Owner | Approver | Member | Viewer |
|---|---|---|---|---|
| See channel, threads, ledger | ✓ | ✓ | ✓ | ✓ |
| Create a thread, comment, attach | ✓ | ✓ | ✓ | — |
| Edit fields | until closed | until closed | own thread, before approval | — |
| Approve / reject / mark paid / close / reopen | ✓ | ✓ | — | — |
| Manage members | ✓ | — | — | — |
| Read the audit log | ✓ | ✓ | — | — |

**Status machine:**
```
draft ─► submitted ─► under_review ─► approved ─► unpaid ─► paid ─► closed
            │  ▲            │            │                          │
            │  └ needs_info ◄┤            └──────────► closed        │ reopen (reason)
            └──────────────► rejected ─► closed / resubmit           ▼
                                                               under_review
```

## 4. API / Edge Functions
| Name | Phase | Purpose |
|---|---|---|
| RPC `create_workspace`, `create_channel`, `add_channel_member` | 1 | Membership bootstrap |
| RPC `transition_thread(thread, to, comment)` | 1 | All status changes |
| PostgREST tables | 1 | CRUD under RLS |
| Edge `transcribe` | 2 | Audio in storage → Whisper → `transcripts` |
| Edge `extract` | 2 | Transcript or OCR text → LLM JSON → `extractions` with per-field confidence |
| Edge `ocr` | 2 | Images/PDF → text (Google Vision or Textract) → `extract` |
| Edge `notify` | 3 | DB webhook → `notifications` rows + Expo push |
| Edge `export` | 3 | CSV / XLSX / PDF, plus a receipts zip for a period |
| RPC `dashboard(ws, filters)` | 3 | Aggregates in SQL |
| RPC `search(q)` | 4 | Full-text search over threads, transcripts and notes |

## 5. Screens and navigation
```
login
(tabs)  ── bottom tabs on phones, left sidebar at ≥768px
 ├─ Channels      workspaces → channels; create workspace/channel
 ├─ Ledger        paginated entries + paid/pending totals per currency
 └─ Profile       name, default currency, sign out
channel/[id]           thread list (paginated, live) + "New expense"
channel/[id]/new       expense form (modal)
channel/[id]/members   members & roles (owner edits)
thread/[id]            pinned summary, status actions, edit form, chat timeline, attachments
```
Planned: notification center (P3), dashboards (P3), search / saved views (P4), audit log viewer (P4).

## 6. Folder structure
```
src/app/            Expo Router routes (screens only)
src/components/     shared UI used by more than one screen (ExpenseForm)
src/lib/            supabase client, auth context, theme/ui primitives, workflow rules
supabase/migrations SQL schema + RLS
supabase/seed.sql   demo data
supabase/rls.test.ts runs the migration in PGlite and tests RLS + workflow
docs/               this file
```

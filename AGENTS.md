<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project Guide

## Positioning

This is a local prototype that aggregates public university recruitment notices. It currently supports Beijing University of Aeronautics and Astronautics, Beijing Institute of Technology, Beijing Jiaotong University, and Nankai University; do not describe it as a live nationwide service.

## Run And Verify

- Install/setup: `npm install`, then `npm run setup:local`.
- Develop: `npm run dev` and open `http://localhost:3000`.
- Collect one source with `npm run collect:buaa`, `npm run collect:bit`, `npm run collect:bjtu`, or `npm run collect:nankai`; run all configured sources with `npm run collect:daily`; install the Windows daily task with `npm run schedule:install`.
- Required checks after code changes: `npm test`, `npm run lint`, and `npm run build`.
- After PostgreSQL/runtime changes also run `npm run test:supabase` against temporary rollback-only tables; verify live HTTP with `npm run test:runtime-http` against a separately started website. Never expose credentials in output.
- After monitoring changes run `npm run test:monitor-http` against an isolated fake-database server; it closes its own process without touching production rows. `npm run monitor:check` verifies local database/source/backup health, not public uptime. `npm run monitor:errors` reads local sanitized events only.

## Stack

Next.js 16 App Router, React 19, TypeScript/JavaScript, local collector SQLite through `better-sqlite3`, website Supabase PostgreSQL through `pg`, and Node test runner.

## Layout And Conventions

- `src/app/` owns pages and HTTP routes; `scripts/` owns collection, storage, notifications, and reusable services.
- `data/`, `.env.local`, logs, database files, snapshots, and `SUPABASE_DB_URL` are local runtime state and must not be committed or exposed.
- Preserve existing rows on collection failure or an unexpected empty source response.
- Public notices remain `pending` until reviewed; UI text must distinguish pending from approved.
- Official links must stay on the configured university host. The app links to notices; it does not submit applications.
- Website storage is explicitly selected with `CAMPUS_JOBS_STORAGE=sqlite|supabase`; never silently fall back on connection failure. Website query/review services are asynchronous in both modes.
- Supabase owns review status, review audit, admin limits, and source_controls. Collector sync only owns five collection tables and must preserve all cloud management state. Reconcile cloud reviews and withdrawal history before SQLite or old-code rollback. Encrypted v2 snapshots cover eight tables; legacy v1 remains readable/drillable but cannot restore an empty publication target without withdrawal reconciliation. Daily backups are generated locally, not uploaded automatically or full-platform; one explicitly confirmed encrypted copy was manually uploaded to Baidu Netdisk on 2026-10-01. Password-protected key export to the confirmed D: KINGSTON USB drive and a full readback-key recovery drill passed on 2026-10-01 at 19:59:02 Beijing time. Never print or replace the backup key; restore only into a separate empty database with explicit confirmation. See docs/CLOUD-BACKUP-RECOVERY.md and docs/USB-KEY-BACKUP.md.
- Public queries must exclude withdrawn sources everywhere, including merged peers, detail, exports, options, and public history. Supported collection entrypoints check website-owned controls before new source batches and fail closed; in-flight batches are not canceled. Raw collector functions remain fixture-compatible and must not be used as production policy bypasses. See docs/PRIVACY-SOURCE-CONTROLS.md.
- TLS certificate verification is on by default. Supabase hosts use the bundled official public CA unless an explicit CA override is configured; this machine no longer uses the insecure exception. Vercel rejects SQLite and insecure TLS. Hosting builds validate server-only configuration before compiling; never bypass this guard to make unconfigured previews succeed.
- Keep `CLAUDE.md` as the pointer to this file and retain the generated Next.js block above.

## Current Status And Next Step

Checklist organization on 2026-10-01: docs/PROJECT-CHECKLIST.md starts with a progress overview; section 6 is the remaining-work queue. Next is B01 (second independent database recovery), not another temporary-table drill. Track B01.1-B01.6 individually and do not mark B01 complete before all evidence passes. Continue B02, P01-P05 only after prerequisites; O01 is the separate 2026-10-02 clock-trigger observation. Feishu remains deferred and pilot 5 remains canceled. Name the checklist item before starting; add/explain unlisted work and obtain user confirmation for scope/resource changes or a change in task order. Preserve historical completed records and keep per-step checkpoint verification separate from GitHub delivery.

Offsite copy on 2026-10-01: the user logged into Baidu Netdisk and explicitly confirmed the exact encrypted backup and destination. The private backup folder contains 20261001T101036628Z-60c0a06d.cjbackup; the upload showed 1/1 complete. The downloaded copy in the user's Downloads directory matches the original size and SHA-256. At 19:33:28 Beijing time, its rollback-only PostgreSQL recovery drill passed. At 19:59:02.483, the user's confirmed D: KINGSTON key export also passed a real readback-key recovery drill: all eight table contents identical, identity sequences verified, source restrictions included, productionWrites=false. The 245-byte .cjkey is password protected and portable, not DPAPI-bound; file metadata and SHA-256 were reread. See docs/BAIDU-OFFSITE-BACKUP.md and docs/USB-KEY-BACKUP.md. Never upload raw SQLite/JSON/CSV, the entire backup directory, local configuration or keys; no public share was created. The portable scrypt/AES-GCM tools passed 64 local tests, lint, build and one real recovery integration test. Automatic upload and second-project recovery remain unverified. The dialog sends the password only via private child stdin; never read or store it in chat. Next, confirm a separate second Supabase project for empty-target recovery without overwriting or switching the live source.

Local database/API/UI, four collectors, reviews, local backups, the Windows daily task, filters, detail pages, saved-job CSV, privacy information, clear-saved action, and source withdrawal/restoration are implemented. Industry labels are inferred. Feishu is deferred and the fifth pilot is canceled. The Git remote is `https://github.com/Kimie-ship-It/keen.git`; verify remote delivery live. Supabase with strict official-CA TLS owns website queries and management state; SQLite collectors synchronize five collection tables. The additive source-controls migration preserves production rows and enables RLS. Encrypted eight-table v2 backup and isolated rollback recovery include withdrawal history. Basic sanitized errors and local health checks exist; withdrawn sources are paused, legacy seven-table backups are incomplete. The installed Windows task was demand-triggered on 2026-10-01: four collections, sync, automatic backups and health succeeded with task exit 0, and the exact new eight-table backup passed a rollback-only full recovery drill. The 2026-10-02 08:00 clock trigger has not yet occurred; do not claim observed clock-trigger or cloud scheduling success. See docs/DAILY-TASK-ACCEPTANCE.md. Vercel emits console events only. The last recorded Vercel state is pending account verification, with no public deployment; it was not rechecked in this step. Public contact email/operator validation, hosting/HTTPS, cloud collection, independent monitoring/real alerts, automated offsite upload, second-project recovery, and public access remain pending. Next: confirm and verify recovery into a second project, retaining the source and never switching website storage without user confirmation. Never create unapproved paid resources. Review docs/PROJECT-CHECKLIST.md at task start and completion; create a verified step checkpoint and verify GitHub push.

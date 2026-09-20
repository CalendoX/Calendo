# Calendor — interview scheduling for hiring teams

Calendor is a multi-tenant scheduling platform for recruiters, interviewers and candidates. Interviewers
publish booking pages for their interview types; candidates pick a time without creating an account;
Calendor books the interview, creates the Zoom meeting, puts it on the interviewer's Google Calendar,
emails everyone, sends reminders, and keeps all of it in sync through reschedules and cancellations.

- **Scheduling engine**: working hours with split shifts, date overrides, vacation days and company
  holidays, per-event schedules, buffers, minimum notice, booking windows, daily limits. Time-zone
  and DST correct (IANA zones via Luxon; instants stored in UTC).
- **Double-booking prevention**: the server recomputes availability at booking time inside a
  per-interviewer lock, against live Google Calendar free/busy, and a Postgres exclusion constraint
  rejects overlapping interviews as a last line of defence.
- **Google Calendar and Zoom**: real OAuth 2.0 (PKCE + state), encrypted tokens with automatic
  refresh, conflict detection, event and meeting create/update/cancel, push notifications and
  webhooks, and a retry path for every failure.
- **Candidate self-service**: secure, expiring, revocable links to view, reschedule or cancel.
- **Notifications**: confirmation, reschedule, cancellation and configurable reminder emails with
  calendar invitations, delivered by a background worker with retries.
- **Dashboard and admin**: dashboard, list and calendar (month/week/day) views of interviews,
  filters and search, interview detail with history and sync status, team and user management,
  organisation settings, email templates, holidays, integrations overview and an audit log.

---

## Contents

1. [Getting started](#getting-started)
2. [Development credentials](#development-credentials)
3. [Environment variables](#environment-variables)
4. [Sending email from each organization's domain](#sending-email-from-each-organizations-domain)
5. [Connecting Google Calendar](#connecting-google-calendar)
6. [Connecting Zoom](#connecting-zoom)
7. [Architecture](#architecture)
8. [Database and migrations](#database-and-migrations)
9. [Background jobs](#background-jobs)
10. [Testing](#testing)
11. [Production deployment](#production-deployment)
12. [API reference](#api-reference)
13. [Security](#security)
14. [Known limitations](#known-limitations)

---

## Getting started

### Prerequisites

- **Node.js 22.12+** (see `engines` in `package.json`)
- **Docker** for the local PostgreSQL and Mailpit (a local mail catcher) containers — or your own
  PostgreSQL and SMTP server

### 1. Install dependencies

```bash
npm install
```

### 2. Configure the environment

```bash
cp .env.example .env
```

Generate the two required secrets and paste them into `.env`:

```bash
openssl rand -hex 32      # → SESSION_SECRET
openssl rand -base64 32   # → ENCRYPTION_KEY
```

The defaults in `.env.example` already point at the Docker services below. Google and Zoom can stay
blank until you set them up — the app runs without them and shows them as "not configured".

### 3. Start PostgreSQL and Mailpit

```bash
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432` (creating a `slate` database, plus `slate_test` for the
integration tests) and Mailpit on `localhost:1025` (SMTP) with a web inbox at
<http://localhost:8025> where every email the app sends shows up.

### 4. Create the schema and load demo data

```bash
npm run db:migrate   # SQL migrations + job-queue schema
npm run db:seed      # demo organisations, users, event types and interviews
```

### 5. Run the app and the worker

Use two terminals:

```bash
npm run dev          # web app on http://localhost:9000
npm run worker:dev   # background worker: emails, reminders, Zoom/Calendar sync, webhooks
```

The worker is required for emails and reminders. Bookings still work without it, and queued jobs
run once it starts.

Sign in at <http://localhost:9000/login> with one of the accounts below, or open a public booking
page such as <http://localhost:9000/schedule/priya/technical-interview>.

To start over at any point: `npm run db:reset` (drops everything, migrates and seeds again).

---

## Development credentials

`npm run db:seed` creates two organisations. They show tenant isolation: users in one can never see
the other's data. **These credentials are for local development only.**

| Role | Organisation | Email | Password |
|---|---|---|---|
| Admin | Northwind Labs | `admin@northwind.test` | `Admin#Slate2026` |
| Recruiter | Northwind Labs | `recruiter@northwind.test` | `Recruit#Slate2026` |
| Interviewer | Northwind Labs | `priya@northwind.test` | `Interview#Slate2026` |
| Interviewer | Northwind Labs | `marcus@northwind.test` | `Interview#Slate2026` |
| Admin | Globex Recruiting | `admin@globex.test` | `Globex#Slate2026` |

The seed also creates event types (Technical Interview, a link-only System Design Interview, Recruiter
Phone Screen, Culture & Values Chat, Hiring Manager Interview), availability schedules with split
hours, a vacation day and a company holiday, and a spread of past, upcoming, rescheduled and
cancelled interviews with candidates.

Public booking pages for the seeded data include:

- `/schedule/priya` (all of Priya's public interview types)
- `/schedule/priya/technical-interview`
- `/schedule/jordan/phone-screen`

---

## Environment variables

All configuration is read from environment variables and validated at startup
(`src/server/config/env.ts`). `.env.example` documents each one.

| Variable | Required | Description |
|---|---|---|
| `APP_URL` | yes | Public base URL, no trailing slash. Used in emails, OAuth redirects and CSRF origin checks. Use `https://` in production; this also turns on `Secure` / `__Host-` cookies. |
| `DATABASE_URL` | yes | PostgreSQL connection string. |
| `DATABASE_POOL_MAX` | no | Connection pool size per process (default 10). |
| `DATABASE_SSL` | no | `true` to require TLS with certificate verification. |
| `SESSION_SECRET` | yes | ≥32 characters. Key for the HMACs of session and capability tokens. |
| `ENCRYPTION_KEY` | yes | 32 bytes, base64. AES-256-GCM key for OAuth tokens and Zoom host URLs. |
| `ENCRYPTION_KEY_PREVIOUS` | no | Comma-separated old keys still accepted for decryption (key rotation). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for Google | OAuth web client credentials. |
| `GOOGLE_REDIRECT_URI` | no | Defaults to `${APP_URL}/api/integrations/google/callback`. |
| `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` | for Zoom | Zoom OAuth app credentials. |
| `ZOOM_REDIRECT_URI` | no | Defaults to `${APP_URL}/api/integrations/zoom/callback`. |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | for Zoom webhooks | Secret Token from the app's Event Subscriptions. |
| `WEBHOOK_BASE_URL` | no | Public HTTPS base for provider webhooks. Defaults to `APP_URL`. Google push channels are only registered when it is `https://`. |
| `EMAIL_PROVIDER` | no | `smtp`, `resend` or `console` (default `console`). |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` | no | Platform sender, e.g. `"Calendor <scheduling@example.com>"`. Used for account emails, and for interview emails of organizations without a verified sending domain. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | for SMTP | Any SMTP service (Postmark, SES, SendGrid, Mailgun, Mailpit…). |
| `RESEND_API_KEY` | for Resend | Resend API key. Give it **full access** so organizations can connect their own sending domains (see below). |
| `WORKER_CONCURRENCY` | no | Parallel jobs per queue per worker process (default 5). |
| `PLATFORM_ADMIN_EMAILS` | yes, in production | Comma-separated emails of the people who run the deployment. New self-service sign-ups can't sign in until one of them approves the request under **Platform → Sign-up requests** (they're emailed about each request). The address must be verified to grant these rights. Team members invited by an organization admin don't need approval. |
| `CORS_ALLOWED_ORIGINS` | no | Origins allowed to call the public scheduling API from other sites. |
| `TRUST_PROXY` | no | `true` behind a load balancer, so `X-Forwarded-For` is used for rate limits and audit IPs. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn` or `error`. |
| `TEST_DATABASE_URL` | tests | Integration-test database. Its name must end in `_test`. Default `postgres://slate:slate@localhost:5432/slate_test`. |

Background jobs run on [pg-boss](https://github.com/timgit/pg-boss), which lives in the same PostgreSQL
database, so there is no Redis or other queue service to configure.

---

## Sending email from each organization's domain

With `EMAIL_PROVIDER=resend`, each organization's admin can connect the organization's own domain
under **System settings → Email sending**. Calendor registers the domain with Resend and shows the
DNS records (SPF and DKIM) to publish. Once Resend verifies them, the organization's interview emails
(confirmations, reminders, reschedules and cancellations) come from its own address, e.g.
`"Acme Hiring" <scheduling@acme.com>`. Replies still go to the interviewer or candidate.

Until a domain verifies, or if it stops verifying, interview emails come from `EMAIL_FROM`, named
after the organization. Account emails (verification, password reset, invitations) always use
`EMAIL_FROM`. Each domain can belong to one organization, and the platform's own sender domain is
reserved.

---

## Connecting Google Calendar

Each interviewer connects their own Google account from **Integrations → Google Calendar**.
Calendor then:

- reads free/busy from the calendars they choose, so busy times are never offered to candidates
- writes each interview to the calendar they choose (details, candidate info, Zoom link, and a link
  back to Calendor), and updates or deletes it when the interview changes
- registers push notifications, so events deleted or moved directly in Google are flagged in Calendor

### Google Cloud setup

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. **APIs & Services → Library**: enable the **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**: configure the app name, support email and authorised
   domain. Add these scopes:
   - `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`
   - `https://www.googleapis.com/auth/calendar.readonly`: list calendars and read free/busy
   - `https://www.googleapis.com/auth/calendar.events`: create, update and delete interview events

   While the app's publishing status is **Testing**, only listed test users can connect, and Google
   expires their refresh tokens after 7 days. The calendar scopes are *sensitive*, so a public
   production app needs Google's verification.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
   Add the authorised redirect URI `${APP_URL}/api/integrations/google/callback`, for example
   `http://localhost:9000/api/integrations/google/callback` in development.
5. Put the client ID and secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and restart.

After connecting, each interviewer picks their calendars under **Integrations**: which to check for
conflicts (the primary calendar by default), and which one receives new interviews.

**Push notifications** need a public HTTPS URL. In development, run a tunnel (for example
`cloudflared tunnel --url http://localhost:9000` or `ngrok http 9000`) and set `WEBHOOK_BASE_URL`
to its URL. Without it, everything else still works: availability is always read live from Google,
and only the "deleted/moved in Google" detection is skipped.

---

## Connecting Zoom

Each interviewer connects their own Zoom account. For interview types whose location is **Zoom**,
Calendor creates a meeting per interview at the right time, duration and time zone, with a waiting room
and the candidate as an invitee. The join link goes into the confirmation email and the calendar
event. The meeting is updated on reschedule and deleted on cancellation. The host start URL is stored
encrypted and only ever released to the interviewer, through a no-store redirect.

### Zoom Marketplace setup

1. At [marketplace.zoom.us](https://marketplace.zoom.us/) choose **Develop → Build App → General App**,
   and make it **user-managed**.
2. **OAuth redirect URL** and **OAuth allow list**: `${APP_URL}/api/integrations/zoom/callback`.
3. **Scopes**: allow creating, updating, deleting and reading the user's meetings, and reading the
   user's profile. With granular scopes that is `meeting:write:meeting`, `meeting:update:meeting`,
   `meeting:delete:meeting`, `meeting:read:meeting` and `user:read:user`. Check the exact names in
   the Marketplace UI, because Zoom has renamed scopes over time.
4. **Features → Event Subscriptions** (optional but recommended): endpoint
   `${WEBHOOK_BASE_URL}/api/webhooks/zoom`, events **Meeting deleted**, **Meeting updated** and
   **App deauthorized**. Copy the **Secret Token** into `ZOOM_WEBHOOK_SECRET_TOKEN`. Calendor answers
   Zoom's endpoint URL validation automatically.
5. Put the client ID and secret into `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` and restart.

---

## Architecture

**Stack**: Next.js 16 (App Router, React 19) · TypeScript · PostgreSQL · Drizzle ORM · pg-boss ·
Luxon · Zod · Tailwind CSS 4 · Radix UI · Argon2id · Nodemailer.

```
src/
  app/                    Next.js routes
    (app)/                authenticated dashboard (dashboard, interviews, calendar, event types,
                          availability, integrations, team, settings, admin/*)
    (auth)/               login, signup, password reset, email verification, invitations
    schedule/             public booking pages      /schedule/:username[/:eventSlug]
    s/[token]             personal scheduling links
    booking/              candidate confirmation, reschedule and cancel pages (token-based)
    api/                  REST API (thin handlers: validate → authorise → call a service)
  components/             UI components (booking flow, slot picker, calendar, editors, admin…)
  server/
    scheduling/           engine.ts (pure slot maths), availability-service, booking-service, tokens
    integrations/         provider interfaces, registry, IntegrationService, sync reconciler,
                          google/ and zoom/ implementations, webhooks
    notifications/        planner (what to send), deliver (worker), templates, ICS, email transports
    jobs/                 queue definitions, retry policies, handlers
    services/             application services (interviews, event types, team, auth, org, audit…)
    auth/ authz/          sessions, password hashing, role-based access policy
    security/             crypto (HMAC, AES-GCM, PKCE), Postgres-backed rate limiter
    http/                 error model, validation, route wrapper, CSRF/CORS helpers
    db/                   schema (single source of truth) and client
  worker/                 background worker entry point
  proxy.ts                per-request CSP nonce and auth redirect (Next.js 16's "proxy", formerly middleware)
drizzle/                  SQL migrations (generated + hand-written constraint)
scripts/                  migrate, seed, reset, bundling
tests/                    unit and integration tests
```

### How a booking works

1. The public page asks `GET /api/public/availability/...` for slots. `availability-service` loads
   the schedule, holidays, existing interviews and Google free/busy, and the pure `engine.ts`
   computes the bookable start times.
2. `POST /api/public/book/...` goes to `booking-service.bookInterview`. The client's view of
   availability is never trusted:
   - Free/busy is fetched **live** (never from cache). If the calendar can't be read, the request
     fails with `503 CALENDAR_UNAVAILABLE` rather than assuming the interviewer is free.
   - Inside one transaction, Calendor takes a per-interviewer `pg_advisory_xact_lock`, reloads the
     interviewer's interviews, and re-runs `checkSlot()` (the same code that produced the slots).
   - The interview, candidate, capability tokens, pending Zoom/Calendar records, notifications and
     audit entry are written, and the sync job is enqueued in the **same transaction**, so a
     rolled-back booking never has side effects and a committed one is never lost.
   - The `interviews_no_overlapping_active` exclusion constraint (`btree_gist`) makes overlapping
     active interviews for one interviewer impossible at the database level.
   - Idempotency keys make client retries return the original booking.
3. After commit, a bounded inline sync creates the Zoom meeting and calendar event, so the
   confirmation page can show the link. The queued job is what guarantees completion, with retries.

### Integrations

`server/integrations/types.ts` defines the provider interfaces (`OAuthAdapter`, `CalendarProvider`,
`ConferencingProvider`). `IntegrationService` (`service.ts`) is the only entry point the rest of the
system uses: `getAvailability`, `createMeeting` / `updateMeeting` / `cancelMeeting`,
`createCalendarEvent` / `updateCalendarEvent` / `cancelCalendarEvent`. It owns credential handling
(decryption, refresh under a row lock so rotating refresh tokens are never used twice, error state).
Adding Outlook or Google Meet means implementing an interface and registering it in `registry.ts`.

`sync.ts` is a versioned, idempotent **reconciler**. Every change bumps `interviews.version`, and
each external record stores the version it reflects. Replays and retries are safe, bursts of changes
collapse into one job, and a record deleted in the provider is detected and can be re-created. Every
failure is recorded on the record (`failed` + `last_error`), audited, shown in the UI with a **Retry
sync** action, and retried by the worker when the error is retryable (network, 5xx, 429).

### Time zones

All instants are `timestamptz` in UTC. Working hours are wall-clock minutes in the schedule's IANA zone
and are converted per calendar date, so a 09:00–17:00 day stays 09:00–17:00 on both sides of a DST
change. Candidates see times in their detected browser zone (changeable), and emails render in each
recipient's own zone.

---

## Database and migrations

The schema is defined in `src/server/db/schema.ts`. Migrations in `drizzle/` are applied in order
and tracked in the `drizzle.__drizzle_migrations` table.

| Command | Purpose |
|---|---|
| `npm run db:generate` | Generate a new SQL migration after editing `schema.ts`. Review it and commit it. |
| `npm run db:migrate` | Apply migrations and install/update the job-queue schema (development, via `tsx`). |
| `npm run db:migrate:deploy` | Same, using the bundled `dist/migrate.js` (production; run `npm run build` first). |
| `npm run db:seed` | Load demo data (skipped if it already exists). |
| `npm run db:reset` | Drop everything, migrate and seed. Refuses to run with `NODE_ENV=production`. |
| `npm run db:studio` | Browse the database with Drizzle Studio. |

Constraints that Drizzle can't express are hand-written migrations, such as
`0001_interview_overlap_guard.sql` (the exclusion constraint that prevents double-booking).

---

## Background jobs

`npm run worker` (production) / `npm run worker:dev` runs every asynchronous task. Queues and retry
policies are defined in `src/server/jobs/definitions.ts`.

| Queue | Purpose | Retries |
|---|---|---|
| `interview-sync` | Create/update/cancel the Zoom meeting and calendar event | 10, exponential backoff up to 1 h |
| `notification-deliver` | Send one email (confirmations, reminders scheduled with `startAfter`) | 6, backoff up to 1 h |
| `account-email` | Verification, password-reset and invitation emails | 5 |
| `webhook-process` | Process a stored Google/Zoom webhook delivery | 5 |
| `calendar-watch-renew` (cron, 6-hourly) | Renew Google push channels before they expire | |
| `sync-sweeper` / `notification-sweeper` (cron, 5 min) | Safety nets that re-enqueue stuck or lost work | |
| `interviews-complete` (cron, 10 min) | Mark finished interviews as completed | |
| `maintenance-cleanup` (cron, hourly) | Purge expired sessions, tokens, OAuth states and rate-limit rows | |
| `dead-letter` | Terminal failures, kept 30 days for inspection | |

Workers coordinate through PostgreSQL (`SKIP LOCKED`), so you can run as many as you need. Every
handler is idempotent. Emails carry the interview version they describe, so a reminder for a time
that has since been rescheduled is skipped rather than sent. **Admin → System settings** shows queue
depths, recent worker activity and webhook health.

---

## Testing

```bash
docker compose up -d postgres   # the integration suite needs PostgreSQL
npm test                        # everything (unit + integration)
npm run test:unit               # pure logic, no infrastructure, ~2 s
npm run test:integration        # real PostgreSQL, ~35 s
npm run typecheck
```

**Unit tests** (`tests/unit`) cover the scheduling engine (slots, buffers, notice, booking windows,
daily limits, overrides, holidays, DST transitions in several zones, conflict semantics), crypto
(AES-GCM, key rotation, PKCE, token hashing), webhook signature verification, provider error
classification and 401 refresh-retry, iCalendar generation, email templates (time-zone rendering,
HTML escaping) and the password policy.

**Integration tests** (`tests/integration`) run route handlers in-process against a real PostgreSQL
database (`TEST_DATABASE_URL`, default `slate_test`). The global setup wipes that database, applies
every migration and installs the queue schema. It refuses to run against a database whose name
doesn't end in `_test`. They cover:

- **Public booking**: valid booking, invalid/inactive/link-only events, expired, revoked and used-up
  scheduling links, already-booked slots, 8 candidates racing for one slot, duplicate bookings,
  idempotent retries, buffers, notice and window rules, and form validation.
- **Interviews**: dashboard creation, reschedule with preserved history, conflict rejection,
  candidate reschedule and cancel via tokens (including policy and cut-off), status changes,
  completion job, filters, and the database exclusion constraint.
- **Auth**: login/logout, lockout, rate limits, idle and deactivated sessions, CSRF, password reset,
  email verification, and the invitation flow.
- **Authorization**: role restrictions and **tenant isolation** across organisations.
- **Google Calendar**: OAuth (PKCE, state forgery/replay/cross-user, missing scopes), busy-time
  exclusion, calendar selection, fail-closed behaviour, event create/update/cancel, idempotent
  creation, failure and recovery, token refresh (reactive, proactive, concurrent, revoked grant),
  disconnect, and push notifications.
- **Zoom**: OAuth, meeting create/update/cancel with correct payloads, host-URL secrecy, 5xx, 429 and
  network failures with retry and follow-up email, not-connected recovery, refresh-token rotation,
  and signed webhooks.
- **Notifications**: configurable reminders, delivery idempotency, send retries, sweeper, and
  template overrides with escaping.
- **`definition-of-done.test.ts`**: the full 27-step workflow from the product specification, from
  the admin creating an interviewer to reminders firing.

Google and Zoom are replaced in tests by in-process fakes (`tests/helpers/fake-providers.ts`)
installed through the provider HTTP hook. They enforce the providers' real protocol rules (PKCE
verification, client authentication, bearer validation with 401s, Zoom refresh-token rotation,
Google's 409 for duplicate event ids and 410 for deleted events), and they can inject failures. The
production provider code runs unmodified. No test calls the real Google or Zoom APIs. Verifying
against the live services requires real credentials (see the setup sections above).

---

## Production deployment

The `Dockerfile` builds two images from one build:

- **`web`**: the Next.js standalone server (`node server.js`, port 3000, with a health check on
  `/api/health`)
- **`worker`**: the background worker (`node dist/worker.js`), which also contains the migration
  runner (`node dist/migrate.js`)

`docker-compose.prod.yml` wires them to PostgreSQL, with a one-shot migration service that must
succeed before the web and worker containers start:

```bash
cp .env.example .env.production   # fill in real values
export POSTGRES_PASSWORD=$(openssl rand -hex 24)
docker compose -f docker-compose.prod.yml up -d --build
```

On any platform (Kubernetes, ECS, Fly.io, Render…) the shape is the same:

1. **Build** both targets: `docker build --target web …` and `docker build --target worker …`.
   Without Docker: `npm ci && npm run build`, which produces `.next/standalone` and `dist/`.
2. **Migrate** on every deploy, before the new version serves traffic: run the worker image with
   `node dist/migrate.js` (or `npm run db:migrate:deploy`). It is idempotent.
3. **Run** the web service (scale horizontally) and at least one worker (scale as needed).
4. **Terminate TLS** in front of the web service and set `TRUST_PROXY=true`.

### Single server with pm2

On one server without Docker, `ecosystem.config.cjs` runs the web server (`calendor-web`, on
`127.0.0.1:9000` behind your reverse proxy) and the worker (`calendor-worker`) under
[pm2](https://pm2.keymetrics.io/), both reading `.env` (with `NODE_ENV=production`).

```bash
npm run deploy                      # build, copy static assets, migrate, (re)start both processes
pm2 startup systemd && pm2 save     # once: restart the processes after a reboot
pm2 logs calendor-web               # or calendor-worker
```

Run `npm run deploy` again after every code change. After editing `.env` only, restart instead:
`pm2 restart calendor-web calendor-worker --update-env`.

### Production checklist

- `APP_URL` (and `WEBHOOK_BASE_URL`, if different) are `https://` URLs.
- `SESSION_SECRET` and `ENCRYPTION_KEY` are freshly generated, stored in a secrets manager, and
  identical across all web and worker instances. Rotate the encryption key with
  `ENCRYPTION_KEY_PREVIOUS`.
- OAuth redirect URIs in Google Cloud and the Zoom Marketplace match your production `APP_URL`.
  The Google app has passed verification for the calendar scopes.
- A real email provider is configured (`EMAIL_PROVIDER=smtp` or `resend`), and your sending domain
  has SPF, DKIM and DMARC records.
- At least one worker is running. Without one, no emails or reminders are sent.
- PostgreSQL has automated backups and point-in-time recovery. Job-queue state lives in the same
  database.
- Health checks point at `/api/health`, which checks database connectivity.
- **Admin → System settings** shows all integrations as configured and the worker as recently active.

---

## API reference

Every endpoint returns JSON. Errors have the shape
`{ "error": { "code": "SLOT_UNAVAILABLE", "message": "…", "details": … } }`. Authenticated
endpoints use the session cookie, and mutations must come from the app's own origin (CSRF check).

**Auth**: `POST /api/auth/signup` · `login` · `logout` · `forgot-password` · `reset-password` ·
`verify-email` · `resend-verification` · `accept-invite` · `switch-organization` · `GET /api/auth/me`

**Interviews**: `GET|POST /api/interviews` · `GET|PATCH /api/interviews/:id` ·
`GET /api/interviews/:id/availability` · `POST /api/interviews/:id/reschedule` ·
`POST /api/interviews/:id/cancel` · `POST /api/interviews/:id/sync` (retry integrations) ·
`GET /api/interviews/:id/zoom/start` (host only)

**Event types**: `GET|POST /api/event-types` · `GET|PATCH|DELETE /api/event-types/:id` ·
`GET /api/event-types/:id/availability` · `GET|POST /api/event-types/:id/links` ·
`DELETE /api/scheduling-links/:id`

**Availability**: `GET|POST /api/availability` · `GET|PUT|DELETE /api/availability/:id` ·
`POST /api/availability/:id/default`

**Calendar**: `GET /api/calendar/events` · `GET /api/calendar/busy`

**Integrations**: `GET /api/integrations` · `POST /api/integrations/{google|zoom}/connect` ·
`GET /api/integrations/{google|zoom}/callback` (OAuth redirect target) ·
`POST /api/integrations/{google|zoom}/disconnect` · `PATCH|POST /api/integrations/google/calendars`

**Admin** (admins only): `GET|POST /api/admin/users` · `GET|PATCH /api/admin/users/:id` ·
`POST /api/admin/users/:id/resend-invite` · `GET /api/admin/stats` · `GET /api/admin/audit-logs` ·
`PATCH /api/admin/organization` · `GET|POST /api/admin/holidays` · `DELETE /api/admin/holidays/:id` ·
`GET /api/admin/templates` · `PUT /api/admin/templates/:type`

**Account**: `PATCH /api/me` (profile) · `POST /api/me/password`

**Public (no account; rate-limited)**:
`GET /api/public/schedule/:username/:eventSlug` · `GET /api/public/availability/:username/:eventSlug` ·
`POST /api/public/book/:username/:eventSlug` · `GET /api/public/bookings/:token` ·
`GET /api/public/bookings/:token/ics` · `POST /api/public/bookings/reschedule/:token` ·
`GET /api/public/bookings/reschedule/:token/availability` · `POST /api/public/bookings/cancel/:token`

**Webhooks**: `POST /api/webhooks/google` (channel token) · `POST /api/webhooks/zoom` (HMAC signature)

**Health**: `GET /api/health`

---

## Security

- **Passwords**: Argon2id, a length and predictability policy, lockout after repeated failures, and
  timing-equalised responses for unknown accounts.
- **Sessions**: random 256-bit tokens, only an HMAC stored, `HttpOnly` + `SameSite=Lax` (+ `Secure`
  and the `__Host-` prefix over HTTPS). Absolute and idle expiry. Revoked on logout, password change
  or reset, and deactivation.
- **Authorization**: organisation-scoped RBAC (`src/server/authz/policy.ts`). Resources outside
  your scope return 404. Availability and integration settings are owner-only.
- **CSRF**: `SameSite` cookies plus `Origin` / `Sec-Fetch-Site` validation on every mutation.
- **Rate limiting**: a Postgres-backed fixed-window limiter on login, signup, reset, public pages,
  availability, booking and webhooks.
- **Candidate links**: separate 256-bit view, reschedule and cancel tokens (HMAC-indexed). They expire
  with the interview, are revoked on cancellation, and internal IDs never authorise anything.
- **OAuth**: state and PKCE bound to the signed-in user, single-use, 10-minute expiry. Least-privilege
  scopes. Tokens are AES-256-GCM encrypted at rest and never sent to the browser.
- **Webhooks**: Zoom HMAC signatures with a 5-minute replay window; Google per-channel secret tokens.
  Deliveries are de-duplicated and processed asynchronously.
- **Output**: a strict nonce-based CSP, security headers (`next.config.ts`), and HTML-escaped emails.
  Drizzle's parameterised queries prevent SQL injection, and Zod validates every API input.
- **Audit log**: logins, user and role changes, event type changes, interview lifecycle, integration
  connect, disconnect and failure, and admin actions, each with actor, IP and metadata.

---

## Known limitations

- **Google Meet and Microsoft Outlook / Teams** are not implemented. The provider interfaces and
  registry are ready for them, and Google Meet appears in the event-type editor as "coming soon".
- **Sign-in with Google or Microsoft** (OAuth login) is not implemented. Authentication is
  email/password. Sessions are provider-agnostic, so an OAuth login would only need to create a
  session.
- **Candidate accounts** are not implemented. Candidates use per-booking capability links, as the
  specification's default requires.
- **Browser end-to-end tests** are not written yet. `@playwright/test` is installed; the booking
  flow, dashboard and admin UI are covered through their API routes but not through a real browser.
- **Live provider verification**: the automated suite runs against protocol-faithful fakes, not
  Google and Zoom themselves. Before launch, run the workflow once end-to-end against real Google and
  Zoom test accounts with your production OAuth apps.

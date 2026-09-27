# HomeFlow — Smart Household Duty Manager

Run locally with Node.js 22.5 or newer and PostgreSQL:

```powershell
npm start
```

Then open `http://localhost:3000`.

Set `DATABASE_URL` (or the standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` variables) for PostgreSQL before starting the server. Initial account setup, including credentials and the Gemini key, is configured exclusively through the server-side `.env` file and is never sent to the client. Arjun is the administrator.

To migrate the existing SQLite database once, run `npm run migrate:postgres`. The script reads `data/homeflow.sqlite` (or `HOMEFLOW_DB_PATH`) and writes all application tables, including member roles, `active` flags, and `password_hash` values, to the configured PostgreSQL database. It does not print environment values.

## Deploy on Render

The repository includes `render.yaml` for a Render web service and PostgreSQL database. In Render, create a Blueprint from this repository and enter the `sync: false` values in the service Environment settings. Use new production passwords; never copy `.env` into Render or commit it.

For an existing SQLite database, run the migration locally with the Render PostgreSQL connection string before relying on the deployed data:

```powershell
$env:DATABASE_URL = '<Render PostgreSQL connection string>'
$env:PGSSL = 'require'
npm run migrate:postgres
```

The migration is safe to rerun and preserves member roles and password hashes. The web service starts with `npm start` and Render supplies the `PORT` value automatically.

The server uses Asia/Kolkata as its scheduling timezone. The fresh cleaning schedule starts Sunday, 27 September 2026 and generates the configured six-week assignment cycle idempotently from that date. On the next startup, a one-time backend migration clears previous cleaning tasks and their linked request/audit history while preserving member accounts and all water-duty data. The weekly head is derived from the current Bathroom + garbage assignee. Cleaning requests open Friday and close at 11:59:59 PM the following Monday. Deadlines are reconciled at startup, on a 30-second server worker, and whenever cleaning data is read; each automatic failure records a timestamp and audit event. The weekly head approves each request before it counts as completed; Arjun's own Bathroom + garbage request is automatically approved only when he is the weekly head.

Water duty is event-driven and separate from cleaning. Its current responsible member is stored in PostgreSQL and advances only after an authenticated, atomic completion. Each completion stores its sequence, member ID/name, and server timestamp in the permanent water completion history.

The integration test suite runs with `npm test`. It currently uses the legacy temporary SQLite harness and therefore requires a PostgreSQL-backed test harness update before it can exercise the PostgreSQL server.

Production reset on 27 September 2026: the operational duty tables were cleared transactionally while member accounts, password hashes, roles, schema, and settings were preserved. The live water rotation was initialized to Akshay. For deployments with ephemeral local filesystems, set `HOMEFLOW_DB_PATH` to a SQLite file on a persistent mounted volume; keep the database backup outside source control.

For a production deployment, change the seeded passwords and replace the in-memory session store with a managed session provider or persistent token table. Do not commit `.env` or print its contents.

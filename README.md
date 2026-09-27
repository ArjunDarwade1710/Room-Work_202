# HomeFlow — Smart Household Duty Manager

Run locally with Node.js 22.5 or newer:

```powershell
npm start
```

Then open `http://localhost:3000`.

The app creates its persistent SQLite database at `data/homeflow.sqlite` on first start. Initial account setup, including credentials and the Gemini key, is configured exclusively through the server-side `.env` file and is never sent to the client. Arjun is the administrator.

The server uses Asia/Kolkata as its scheduling timezone. The fresh cleaning schedule starts Sunday, 27 September 2026 and generates the configured six-week assignment cycle idempotently from that date. On the next startup, a one-time backend migration clears previous cleaning tasks and their linked request/audit history while preserving member accounts and all water-duty data. The weekly head is derived from the current Bathroom + garbage assignee. Cleaning requests open Friday and close at 11:59:59 PM the following Monday. Deadlines are reconciled at startup, on a 30-second server worker, and whenever cleaning data is read; each automatic failure records a timestamp and audit event. The weekly head approves each request before it counts as completed; Arjun's own Bathroom + garbage request is automatically approved only when he is the weekly head.

Water duty is event-driven and separate from cleaning. Its current responsible member is stored in SQLite and advances only after an authenticated, atomic completion. Each completion stores its sequence, member ID/name, and server timestamp in the permanent water completion history.

The integration test suite runs with `npm test`. It uses a temporary SQLite database and the `HOMEFLOW_TEST_NOW` clock override; it does not modify the household database.

Production reset on 27 September 2026: the operational duty tables were cleared transactionally while member accounts, password hashes, roles, schema, and settings were preserved. The live water rotation was initialized to Akshay. For deployments with ephemeral local filesystems, set `HOMEFLOW_DB_PATH` to a SQLite file on a persistent mounted volume; keep the database backup outside source control.

For a production deployment, change the seeded passwords and replace the in-memory session store with a managed session provider or persistent token table.

# PlanJinji — SQL edition

The coaching site, now backed by a real SQLite database via a Node/Express API.

## Run it

Requires **Node.js 22+** (uses the built-in `node:sqlite` — no native compilation needed).

```bash
npm install          # installs express (the only dependency)
node server.js       # starts on http://localhost:3000
```

The database file `planjinji.db` is created automatically next to `server.js` on first run.

### Enable AI-suggested workouts

```bash
ANTHROPIC_API_KEY=sk-ant-...  node server.js
```

Get a key at https://console.anthropic.com. Without a key everything else still works —
only the "✨ AI suggest this week" button will show a friendly error.

### Options (environment variables)

| Variable            | Default             | What it does                   |
|---------------------|---------------------|--------------------------------|
| `PORT`              | `3000`              | Server port                    |
| `DB_PATH`           | `./planjinji.db`    | Where the SQLite file lives    |
| `ANTHROPIC_API_KEY` | (unset)             | Enables AI workout suggestions |
| `AI_MODEL`          | `claude-sonnet-4-5` | Model used for suggestions     |

## Coach access

- Default coach PIN: **091997** (created in the `settings` table on first run)
- Change it any time from the dashboard ("Change coach PIN") or directly in SQL:
  `UPDATE settings SET value = '123456' WHERE key = 'coach_pin';`

## Database schema

See `schema.sql`. Tables: `clients`, `workout_days`, `exercises`,
`session_logs`, `log_entries`, `settings`. Poke around with any SQLite tool
(e.g. `sqlite3 planjinji.db` or DB Browser for SQLite).

Handy queries:

```sql
-- All weights an athlete has ever logged for one exercise
SELECT sl.date, le.weight_used, le.comment
FROM log_entries le JOIN session_logs sl ON sl.id = le.log_id
WHERE sl.client_id = 'dana_levi' AND le.exercise = 'Back squat'
ORDER BY sl.id;

-- Who trained this week
SELECT c.name, COUNT(*) AS sessions
FROM session_logs sl JOIN clients c ON c.id = sl.client_id
WHERE sl.date >= date('now', '-7 days')
GROUP BY c.id;
```

## Deploying online

Any Node host works: Railway, Render, Fly.io, or a small VPS.
Upload the folder, set the env vars, run `node server.js`.
Note: SQLite lives in a single file, so use a host with a persistent disk
(on Railway/Render add a volume and point `DB_PATH` at it).

## API quick reference

Athlete: `POST /api/login`, `POST /api/clients`, `POST /api/client/:id/set-pin`,
`GET /api/client/:id` (header `x-client-pin`), `POST /api/client/:id/finish`.

Coach (header `x-coach-pin`): `POST /api/coach/login`, `GET /api/coach/clients`,
`GET /api/coach/client/:id`, `PUT /api/coach/client/:id/day`,
`POST /api/coach/client/:id/reset-pin`, `POST /api/coach/client/:id/ai-week`,
`POST /api/coach/change-pin`.

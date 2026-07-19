// PlanJinji server — Express + Supabase Postgres (via node-postgres "pg")
// Run locally: put DATABASE_URL in a .env file, then `node server.js`
require("dotenv").config();
const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const NUM_WEEKS = 5;
const MAX_DAYS_PER_WEEK = 30; // sanity ceiling — days beyond a client's frequency can still hold built workouts
const DEFAULT_COACH_PIN = "091997";

// ---------- database ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const q = (text, params = []) => pool.query(text, params);

// Creates every table if it doesnt already exist, then seeds the coach PIN.
async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  await q(`CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    goals TEXT,
    frequency INTEGER NOT NULL,
    facilities TEXT NOT NULL,
    pin TEXT,
    joined TEXT,
    progress_week INTEGER NOT NULL DEFAULT 0,
    progress_day INTEGER NOT NULL DEFAULT 0,
    xp INTEGER NOT NULL DEFAULT 0
  )`);
  await q(`CREATE TABLE IF NOT EXISTS workout_days (
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    week INTEGER NOT NULL,
    day INTEGER NOT NULL,
    title TEXT,
    UNIQUE (client_id, week, day)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS exercises (
    id SERIAL PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    week INTEGER NOT NULL,
    day INTEGER NOT NULL,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    sets TEXT,
    reps TEXT,
    weight TEXT,
    rest TEXT
  )`);
  await q(`CREATE TABLE IF NOT EXISTS session_logs (
    id SERIAL PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    date TEXT,
    week INTEGER,
    day INTEGER,
    session_note TEXT
  )`);
  await q(`CREATE TABLE IF NOT EXISTS log_entries (
    id SERIAL PRIMARY KEY,
    log_id INTEGER NOT NULL REFERENCES session_logs(id) ON DELETE CASCADE,
    exercise TEXT,
    weight_used TEXT,
    comment TEXT
  )`);
  // CREATE TABLE IF NOT EXISTS is a no-op on a table that predates a column — patch those in explicitly.
  await q(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS xp INTEGER NOT NULL DEFAULT 0`);

  const r = await q("SELECT value FROM settings WHERE key = 'coach_pin'");
  if (r.rows.length === 0)
    await q("INSERT INTO settings (key, value) VALUES ('coach_pin', $1)", [DEFAULT_COACH_PIN]);
}

// ---------- settings / client helpers ----------
async function getSetting(k) {
  const r = await q("SELECT value FROM settings WHERE key = $1", [k]);
  return r.rows.length ? r.rows[0].value : null;
}
async function setSetting(k, v) {
  await q(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [k, String(v)]
  );
}
async function getClientRow(id) {
  const r = await q("SELECT * FROM clients WHERE id = $1", [id]);
  return r.rows[0] || null;
}

const nameToId = (name) =>
  String(name).trim().toLowerCase().replace(/[^a-zא-ת0-9]+/gi, "_").replace(/^_+|_+$/g, "");

const isClientPin = (p) => /^\d{4}$/.test(p);

// ---------- assemblers ----------
// A week shows `freq` day slots, but if it already has exercises built past that
// (e.g. the athlete lowered their frequency after the coach filled in extra days),
// those built days stay visible instead of vanishing.
async function assemblePlan(id, freq) {
  const dayRows = (await q("SELECT * FROM workout_days WHERE client_id = $1", [id])).rows;
  const exRows = (
    await q("SELECT * FROM exercises WHERE client_id = $1 ORDER BY week, day, position", [id])
  ).rows;
  const weeks = [];
  for (let w = 0; w < NUM_WEEKS; w++) {
    const maxBuiltDay = exRows.reduce((m, r) => (r.week === w && r.day + 1 > m ? r.day + 1 : m), 0);
    const dayCount = Math.max(freq, maxBuiltDay);
    const days = [];
    for (let d = 0; d < dayCount; d++) {
      const dr = dayRows.find((r) => r.week === w && r.day === d);
      days.push({
        title: (dr && dr.title) || `Workout ${d + 1}`,
        exercises: exRows
          .filter((r) => r.week === w && r.day === d)
          .map((r) => ({ name: r.name, sets: r.sets, reps: r.reps, weight: r.weight, rest: r.rest })),
      });
    }
    weeks.push({ days });
  }
  return { weeks };
}

async function assembleLogs(id) {
  const logs = (await q("SELECT * FROM session_logs WHERE client_id = $1 ORDER BY id", [id])).rows;
  const out = [];
  for (const l of logs) {
    const entries = (
      await q("SELECT exercise, weight_used, comment FROM log_entries WHERE log_id = $1 ORDER BY id", [l.id])
    ).rows;
    out.push({
      date: l.date,
      week: l.week,
      day: l.day,
      sessionNote: l.session_note,
      entries: entries.map((e) => ({ exercise: e.exercise, weightUsed: e.weight_used, comment: e.comment })),
    });
  }
  return out;
}

async function fullClient(id, { includePin = false } = {}) {
  const c = await getClientRow(id);
  if (!c) return null;
  return {
    id: c.id,
    profile: {
      name: c.name,
      goals: c.goals,
      frequency: String(c.frequency),
      facilities: safeFacilities(c.facilities),
      joined: c.joined,
      ...(includePin ? { pin: c.pin } : {}),
    },
    plan: await assemblePlan(id, c.frequency),
    progress: { week: c.progress_week, day: c.progress_day },
    xp: c.xp || 0,
    logs: await assembleLogs(id),
  };
}
function safeFacilities(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch (e) {
    // old-format plain text like "Full gym" — wrap it into an array
    return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  }
}


async function replaceDay(clientId, week, day, title, exercises) {
  await q(
    "INSERT INTO workout_days (client_id, week, day, title) VALUES ($1, $2, $3, $4) " +
      "ON CONFLICT (client_id, week, day) DO UPDATE SET title = excluded.title",
    [clientId, week, day, String(title || `Workout ${day + 1}`)]
  );
  await q("DELETE FROM exercises WHERE client_id = $1 AND week = $2 AND day = $3", [clientId, week, day]);
  const list = exercises || [];
  for (let i = 0; i < list.length; i++) {
    const ex = list[i];
    const name = String(ex.name || "").trim();
    if (!name) continue;
    await q(
      "INSERT INTO exercises (client_id, week, day, position, name, sets, reps, weight, rest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [clientId, week, day, i, name, String(ex.sets || ""), String(ex.reps || ""), String(ex.weight || ""), String(ex.rest || "90")]
    );
  }
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// wraps async handlers so a thrown error becomes a clean 500 instead of a hang
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error("Route error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Server error: " + err.message });
  });

// ---- auth middlewares ----
async function clientAuth(req, res, next) {
  const c = await getClientRow(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (!c.pin || (req.headers["x-client-pin"] || "") !== c.pin)
    return res.status(401).json({ error: "Wrong PIN. If you forgot it, ask your coach." });
  req.clientRow = c;
  next();
}

async function coachAuth(req, res, next) {
  const pin = await getSetting("coach_pin");
  if ((req.headers["x-coach-pin"] || "") !== pin)
    return res.status(401).json({ error: "Wrong coach PIN" });
  next();
}

// ---- athlete routes ----

// Step 1 of login: does this name exist?
app.post("/api/login", wrap(async (req, res) => {
  const id = nameToId(req.body.name || "");
  if (!id) return res.status(400).json({ error: "Enter your full name to continue." });
  const c = await getClientRow(id);
  if (!c) return res.json({ status: "new", id });
  res.json({ status: "existing", id, needsPinSetup: !c.pin, firstName: c.name.split(" ")[0] });
}));

// Onboarding: create client + empty 5-week plan grid
app.post("/api/clients", wrap(async (req, res) => {
  const { name, goals, frequency, facilities, pin } = req.body || {};
  const id = nameToId(name || "");
  if (!id) return res.status(400).json({ error: "Enter your full name to continue." });
  if (await getClientRow(id)) return res.status(409).json({ error: "That name is already registered — log in instead." });
  if (!String(goals || "").trim()) return res.status(400).json({ error: "Tell your coach what your goals are." });
  const freq = Math.min(7, Math.max(1, parseInt(frequency) || 0));
  if (!freq) return res.status(400).json({ error: "Pick how often you work out." });
  if (!Array.isArray(facilities) || facilities.length === 0)
    return res.status(400).json({ error: "Pick at least one training setup." });
  if (!isClientPin(pin)) return res.status(400).json({ error: "Choose a 4-digit PIN (numbers only)." });

  await q(
    "INSERT INTO clients (id, name, goals, frequency, facilities, pin, joined) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, String(name).trim(), String(goals).trim(), freq, JSON.stringify(facilities), pin, new Date().toISOString()]
  );
  for (let w = 0; w < NUM_WEEKS; w++)
    for (let d = 0; d < freq; d++)
      await q("INSERT INTO workout_days (client_id, week, day, title) VALUES ($1,$2,$3,$4)", [id, w, d, `Workout ${d + 1}`]);

  res.json(await fullClient(id));
}));

// Legacy clients created before PINs existed: set one
app.post("/api/client/:id/set-pin", wrap(async (req, res) => {
  const c = await getClientRow(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (c.pin) return res.status(403).json({ error: "PIN already set" });
  if (!isClientPin(req.body.pin)) return res.status(400).json({ error: "PIN must be exactly 4 digits." });
  await q("UPDATE clients SET pin = $1 WHERE id = $2", [req.body.pin, c.id]);
  res.json({ ok: true });
}));

// Full personal space (verifies PIN via header)
app.get("/api/client/:id", wrap(clientAuth), wrap(async (req, res) => {
  res.json(await fullClient(req.params.id));
}));

// Athlete edits their own goals/frequency/equipment. Lowering frequency only clears
// the empty overflow day slots — anything the coach already built stays put and stays visible.
app.put("/api/client/:id/profile", wrap(clientAuth), wrap(async (req, res) => {
  const c = req.clientRow;
  const { goals, frequency, facilities } = req.body || {};
  if (!String(goals || "").trim()) return res.status(400).json({ error: "Tell your coach what your goals are." });
  const freq = Math.min(7, Math.max(1, parseInt(frequency) || 0));
  if (!freq) return res.status(400).json({ error: "Pick how often you work out." });
  if (!Array.isArray(facilities) || facilities.length === 0)
    return res.status(400).json({ error: "Pick at least one training setup." });

  const oldFreq = c.frequency;
  await q("UPDATE clients SET goals = $1, frequency = $2, facilities = $3 WHERE id = $4", [
    String(goals).trim(), freq, JSON.stringify(facilities), c.id,
  ]);

  if (freq < oldFreq) {
    for (let w = 0; w < NUM_WEEKS; w++) {
      for (let d = freq; d < oldFreq; d++) {
        const built = await q("SELECT 1 FROM exercises WHERE client_id = $1 AND week = $2 AND day = $3 LIMIT 1", [c.id, w, d]);
        if (built.rows.length === 0)
          await q("DELETE FROM workout_days WHERE client_id = $1 AND week = $2 AND day = $3", [c.id, w, d]);
      }
    }
  } else if (freq > oldFreq) {
    for (let w = 0; w < NUM_WEEKS; w++) {
      for (let d = oldFreq; d < freq; d++) {
        await q(
          "INSERT INTO workout_days (client_id, week, day, title) VALUES ($1,$2,$3,$4) ON CONFLICT (client_id, week, day) DO NOTHING",
          [c.id, w, d, `Workout ${d + 1}`]
        );
      }
    }
  }

  res.json(await fullClient(c.id));
}));

// Finish a session: log feedback + weights, advance to next workout
app.post("/api/client/:id/finish", wrap(clientAuth), wrap(async (req, res) => {
  const c = req.clientRow;
  if (c.progress_week >= NUM_WEEKS) return res.status(400).json({ error: "Program already complete." });
  const { entries, sessionNote } = req.body || {};

  const ins = await q(
    "INSERT INTO session_logs (client_id, date, week, day, session_note) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [c.id, new Date().toISOString(), c.progress_week + 1, c.progress_day + 1, String(sessionNote || "").trim()]
  );
  const logId = ins.rows[0].id;

  for (const e of (Array.isArray(entries) ? entries : [])) {
    await q(
      "INSERT INTO log_entries (log_id, exercise, weight_used, comment) VALUES ($1,$2,$3,$4)",
      [logId, String((e && e.exercise) || ""), String((e && e.weightUsed) || "").trim(), String((e && e.comment) || "").trim()]
    );
  }

  // advance the pointer
  let nw = c.progress_week, nd = c.progress_day + 1;
  if (nd >= c.frequency) { nd = 0; nw += 1; }
  await q("UPDATE clients SET progress_week = $1, progress_day = $2, xp = COALESCE(xp, 0) + 250 WHERE id = $3", [nw, nd, c.id]);

  res.json(await fullClient(c.id));
}));

// ---- coach routes ----

app.post("/api/coach/login", wrap(async (req, res) => {
  const pin = await getSetting("coach_pin");
  if ((req.body.pin || "") !== pin) return res.status(401).json({ error: "Wrong PIN." });
  res.json({ ok: true });
}));

app.post("/api/coach/change-pin", wrap(coachAuth), wrap(async (req, res) => {
  const p = String(req.body.pin || "");
  if (!/^\d{4,8}$/.test(p)) return res.status(400).json({ error: "Coach PIN must be 4-8 digits." });
  await setSetting("coach_pin", p);
  res.json({ ok: true });
}));

app.get("/api/coach/clients", wrap(coachAuth), wrap(async (req, res) => {
  const r = await q("SELECT id, name, frequency FROM clients ORDER BY name");
  res.json(r.rows);
}));

app.get("/api/coach/client/:id", wrap(coachAuth), wrap(async (req, res) => {
  const c = await fullClient(req.params.id, { includePin: true });
  if (!c) return res.status(404).json({ error: "Client not found" });
  res.json(c);
}));

// Delete a client and all their data (coach only)
app.delete("/api/coach/client/:id", wrap(coachAuth), wrap(async (req, res) => {
  const c = await getClientRow(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  // ON DELETE CASCADE handles children, but we clear them explicitly to be safe.
  const logs = (await q("SELECT id FROM session_logs WHERE client_id = $1", [c.id])).rows;
  for (const row of logs) await q("DELETE FROM log_entries WHERE log_id = $1", [row.id]);
  await q("DELETE FROM session_logs WHERE client_id = $1", [c.id]);
  await q("DELETE FROM exercises WHERE client_id = $1", [c.id]);
  await q("DELETE FROM workout_days WHERE client_id = $1", [c.id]);
  await q("DELETE FROM clients WHERE id = $1", [c.id]);
  res.json({ ok: true });
}));

// Replace one workout day (title + exercises) — covers add/remove/edit/copy
app.put("/api/coach/client/:id/day", wrap(coachAuth), wrap(async (req, res) => {
  const c = await getClientRow(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  const { week, day, title, exercises } = req.body || {};
  const w = parseInt(week), d = parseInt(day);
  if (isNaN(w) || w < 0 || w >= NUM_WEEKS || isNaN(d) || d < 0 || d >= MAX_DAYS_PER_WEEK)
    return res.status(400).json({ error: "Invalid week/day" });
  await replaceDay(c.id, w, d, title, exercises);
  res.json(await fullClient(c.id, { includePin: true }));
}));

app.post("/api/coach/client/:id/reset-pin", wrap(coachAuth), wrap(async (req, res) => {
  const c = await getClientRow(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  await q("UPDATE clients SET pin = NULL WHERE id = $1", [c.id]);
  res.json({ ok: true });
}));

// AI-suggested week (requires ANTHROPIC_API_KEY in the environment)
app.post("/api/coach/client/:id/ai-week", wrap(coachAuth), wrap(async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key)
    return res.status(400).json({ error: "AI suggestions need an Anthropic API key. Set ANTHROPIC_API_KEY." });
  const c = await getClientRow(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  const w = parseInt(req.body.week);
  if (isNaN(w) || w < 0 || w >= NUM_WEEKS) return res.status(400).json({ error: "Invalid week" });

  const prompt = `You are an expert strength & conditioning coach. Build ONE week of training.
Athlete goals: ${c.goals}
Sessions this week: ${c.frequency}
Available equipment: ${JSON.parse(c.facilities).join(", ")}
This is week ${w + 1} of a 5-week program (scale intensity/volume for that week).
Respond with ONLY valid JSON, no markdown fences, no commentary:
{"days":[{"title":"short name","exercises":[{"name":"...","sets":"3","reps":"10","weight":"e.g. 40kg / bodyweight / RPE7","rest":"90"}]}]}
Exactly ${c.frequency} days. 4-5 exercises per day. Keep every string short. "rest" is seconds between sets.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || "claude-sonnet-4-5",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error((data.error && data.error.message) || "Anthropic API error");
    const text = (data.content || []).map((i) => i.text || "").join("");
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    for (let d = 0; d < c.frequency; d++) {
      const src = (parsed.days || [])[d] || {};
      await replaceDay(c.id, w, d, String(src.title || `Workout ${d + 1}`).slice(0, 40), src.exercises || []);
    }
    res.json(await fullClient(c.id, { includePin: true }));
  } catch (e) {
    console.error("AI suggestion failed:", e.message);
    res.status(502).json({ error: "AI suggestion didn't come back clean — hit the button again." });
  }
}));

// ---------- start ----------
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`PlanJinji running on http://localhost:${PORT}`);
      console.log(`Database: Supabase Postgres (connected)`);
      console.log(`AI suggestions: ${process.env.ANTHROPIC_API_KEY ? "enabled" : "disabled (set ANTHROPIC_API_KEY to enable)"}`);
    });
  })
  .catch((err) => {
    console.error("Could not start — database connection/init failed:");
    console.error(err.message);
    process.exit(1);
  });
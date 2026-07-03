// PlanJinji server — Express + SQLite (Node's built-in node:sqlite, no native deps)
// Run: node server.js   (Node 22+)
const express = require("express");
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "planjinji.db");
const NUM_WEEKS = 5;
const DEFAULT_COACH_PIN = "091997";

// ---------- database ----------
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

const getSetting = (k) => {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(k);
  return r ? r.value : null;
};
const setSetting = (k, v) =>
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(k, String(v));

if (!getSetting("coach_pin")) setSetting("coach_pin", DEFAULT_COACH_PIN);

// ---------- helpers ----------
const nameToId = (name) =>
  String(name).trim().toLowerCase().replace(/[^a-zא-ת0-9]+/gi, "_").replace(/^_+|_+$/g, "");

const isClientPin = (p) => /^\d{4}$/.test(p);

const getClientRow = (id) => db.prepare("SELECT * FROM clients WHERE id = ?").get(id);

function assemblePlan(id, freq) {
  const dayRows = db.prepare("SELECT * FROM workout_days WHERE client_id = ?").all(id);
  const exRows = db
    .prepare("SELECT * FROM exercises WHERE client_id = ? ORDER BY week, day, position")
    .all(id);
  const weeks = [];
  for (let w = 0; w < NUM_WEEKS; w++) {
    const days = [];
    for (let d = 0; d < freq; d++) {
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

function assembleLogs(id) {
  const logs = db.prepare("SELECT * FROM session_logs WHERE client_id = ? ORDER BY id").all(id);
  const entryStmt = db.prepare("SELECT exercise, weight_used, comment FROM log_entries WHERE log_id = ? ORDER BY id");
  return logs.map((l) => ({
    date: l.date,
    week: l.week,
    day: l.day,
    sessionNote: l.session_note,
    entries: entryStmt.all(l.id).map((e) => ({
      exercise: e.exercise,
      weightUsed: e.weight_used,
      comment: e.comment,
    })),
  }));
}

function fullClient(id, { includePin = false } = {}) {
  const c = getClientRow(id);
  if (!c) return null;
  return {
    id: c.id,
    profile: {
      name: c.name,
      goals: c.goals,
      frequency: String(c.frequency),
      facilities: JSON.parse(c.facilities),
      joined: c.joined,
      ...(includePin ? { pin: c.pin } : {}),
    },
    plan: assemblePlan(id, c.frequency),
    progress: { week: c.progress_week, day: c.progress_day },
    logs: assembleLogs(id),
  };
}

function replaceDay(clientId, week, day, title, exercises) {
  db.prepare(
    "INSERT INTO workout_days (client_id, week, day, title) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(client_id, week, day) DO UPDATE SET title = excluded.title"
  ).run(clientId, week, day, String(title || `Workout ${day + 1}`));
  db.prepare("DELETE FROM exercises WHERE client_id = ? AND week = ? AND day = ?").run(clientId, week, day);
  const ins = db.prepare(
    "INSERT INTO exercises (client_id, week, day, position, name, sets, reps, weight, rest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  (exercises || []).forEach((ex, i) => {
    const name = String(ex.name || "").trim();
    if (!name) return;
    ins.run(clientId, week, day, i, name, String(ex.sets || ""), String(ex.reps || ""), String(ex.weight || ""), String(ex.rest || "90"));
  });
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- auth middlewares ----
function clientAuth(req, res, next) {
  const c = getClientRow(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (!c.pin || (req.headers["x-client-pin"] || "") !== c.pin)
    return res.status(401).json({ error: "Wrong PIN. If you forgot it, ask your coach." });
  req.clientRow = c;
  next();
}

function coachAuth(req, res, next) {
  if ((req.headers["x-coach-pin"] || "") !== getSetting("coach_pin"))
    return res.status(401).json({ error: "Wrong coach PIN" });
  next();
}

// ---- athlete routes ----

// Step 1 of login: does this name exist?
app.post("/api/login", (req, res) => {
  const id = nameToId(req.body.name || "");
  if (!id) return res.status(400).json({ error: "Enter your full name to continue." });
  const c = getClientRow(id);
  if (!c) return res.json({ status: "new", id });
  res.json({ status: "existing", id, needsPinSetup: !c.pin, firstName: c.name.split(" ")[0] });
});

// Onboarding: create client + empty 5-week plan grid
app.post("/api/clients", (req, res) => {
  const { name, goals, frequency, facilities, pin } = req.body || {};
  const id = nameToId(name || "");
  if (!id) return res.status(400).json({ error: "Enter your full name to continue." });
  if (getClientRow(id)) return res.status(409).json({ error: "That name is already registered — log in instead." });
  if (!String(goals || "").trim()) return res.status(400).json({ error: "Tell your coach what your goals are." });
  const freq = Math.min(7, Math.max(1, parseInt(frequency) || 0));
  if (!freq) return res.status(400).json({ error: "Pick how often you work out." });
  if (!Array.isArray(facilities) || facilities.length === 0)
    return res.status(400).json({ error: "Pick at least one training setup." });
  if (!isClientPin(pin)) return res.status(400).json({ error: "Choose a 4-digit PIN (numbers only)." });

  db.prepare(
    "INSERT INTO clients (id, name, goals, frequency, facilities, pin, joined) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, String(name).trim(), String(goals).trim(), freq, JSON.stringify(facilities), pin, new Date().toISOString());
  const dayIns = db.prepare("INSERT INTO workout_days (client_id, week, day, title) VALUES (?, ?, ?, ?)");
  for (let w = 0; w < NUM_WEEKS; w++)
    for (let d = 0; d < freq; d++) dayIns.run(id, w, d, `Workout ${d + 1}`);

  res.json(fullClient(id));
});

// Legacy clients created before PINs existed: set one
app.post("/api/client/:id/set-pin", (req, res) => {
  const c = getClientRow(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  if (c.pin) return res.status(403).json({ error: "PIN already set" });
  if (!isClientPin(req.body.pin)) return res.status(400).json({ error: "PIN must be exactly 4 digits." });
  db.prepare("UPDATE clients SET pin = ? WHERE id = ?").run(req.body.pin, c.id);
  res.json({ ok: true });
});

// Full personal space (verifies PIN via header)
app.get("/api/client/:id", clientAuth, (req, res) => {
  res.json(fullClient(req.params.id));
});

// Finish a session: log feedback + weights, advance to next workout
app.post("/api/client/:id/finish", clientAuth, (req, res) => {
  const c = req.clientRow;
  if (c.progress_week >= NUM_WEEKS) return res.status(400).json({ error: "Program already complete." });
  const { entries, sessionNote } = req.body || {};
  const logId = db
    .prepare("INSERT INTO session_logs (client_id, date, week, day, session_note) VALUES (?, ?, ?, ?, ?)")
    .run(c.id, new Date().toISOString(), c.progress_week + 1, c.progress_day + 1, String(sessionNote || "").trim())
    .lastInsertRowid;
  const ins = db.prepare("INSERT INTO log_entries (log_id, exercise, weight_used, comment) VALUES (?, ?, ?, ?)");
  (Array.isArray(entries) ? entries : []).forEach((e) =>
    ins.run(logId, String(e.exercise || ""), String(e.weightUsed || "").trim(), String(e.comment || "").trim())
  );
  // advance the pointer
  let nw = c.progress_week, nd = c.progress_day + 1;
  if (nd >= c.frequency) { nd = 0; nw += 1; }
  db.prepare("UPDATE clients SET progress_week = ?, progress_day = ? WHERE id = ?").run(nw, nd, c.id);
  res.json(fullClient(c.id));
});

// ---- coach routes ----

app.post("/api/coach/login", (req, res) => {
  if ((req.body.pin || "") !== getSetting("coach_pin")) return res.status(401).json({ error: "Wrong PIN." });
  res.json({ ok: true });
});

app.post("/api/coach/change-pin", coachAuth, (req, res) => {
  const p = String(req.body.pin || "");
  if (!/^\d{4,8}$/.test(p)) return res.status(400).json({ error: "Coach PIN must be 4-8 digits." });
  setSetting("coach_pin", p);
  res.json({ ok: true });
});

app.get("/api/coach/clients", coachAuth, (req, res) => {
  res.json(db.prepare("SELECT id, name, frequency FROM clients ORDER BY name").all());
});

app.get("/api/coach/client/:id", coachAuth, (req, res) => {
  const c = fullClient(req.params.id, { includePin: true });
  if (!c) return res.status(404).json({ error: "Client not found" });
  res.json(c);
});

// Replace one workout day (title + exercises) — covers add/remove/edit/copy
app.put("/api/coach/client/:id/day", coachAuth, (req, res) => {
  const c = getClientRow(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  const { week, day, title, exercises } = req.body || {};
  const w = parseInt(week), d = parseInt(day);
  if (isNaN(w) || w < 0 || w >= NUM_WEEKS || isNaN(d) || d < 0 || d >= c.frequency)
    return res.status(400).json({ error: "Invalid week/day" });
  replaceDay(c.id, w, d, title, exercises);
  res.json(fullClient(c.id, { includePin: true }));
});

app.post("/api/coach/client/:id/reset-pin", coachAuth, (req, res) => {
  const c = getClientRow(req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  db.prepare("UPDATE clients SET pin = NULL WHERE id = ?").run(c.id);
  res.json({ ok: true });
});

// AI-suggested week (requires ANTHROPIC_API_KEY in the environment)
app.post("/api/coach/client/:id/ai-week", coachAuth, async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key)
    return res.status(400).json({ error: "AI suggestions need an Anthropic API key. Start the server with ANTHROPIC_API_KEY set." });
  const c = getClientRow(req.params.id);
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
      replaceDay(c.id, w, d, String(src.title || `Workout ${d + 1}`).slice(0, 40), src.exercises || []);
    }
    res.json(fullClient(c.id, { includePin: true }));
  } catch (e) {
    console.error("AI suggestion failed:", e.message);
    res.status(502).json({ error: "AI suggestion didn't come back clean — hit the button again." });
  }
});

app.listen(PORT, () => {
  console.log(`PlanJinji running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`AI suggestions: ${process.env.ANTHROPIC_API_KEY ? "enabled" : "disabled (set ANTHROPIC_API_KEY to enable)"}`);
});

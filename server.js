import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Config =====
const PORT             = process.env.PORT || 8080;
const ATTENDANT_TOKEN  = process.env.ATTENDANT_TOKEN || "scan-XYZ123";
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN || "admin-XYZ123";
const EVENT_ID_DEFAULT = process.env.EVENT_ID_DEFAULT || "MF2025";
const DATABASE_URL     = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("Falta DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const app = express();
app.use(cors());
app.use(express.json());

// Servir tu web (móvil + admin) desde /public
app.use(express.static(path.join(__dirname, "public")));

// ===== Bootstrap DB (crea tablas si no existen) =====
const bootstrapSQL = `
CREATE TABLE IF NOT EXISTS scans (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  code TEXT NOT NULL,
  raw TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS checkins (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  code TEXT NOT NULL,
  first_scan_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, code)
);`;

async function bootstrap() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(bootstrapSQL);
    await client.query("COMMIT");
    console.log("Tablas OK");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Error bootstrap:", e);
    process.exit(1);
  } finally {
    client.release();
  }
}

// ===== Utilidades =====
function bearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/i);
  return m ? m[1] : null;
}
function requireToken(req, res, expected) {
  const tok = bearer(req);
  if (!tok || tok !== expected) {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    return true;
  }
  return false;
}

// ===== SSE para admin =====
const sseClients = new Set();
app.get("/admin/stream", (req, res) => {
  if (requireToken(req, res, ADMIN_TOKEN)) return;

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.flushHeaders();
  res.write(`event: ping\ndata: ok\n\n`);

  const client = { res };
  sseClients.add(client);
  req.on("close", () => sseClients.delete(client));
});

function sseBroadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of sseClients) {
    try { c.res.write(data); } catch {}
  }
}

// ===== API =====

// 1) Check-in desde el móvil (azafato)
app.post("/api/checkin", async (req, res) => {
  if (requireToken(req, res, ATTENDANT_TOKEN)) return;

  const { code, eventId, raw } = req.body || {};
  const event_id = (eventId || EVENT_ID_DEFAULT || "").trim();
  if (!code || !event_id) {
    return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
  }

  const ua = req.headers["user-agent"] || null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Histórico (siempre se guarda)
    await client.query(
      `INSERT INTO scans (event_id, code, raw, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [event_id, code, raw ?? null, ua]
    );

    // Único por (event_id, code)
    const insertCheckin = await client.query(
      `INSERT INTO checkins (event_id, code)
       VALUES ($1, $2)
       ON CONFLICT (event_id, code) DO NOTHING
       RETURNING id, first_scan_at`,
      [event_id, code]
    );

    await client.query("COMMIT");

    const duplicated = insertCheckin.rowCount === 0;
    const payload = {
      ok: true,
      duplicated,
      eventId: event_id,
      code,
      firstSeenAt: insertCheckin.rows?.[0]?.first_scan_at || null
    };

    sseBroadcast("checkin", payload);
    return res.json(payload);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("checkin error", e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  } finally {
    client.release();
  }
});

// 2) Listado SCANS (histórico con duplicados)
app.get("/admin/scans", async (req, res) => {
  if (requireToken(req, res, ADMIN_TOKEN)) return;

  const event_id = (req.query.eventId || EVENT_ID_DEFAULT || "").trim();
  const limit = Math.min(parseInt(req.query.limit || "500", 10), 2000);

  try {
    const { rows } = await pool.query(
      `SELECT id, event_id, code, raw, user_agent, created_at
       FROM scans
       WHERE event_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [event_id, limit]
    );
    res.json({ ok: true, eventId: event_id, items: rows });
  } catch (e) {
    console.error("scans error", e);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// 3) Listado CHECKINS (únicos)
app.get("/admin/checkins", async (req, res) => {
  if (requireToken(req, res, ADMIN_TOKEN)) return;

  const event_id = (req.query.eventId || EVENT_ID_DEFAULT || "").trim();
  try {
    const { rows } = await pool.query(
      `SELECT id, event_id, code, first_scan_at
       FROM checkins
       WHERE event_id = $1
       ORDER BY first_scan_at DESC`,
      [event_id]
    );
    res.json({ ok: true, eventId: event_id, items: rows });
  } catch (e) {
    console.error("checkins error", e);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const server = app.listen(PORT, async () => {
  console.log(`Server on :${PORT}`);
  await bootstrap();
});

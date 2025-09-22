require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const { RateLimiterMemory } = require("rate-limiter-flexible");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.set("trust proxy", true);

// --- Config ---
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const ATTENDANT_TOKEN = process.env.ATTENDANT_TOKEN || "scan-XYZ123";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin-ABC999";
const DATABASE_URL = process.env.DATABASE_URL;

// --- Seguridad y básicos ---
app.use(helmet());
app.use(compression());
app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN, credentials: false }));
app.use(express.json({ limit: "1mb" }));

// --- Pool PostgreSQL (Neon) ---
if (!DATABASE_URL) {
  console.error("Falta DATABASE_URL en .env");
  process.exit(1);
}
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requiere SSL
});

// Comprobación de conexión al arrancar
pool
  .connect()
  .then((c) => c.release())
  .then(() => console.log("✅ Conectado a Neon"))
  .catch((err) => {
    console.error("❌ Error conectando a Neon:", err.message);
    process.exit(1);
  });

// --- Rate limit para /api/checkin (por IP) ---
const limiter = new RateLimiterMemory({ points: 10, duration: 5 }); // 10 req / 5s
const rateLimitCheckin = async (req, res, next) => {
  try {
    await limiter.consume(req.ip || req.headers["x-forwarded-for"] || "unknown");
    next();
  } catch {
    res.status(429).json({ ok: false, error: "RATE_LIMITED" });
  }
};

// --- Helpers de auth ---
function getBearer(req) {
  const h = req.headers["authorization"] || "";
  const [, token] = h.split(" ");
  return token || "";
}
function requireAttendant(req, res, next) {
  const token = getBearer(req);
  if (token !== ATTENDANT_TOKEN)
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  next();
}
function requireAdmin(req, res, next) {
  const token = getBearer(req);
  if (token !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  next();
}

// --- Admin: SSE ---
/** @type {Set<import("http").ServerResponse>} */
const sseClients = new Set();
function broadcastSSE(payload) {
  const data = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      /* ignore */
    }
  }
}

// --- API: check-in ---
app.post("/api/checkin", rateLimitCheckin, requireAttendant, async (req, res) => {
  try {
    const { code, via } = req.body || {};
    if (!code || typeof code !== "string") {
      return res.status(400).json({ ok: false, error: "INVALID_CODE" });
    }

    // ¿Duplicado en últimos 10 minutos?
    const dupQ = `
      SELECT EXISTS(
        SELECT 1 FROM scans
        WHERE code = $1 AND ts >= now() - interval '10 minutes'
      ) AS is_dup
    `;
    const dupR = await pool.query(dupQ, [code]);
    const isDuplicate = Boolean(dupR.rows?.[0]?.is_dup);

    // Insertar registro
    const insertQ = `
      INSERT INTO scans (code, via, ip, ua)
      VALUES ($1, $2, $3, $4)
      RETURNING id, code, ts, via, ip, ua
    `;
    const ip = req.ip;
    const ua = req.headers["user-agent"] || "";
    const ins = await pool.query(insertQ, [code, via || "camera", ip, ua]);
    const record = ins.rows[0];

    // Notificar SSE a admin
    broadcastSSE({ type: "scan", data: record, duplicate: isDuplicate });

    return res.json({ ok: true, duplicate: isDuplicate, record });
  } catch (err) {
    console.error("checkin error:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// --- Admin: listado histórico ---
// Soporta ?sinceTs= (epoch ms) y ?code= (exacto)
app.get("/admin/scans", requireAdmin, async (req, res) => {
  try {
    const sinceTs = Number(req.query.sinceTs || 0);
    const code = (req.query.code || "").toString().trim();

    const where = [];
    const params = [];
    let i = 1;

    if (sinceTs && !Number.isNaN(sinceTs)) {
      where.push(`ts >= to_timestamp($${i}/1000.0)`);
      params.push(sinceTs);
      i++;
    }
    if (code) {
      where.push(`code = $${i}`);
      params.push(code);
      i++;
    }

    const q = `
      SELECT id, code, ts, via, ip, ua
      FROM scans
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY id DESC
      LIMIT 1000
    `;
    const r = await pool.query(q, params);
    return res.json({ ok: true, total: r.rowCount, scans: r.rows });
  } catch (err) {
    console.error("admin/scans error:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// --- Admin: SSE stream ---
app.get("/admin/stream", requireAdmin, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

// --- Static (frontend) ---
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Health ---
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// --- Start ---
app.listen(PORT, () => {
  console.log(`QR Check-in escuchando en http://localhost:${PORT}`);
});

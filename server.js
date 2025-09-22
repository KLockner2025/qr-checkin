// Ejecutar con: node server.js
// Variables: ADMIN_TOKEN="xxx" ATTENDANT_TOKEN="yyy" node server.js

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { randomUUID } = require("crypto");
const path = require("path");
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const nowISO = () => new Date().toISOString();

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin123";
const ATTENDANT_TOKEN = process.env.ATTENDANT_TOKEN || "scan123";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "checkins.json");

const app = express();
app.use(cors());
app.use(express.json());

// ---- Persistencia en disco ----
let db = { checkins: [], scans: [] }; // únicos y todos
function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8") || "{}");
      db.checkins = Array.isArray(parsed.checkins) ? parsed.checkins : [];
      db.scans    = Array.isArray(parsed.scans)    ? parsed.scans    : [];
    }
  } catch {
    db = { checkins: [], scans: [] };
  }
}
function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
load();


// ---- SSE (admin en vivo) ----
const clients = new Set();
function broadcast(evt) {
  const data = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(data);
}

// ---- Auth por Bearer ----
function requireBearer(expected) {
  return (req, res, next) => {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    if (token !== expected) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    next();
  };
}

// ---- API AZAFATAS: registrar check-in ----
app.post("/api/checkin", requireBearer(ATTENDANT_TOKEN), async (req, res) => {
  const { eventId, code, attendant, deviceId, scannedAt } = req.body || {};
  if (!eventId || !code) return res.status(400).json({ ok:false, error:"MISSING_FIELDS" });

  const now = new Date();
  const codeStr = String(code);

  // ¿Existe ya en únicos?
  const existing = await prisma.checkin.findUnique({
    where: { eventId_code: { eventId, code: codeStr } } // por @@unique
  });

  // Siempre guardamos el intento en Scan
  await prisma.scan.create({
    data: {
      eventId, code: codeStr, attendant: attendant || null, deviceId: deviceId || null,
      scannedAt: scannedAt ? new Date(scannedAt) : now,
      createdAt: now, isDuplicate: !!existing, firstSeenAt: existing?.createdAt || null
    }
  });

  if (!existing) {
    // Nuevo único
    const row = await prisma.checkin.create({
      data: {
        eventId, code: codeStr, attendant: attendant || null, deviceId: deviceId || null,
        scannedAt: scannedAt ? new Date(scannedAt) : now, createdAt: now
      }
    });
    broadcast({ type: "checkin", payload: row });
    return res.json({ ok:true, duplicate:false, createdAt: row.createdAt });
  }

  // Duplicado
  broadcast({
    type: "duplicate",
    payload: {
      eventId, code: codeStr,
      firstSeenAt: existing.createdAt,
      duplicateAt: nowISO(),
      deviceId: deviceId || null,
    }
  });
  return res.json({ ok:true, duplicate:true, firstSeenAt: existing.createdAt });
});


// ---- ADMIN: únicos (como antes) ----
app.get("/admin/checkins", requireBearer(ADMIN_TOKEN), async (req, res) => {
  const { eventId } = req.query || {};
  const where = eventId ? { eventId: String(eventId) } : {};
  const rows = await prisma.checkin.findMany({
    where, orderBy: [{ createdAt: 'asc' }]
  });
  res.json({ ok:true, rows, total: rows.length });
});

app.get("/admin/scans", requireBearer(ADMIN_TOKEN), async (req, res) => {
  const { eventId } = req.query || {};
  const where = eventId ? { eventId: String(eventId) } : {};
  const rows = await prisma.scan.findMany({
    where, orderBy: [{ createdAt: 'asc' }]
  });
  res.json({ ok:true, rows, total: rows.length });
});


// ---- ADMIN: stream en vivo (SSE) ----
// Nota: EventSource no manda Authorization; por simplicidad no exigimos token aquí.
app.get("/admin/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "hello", ts: nowISO() })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

// ---- Web estática (azafatas + admin) ----
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
  console.log(`Admin token: ${ADMIN_TOKEN} | Attendant token: ${ATTENDANT_TOKEN}`);
});

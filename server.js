import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// ───────────────────────────────────────────────────────────────────────────────
// ENV VARS
// ───────────────────────────────────────────────────────────────────────────────
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID; // <-- required
const ZOOM_WEBHOOK_SECRET_TOKEN = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

// Notion property names (override via env if your DB uses different labels)
const NOTION_TITLE_PROP      = process.env.NOTION_TITLE_PROPERTY      || "Caller";
const NOTION_PHONE_PROP      = process.env.NOTION_PHONE_PROPERTY      || "Phone Number";
const NOTION_DURATION_PROP   = process.env.NOTION_DURATION_PROPERTY   || "Duration";
const NOTION_TYPE_PROP       = process.env.NOTION_TYPE_PROPERTY       || "Type";
const NOTION_DATE_PROP       = process.env.NOTION_DATE_PROPERTY       || "Date";
const NOTION_RECORDING_PROP  = process.env.NOTION_RECORDING_PROPERTY  || "Recording";

// Validate required envs
[
  "NOTION_API_KEY",
  "NOTION_DATABASE_ID",
  "ZOOM_WEBHOOK_SECRET_TOKEN",
  "ZOOM_ACCOUNT_ID",
  "ZOOM_CLIENT_ID",
  "ZOOM_CLIENT_SECRET",
].forEach((key) => {
  if (!process.env[key]) console.error(`❌ Missing env var: ${key}`);
});

// Masked logs (no secrets)
const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "undefined");
console.log(`🗄️ Notion DB: ${mask(NOTION_DATABASE_ID)}`);
console.log(`🔧 Title prop: ${NOTION_TITLE_PROP}`);

// ───────────────────────────────────────────────────────────────────────────────
/** Time helpers for Zoom payloads */
// ───────────────────────────────────────────────────────────────────────────────
function parseZoomTime(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") {
    // handle sec vs ms epochs
    const ms = raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : raw;
    const d = new Date(ms);
    return isNaN(d) ? null : d;
  }
  const d = new Date(raw);
  return isNaN(d) ? null : d;
}
function toISOOrNow(d) {
  return d && !isNaN(d) ? d.toISOString() : new Date().toISOString();
}

// ───────────────────────────────────────────────────────────────────────────────
/** Zoom S2S OAuth token cache */
// ───────────────────────────────────────────────────────────────────────────────
let zoomToken = null;
let zoomTokenExpiry = 0;

async function getZoomAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (zoomToken && now < zoomTokenExpiry) return zoomToken;

  console.log("🔄 Fetching new Zoom access token…");
  const basicAuth = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString("base64");

  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
    { method: "POST", headers: { Authorization: `Basic ${basicAuth}` } }
  );
  const data = await res.json();
  if (!res.ok) {
    console.error("❌ Failed to fetch Zoom token:", data);
    throw new Error("Zoom token fetch failed");
  }

  zoomToken = data.access_token;
  zoomTokenExpiry = now + data.expires_in - 60; // refresh 1 min early
  console.log("✅ Got Zoom access token (expires in", data.expires_in, "sec)");
  return zoomToken;
}

// Fetch host email, fallback to host_id if scopes missing or error
async function getHostEmailOrId(hostId) {
  try {
    const token = await getZoomAccessToken();
    const res = await fetch(`https://api.zoom.us/v2/users/${hostId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("❌ Failed to fetch user:", txt);
      return hostId;
    }
    const user = await res.json();
    return user.email || hostId;
  } catch (err) {
    console.error("🔥 Error fetching host email:", err);
    return hostId;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
/** Notion writer */
// ───────────────────────────────────────────────────────────────────────────────
async function logToNotion(payload) {
  if (!NOTION_DATABASE_ID) {
    console.error("❌ NOTION_DATABASE_ID is missing — cannot write to Notion.");
    return;
  }

  console.log("📝 Logging to Notion:", payload);

  try {
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          [NOTION_TITLE_PROP]: {
            title: [{ text: { content: payload.caller || "Unknown" } }],
          },
          [NOTION_PHONE_PROP]: {
            rich_text: [{ text: { content: payload.phone || "" } }],
          },
          [NOTION_DURATION_PROP]: { number: typeof payload.duration === "number" ? payload.duration : 0 },
          [NOTION_TYPE_PROP]: { select: { name: payload.type } },
          [NOTION_DATE_PROP]: { date: { start: payload.date } },
          ...(payload.recording && { [NOTION_RECORDING_PROP]: { url: payload.recording } }),
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("❌ Failed to write to Notion:", data);
    } else {
      console.log("✅ Notion page created:", data.id);
    }
  } catch (err) {
    console.error("🔥 Error in logToNotion:", err);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
/** Webhook event handler */
// ───────────────────────────────────────────────────────────────────────────────
async function handleEvent(body) {
  const event = body?.event;
  if (!event) return;

  // ── Zoom Phone (both ends)
  if (event === "phone.caller_ended" || event === "phone.callee_ended") {
    const call = body.payload?.object || {};
    // Try multiple possible time fields from Zoom Phone
    const startDate =
      parseZoomTime(call.call_start_time) ||
      parseZoomTime(call.start_time) ||
      parseZoomTime(call.answered_time) ||
      parseZoomTime(call.ring_time) ||
      parseZoomTime(call.end_time) ||
      parseZoomTime(call.timestamp);

    const phonePayload = {
      caller: call.caller_number || call.from || "Unknown",
      phone: call.callee_number || call.to || "",
      duration: typeof call.duration === "number" ? call.duration : 0,
      type: event === "phone.caller_ended" ? "Zoom Phone (caller ended)" : "Zoom Phone (callee ended)",
      date: toISOOrNow(startDate),
      recording: call.recording_url || null,
    };
    await logToNotion(phonePayload);
  }

  // ── Meeting scheduled (optional pre-log to track no-shows)
  if (event === "meeting.created") {
    const mtg = body.payload?.object || {};
    const start = parseZoomTime(mtg.start_time) || parseZoomTime(mtg.created_at);
    const createdPayload = {
      caller: mtg.host_email || mtg.host_id || "Unknown Host",
      phone: String(mtg.id || ""),
      duration: 0,
      type: "Zoom Meeting (scheduled)",
      date: toISOOrNow(start),
      recording: null,
    };
    await logToNotion(createdPayload);
  }

  // ── Meeting ended
  if (event === "meeting.ended") {
    const mtg = body.payload?.object || {};
    const start = parseZoomTime(mtg.start_time);
    const end = parseZoomTime(mtg.end_time);
    const durationMinutes =
      typeof mtg.duration === "number"
        ? mtg.duration
        : start && end
        ? Math.max(0, Math.round((end - start) / 60000))
        : 0;

    let hostName = mtg.host_email;
    if (!hostName && mtg.host_id) hostName = await getHostEmailOrId(mtg.host_id);

    const endedPayload = {
      caller: hostName || "Unknown Host",
      phone: String(mtg.id || ""),
      duration: durationMinutes,
      type: "Zoom Meeting",
      date: toISOOrNow(start),
      recording: mtg.recording_files?.[0]?.download_url || null,
    };
    await logToNotion(endedPayload);
  }

  // ── Cloud recording completed
  if (event === "recording.completed") {
    const rec = body.payload?.object || {};
    const recStart = parseZoomTime(rec.start_time);
    const recPayload = {
      caller: rec.host_email || rec.host_id || "Unknown Host",
      phone: String(rec.id || ""),
      duration: typeof rec.duration === "number" ? rec.duration : 0,
      type: "Zoom Recording",
      date: toISOOrNow(recStart),
      recording: rec.recording_files?.[0]?.download_url || null,
    };
    await logToNotion(recPayload);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
/** Webhook endpoint (with URL validation) */
// ───────────────────────────────────────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  console.log("📩 Received Zoom event:", req.body?.event);

  // URL validation challenge
  if (req.body?.event === "endpoint.url_validation") {
    if (!ZOOM_WEBHOOK_SECRET_TOKEN) {
      console.error("❌ Missing ZOOM_WEBHOOK_SECRET_TOKEN");
      return res.status(500).json({ error: "Server not configured" });
    }
    const plainToken = req.body.payload?.plainToken || "";
    const encryptedToken = crypto
      .createHmac("sha256", ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(plainToken)
      .digest("hex");
    console.log("🔑 URL validation success");
    return res.json({ plainToken, encryptedToken });
  }

  // Ack immediately; handle async
  res.status(200).send("ok");
  handleEvent(req.body).catch((err) => console.error("🔥 Error handling event:", err));
});

// Health & diagnostics
app.get("/ping", (_req, res) => res.send("pong"));
app.get("/env-check", (_req, res) =>
  res.json({
    NOTION_API_KEY: !!process.env.NOTION_API_KEY,
    NOTION_DATABASE_ID: !!process.env.NOTION_DATABASE_ID,
    ZOOM_WEBHOOK_SECRET_TOKEN: !!process.env.ZOOM_WEBHOOK_SECRET_TOKEN,
    ZOOM_ACCOUNT_ID: !!process.env.ZOOM_ACCOUNT_ID,
    ZOOM_CLIENT_ID: !!process.env.ZOOM_CLIENT_ID,
    ZOOM_CLIENT_SECRET: !!process.env.ZOOM_CLIENT_SECRET,
  })
);
app.get("/notion/verify", async (_req, res) => {
  try {
    if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
      return res
        .status(500)
        .json({ ok: false, error: "Missing NOTION_API_KEY or NOTION_DATABASE_ID" });
    }
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}`, {
      headers: { Authorization: `Bearer ${NOTION_API_KEY}`, "Notion-Version": "2022-06-28" },
    });
    const data = await r.json();
    return res.status(r.ok ? 200 : 500).json(data);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));

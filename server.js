import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// 🔑 Env variables
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DATABASE_ID = process.env.NOTION_DATABASE_ID; // <-- correct key
const ZOOM_WEBHOOK_SECRET_TOKEN = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

// 🔤 Notion property names (tweak via env if your DB uses different names)
const NOTION_TITLE_PROP = process.env.NOTION_TITLE_PROPERTY || "Caller";          // safer default than "Caller"
const NOTION_PHONE_PROP = process.env.NOTION_PHONE_PROPERTY || "Phone Number";
const NOTION_DURATION_PROP = process.env.NOTION_DURATION_PROPERTY || "Duration";
const NOTION_TYPE_PROP = process.env.NOTION_TYPE_PROPERTY || "Type";
const NOTION_DATE_PROP = process.env.NOTION_DATE_PROPERTY || "Date";
const NOTION_RECORDING_PROP = process.env.NOTION_RECORDING_PROPERTY || "Recording";

// 🚨 Validate required env vars (use the actual keys)
[
  "NOTION_API_KEY",
  "NOTION_DATABASE_ID",
  "ZOOM_WEBHOOK_SECRET_TOKEN",
  "ZOOM_ACCOUNT_ID",
  "ZOOM_CLIENT_ID",
  "ZOOM_CLIENT_SECRET",
].forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing env var: ${key}`);
  }
});

// Masked logs help confirm values without leaking secrets
const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "undefined");
console.log(`🗄️ Notion DB id: ${mask(DATABASE_ID)}`);

// 🔑 Token cache
let zoomToken = null;
let zoomTokenExpiry = 0;

// ✅ Get (or refresh) Zoom Access Token
async function getZoomAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  if (zoomToken && now < zoomTokenExpiry) return zoomToken;

  console.log("🔄 Fetching new Zoom access token...");
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

// 🔎 Get host email from host_id
async function getHostEmail(hostId) {
  try {
    const token = await getZoomAccessToken();
    const res = await fetch(`https://api.zoom.us/v2/users/${hostId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error("❌ Failed to fetch user:", await res.text());
      return null;
    }

    const user = await res.json();
    return user.email || null;
  } catch (err) {
    console.error("🔥 Error fetching host email:", err);
    return null;
  }
}

// 📝 Write data to Notion
async function logToNotion(callData) {
  if (!DATABASE_ID) {
    console.error("❌ NOTION_DATABASE_ID is missing — cannot write to Notion.");
    return;
  }

  console.log("📝 Logging to Notion:", callData);

  try {
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        parent: { database_id: DATABASE_ID },
        properties: {
          [NOTION_TITLE_PROP]: {
            title: [{ text: { content: callData.caller || "Unknown" } }],
          },
          [NOTION_PHONE_PROP]: {
            rich_text: [{ text: { content: callData.phone || "" } }],
          },
          [NOTION_DURATION_PROP]: { number: callData.duration || 0 },
          [NOTION_TYPE_PROP]: { select: { name: callData.type } },
          [NOTION_DATE_PROP]: { date: { start: callData.date } },
          ...(callData.recording && { [NOTION_RECORDING_PROP]: { url: callData.recording } }),
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

// 🔑 Handle Zoom webhook events
async function handleEvent(body) {
  const event = body.event;

  if (event === "phone.caller_ended") {
    const call = body.payload.object;
    const callData = {
      caller: call.caller_number,
      phone: call.callee_number,
      duration: call.duration,
      type: "Phone Call",
      date: new Date(call.call_start_time).toISOString(),
      recording: call.recording_url || null,
    };
    await logToNotion(callData);
  }

  if (event === "meeting.ended") {
    const meeting = body.payload.object;

    const start = new Date(meeting.start_time);
    const end = new Date(meeting.end_time);
    const durationMinutes = Math.round((end - start) / 60000);

    let hostEmail = meeting.host_email;
    if (!hostEmail && meeting.host_id) {
      hostEmail = await getHostEmail(meeting.host_id);
    }

    const callData = {
      caller: hostEmail || meeting.host_id || "Unknown Host",
      phone: meeting.id,
      duration: durationMinutes,
      type: "Zoom Meeting",
      date: new Date(meeting.start_time).toISOString(),
      recording: meeting.recording_files?.[0]?.download_url || null,
    };
    await logToNotion(callData);
  }

  if (event === "recording.completed") {
    const recording = body.payload.object;
    const callData = {
      caller: recording.host_email || "Unknown Host",
      phone: recording.id,
      duration: recording.duration || 0,
      type: "Zoom Recording",
      date: new Date(recording.start_time).toISOString(),
      recording: recording.recording_files?.[0]?.download_url || null,
    };
    await logToNotion(callData);
  }
}

// 🔑 Zoom Webhook endpoint
app.post("/webhook", (req, res) => {
  console.log("📩 Received Zoom event:", req.body.event);

  // Step 1: Handle URL validation challenge
  if (req.body.event === "endpoint.url_validation") {
    if (!ZOOM_WEBHOOK_SECRET_TOKEN) {
      console.error("❌ Missing ZOOM_WEBHOOK_SECRET_TOKEN");
      return res.status(500).json({ error: "Server not configured" });
    }

    const plainToken = req.body.payload.plainToken;
    const encryptedToken = crypto
      .createHmac("sha256", ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(plainToken)
      .digest("hex");

    console.log("🔑 URL validation success");
    return res.json({ plainToken, encryptedToken });
  }

  // Step 2: Respond fast & handle event async
  res.status(200).send("ok");
  handleEvent(req.body).catch((err) => console.error("🔥 Error handling event:", err));
});

// ✅ Health check
app.get("/ping", (req, res) => res.send("pong"));

// 🧪 Notion verify endpoint (checks DB id & integration access)
app.get("/notion/verify", async (req, res) => {
  try {
    if (!NOTION_API_KEY || !DATABASE_ID) {
      return res.status(500).json({ ok: false, error: "Missing NOTION_API_KEY or NOTION_DATABASE_ID" });
    }
    const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}`, {
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
      },
    });
    const data = await r.json();
    return res.status(r.ok ? 200 : 500).json(data);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));

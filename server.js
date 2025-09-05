import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(bodyParser.json());

// Notion API setup (⚠️ move these to process.env in production)
const NOTION_API_KEY = "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";
const DATABASE_ID = "264c93dbf94180249366e082311d9406";
const ZOOM_WEBHOOK_SECRET_TOKEN = "8PHltp2oTN2464C7mYc8EQ";

// Zoom Server-to-Server OAuth credentials
const ZOOM_ACCOUNT_ID = "lr923HlbTTibOxsrPJuD5Q";
const ZOOM_CLIENT_ID = "qw7mh1_UTR6SzSZuTpryQ";
const ZOOM_CLIENT_SECRET = "NpWYxjyRXJFG58kkdQdbcW5OBI1jvX1r";

// 🔑 Token cache
let zoomToken = null;
let zoomTokenExpiry = 0;

// ✅ Get (or refresh) Zoom Access Token
async function getZoomAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  // Use cached token if still valid
  if (zoomToken && now < zoomTokenExpiry) {
    return zoomToken;
  }

  console.log("🔄 Fetching new Zoom access token...");
  const basicAuth = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString("base64");

  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
      },
    }
  );

  const data = await res.json();

  if (!res.ok) {
    console.error("❌ Failed to fetch Zoom token:", data);
    throw new Error("Zoom token fetch failed");
  }

  zoomToken = data.access_token;
  zoomTokenExpiry = now + data.expires_in - 60; // refresh 1 min before expiry

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
    console.log("📧 Found host email:", user.email);
    return user.email || null;
  } catch (err) {
    console.error("🔥 Error fetching host email:", err);
    return null;
  }
}

// 📝 Write data to Notion
async function logToNotion(callData) {
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
          Caller: { title: [{ text: { content: callData.caller || "Unknown" } }] },
          "Phone Number": {
            rich_text: [{ text: { content: callData.phone || "" } }],
          },
          Duration: { number: callData.duration || 0 },
          Type: { select: { name: callData.type } },
          Date: { date: { start: callData.date } },
          ...(callData.recording && { Recording: { url: callData.recording } }),
        },
      }),
    });

    const data = await response.json();
    console.log("✅ Notion response:", data);

    if (!response.ok) {
      console.error("❌ Failed to write to Notion:", data);
    }
  } catch (err) {
    console.error("🔥 Error in logToNotion:", err);
  }
}

// 🔑 Zoom Webhook handler
app.post("/webhook", async (req, res) => {
  console.log("📩 Received Zoom event:", req.body.event);
  console.log("🔎 Payload:", JSON.stringify(req.body, null, 2));

  // Step 1: Handle URL validation challenge
  if (req.body.event === "endpoint.url_validation") {
    const plainToken = req.body.payload.plainToken;
    const encryptedToken = crypto
      .createHmac("sha256", ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(plainToken)
      .digest("hex");

    console.log("🔑 URL validation success");
    return res.json({ plainToken, encryptedToken });
  }

  // Step 2: Handle real events
  try {
    const event = req.body.event;

    if (event === "phone.caller_ended") {
      const call = req.body.payload.object;
      const callData = {
        caller: call.caller_number,
        phone: call.callee_number,
        duration: call.duration,
        type: "Phone Call",
        date: new Date(call.start_time).toISOString(),
        recording: call.recording_url || null,
      };
      await logToNotion(callData);
    }

    if (event === "meeting.ended") {
      const meeting = req.body.payload.object;

      const start = new Date(meeting.start_time);
      const end = new Date(meeting.end_time);
      const durationMinutes = Math.round((end - start) / 60000);

      // Try to get host email from payload or fallback to API
      let hostEmail = meeting.host_email;
      if (!hostEmail && meeting.host_id) {
        hostEmail = await getHostEmail(meeting.host_id);
      }

      const callData = {
        caller: hostEmail || "Unknown Host",
        phone: meeting.id,
        duration: durationMinutes,
        type: "Zoom Meeting",
        date: new Date(meeting.start_time).toISOString(),
        recording: meeting.recording_files?.[0]?.download_url || null,
      };
      await logToNotion(callData);
    }
  } catch (err) {
    console.error("🔥 Error handling event:", err);
  }

  res.status(200).send("ok");
});

// ✅ Health check endpoint
app.get("/ping", (req, res) => res.send("pong"));

// ✅ Fix PORT assignment
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));

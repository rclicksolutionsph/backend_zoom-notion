import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(bodyParser.json());

// Notion API setup (better to move these to process.env)
const NOTION_API_KEY = "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";
const DATABASE_ID = "264c93dbf94180249366e082311d9406";
const ZOOM_WEBHOOK_SECRET_TOKEN = "8PHltp2oTN2464C7mYc8EQ";

// Function to create a page in Notion
async function logToNotion(callData) {
  console.log("📝 Logging to Notion:", callData);

  try {
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_API_KEY}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        parent: { database_id: DATABASE_ID },
        properties: {
          "Caller": { title: [{ text: { content: callData.caller || "Unknown" } }] },
          "Phone Number": { rich_text: [{ text: { content: callData.phone || "" } }] },
          "Duration": { number: callData.duration || 0 },
          "Type": { select: { name: callData.type } },
          "Date": { date: { start: callData.date } },
          ...(callData.recording && { "Recording": { url: callData.recording } })
        }
      })
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

// 🔑 Handle Zoom URL validation & events
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
    return res.json({
      plainToken,
      encryptedToken,
    });
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
        recording: call.recording_url || null
      };
      await logToNotion(callData);
    }

    if (event === "meeting.ended") {
      const meeting = req.body.payload.object;

      const start = new Date(meeting.start_time);
      const end = new Date(meeting.end_time);
      const durationMinutes = Math.round((end - start) / 60000); // 1 min = 60000 ms

      const callData = {
        caller: meeting.host_email,
        phone: meeting.id,
        duration: durationMinutes,
        type: "Zoom Meeting",
        date: new Date(meeting.start_time).toISOString(),
        recording: meeting.recording_files?.[0]?.download_url || null
      };
      await logToNotion(callData);
    }
  } catch (err) {
    console.error("🔥 Error handling event:", err);
  }

  res.status(200).send("ok");
});

// ✅ Fix PORT assignment
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));

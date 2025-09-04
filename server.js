import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

// Notion API setup
const NOTION_API_KEY = "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";
const DATABASE_ID = "264c93dbf94180249366e082311d9406";

// Function to create a page in Notion
async function logToNotion(callData) {
  await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28"
    },
    body: JSON.stringify({
      parent: { database_id: DATABASE_ID },
      properties: {
        "Caller": { title: [{ text: { content: callData.caller } }] },
        "Phone Number": { rich_text: [{ text: { content: callData.phone } }] },
        "Duration": { number: callData.duration },
        "Type": { select: { name: callData.type } },
        "Date": { date: { start: callData.date } },
        "Recording": callData.recording
          ? { url: callData.recording }
          : undefined
      }
    })
  });
}

// Webhook endpoint for Zoom
app.post("/webhook", async (req, res) => {
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
    const callData = {
      caller: meeting.host_id,
      phone: meeting.id,
      duration: meeting.duration,
      type: "Zoom Meeting",
      date: new Date(meeting.start_time).toISOString(),
      recording: meeting.recording_files?.[0]?.download_url || null
    };
    await logToNotion(callData);
  }

  res.status(200).send("ok");
});

app.listen(3000, () => console.log("Listening on port 3000"));

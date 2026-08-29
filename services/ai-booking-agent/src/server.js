require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const twilio = require("twilio");
const { initDb, listAppointments, logCall } = require("./db");
const { handleConversation } = require("./agent");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = parseInt(process.env.BOOKING_PORT, 10) || 3001;
const PUBLIC_HOSTNAME = process.env.BOOKING_PUBLIC_HOSTNAME || "localhost";

const conversations = new Map();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/appointments", async (req, res) => {
  try {
    const rows = await listAppointments({ date: req.query.date, status: req.query.status });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From || "unknown";

  conversations.set(callSid, { messages: [], callerNumber });

  const connect = twiml.connect();
  const stream = connect.stream({
    url: `wss://${PUBLIC_HOSTNAME}/ws`,
  });
  stream.parameter({ name: "callSid", value: callSid });

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/twilio/status", async (req, res) => {
  const callSid = req.body.CallSid;
  const status = req.body.CallStatus;

  if (status === "completed" || status === "failed" || status === "no-answer") {
    const conv = conversations.get(callSid);
    if (conv && conv.messages.length > 0) {
      try {
        await logCall({
          callSid,
          callerNumber: conv.callerNumber,
          transcript: JSON.stringify(conv.messages),
          outcome: status,
        });
      } catch (err) {
        console.error("Failed to log call:", err.message);
      }
    }
    conversations.delete(callSid);
  }

  res.sendStatus(200);
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let callSid = null;
  let callerNumber = "unknown";

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.event === "start") {
        callSid = msg.start?.customParameters?.callSid;
        const conv = conversations.get(callSid);
        if (conv) {
          callerNumber = conv.callerNumber;
        }
      }

      if (msg.event === "media" && callSid) {
        const conv = conversations.get(callSid);
        if (!conv) return;

        const userText = msg.media?.payload;
        if (!userText) return;

        conv.messages.push({ role: "user", content: userText });

        const reply = await handleConversation(conv.messages, callerNumber, callSid);
        conv.messages.push({ role: "assistant", content: reply });

        ws.send(JSON.stringify({
          event: "media",
          streamSid: msg.streamSid,
          media: { payload: reply },
        }));
      }
    } catch (err) {
      console.error("WebSocket error:", err.message);
    }
  });
});

async function start() {
  await initDb();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Booking Agent listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const twilio = require('twilio');
const { handleUserSpeech, clearSession, truncateSession } = require('./agent');
const { initDb, logCall, listAppointments } = require('./db');

const PORT = process.env.PORT || 3001;
const PUBLIC_HOSTNAME = process.env.PUBLIC_HOSTNAME || `localhost:${PORT}`;
const API_KEY = process.env.BOOKING_API_KEY || '';

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post('/voice', (req, res) => {
  const wsUrl = `wss://${PUBLIC_HOSTNAME}/relay`;
  const businessName = escapeXml(process.env.BUSINESS_NAME || 'unserem Salon');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${wsUrl}"
      welcomeGreeting="Hallo, hier ist der digitale Assistent von ${businessName}. Wie kann ich Ihnen helfen?"
      ttsProvider="google"
      voice="de-DE-Wavenet-F"
      language="de-DE"
      transcriptionProvider="google"
    />
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

app.get('/appointments', requireApiKey, async (req, res) => {
  try {
    res.json(await listAppointments());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/relay') {
    socket.destroy();
    return;
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (authToken) {
    const signature = request.headers['x-twilio-signature'];
    const url = `https://${PUBLIC_HOSTNAME}/relay`;
    if (!signature || !twilio.validateRequest(authToken, signature, url, {})) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  let callSid = null;
  let callerNumber = null;
  let transcriptLog = [];
  let closed = false;
  let processing = Promise.resolve();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    processing = processing.then(async () => {
      if (closed) return;

      switch (msg.type) {
        case 'setup': {
          callSid = msg.callSid;
          callerNumber = msg.from;
          break;
        }

        case 'prompt': {
          const userText = msg.voicePrompt;
          transcriptLog.push(`Anrufer: ${userText}`);

          try {
            const replyText = await handleUserSpeech({
              callSid,
              callerNumber,
              text: userText,
            });
            if (closed) return;
            transcriptLog.push(`Assistent: ${replyText}`);

            ws.send(
              JSON.stringify({
                type: 'text',
                token: replyText,
                last: true,
              })
            );
          } catch (err) {
            if (closed) return;
            console.error('Fehler bei der KI-Antwort:', err);
            ws.send(
              JSON.stringify({
                type: 'text',
                token: 'Entschuldigung, da ist gerade etwas schiefgelaufen. Können Sie das bitte wiederholen?',
                last: true,
              })
            );
          }
          break;
        }

        case 'interrupt': {
          if (callSid && msg.utteranceUntilInterrupt != null) {
            truncateSession(callSid, msg.utteranceUntilInterrupt);
          }
          break;
        }

        default:
          break;
      }
    });
  });

  ws.on('close', () => {
    closed = true;
    processing.then(async () => {
      if (callSid) {
        try {
          await logCall({
            call_sid: callSid,
            caller_number: callerNumber,
            transcript: transcriptLog.join('\n'),
            outcome: 'ended',
          });
        } catch (err) {
          console.error('Fehler beim Speichern des Anrufprotokolls:', err);
        }
        clearSession(callSid);
      }
    });
  });
});

async function start() {
  await initDb();
  server.listen(PORT, () => {
    console.log(`AI Booking Agent laeuft auf Port ${PORT}`);
    console.log(`Twilio Voice Webhook: https://${PUBLIC_HOSTNAME}/voice`);
  });
}

start().catch((err) => {
  console.error('Startfehler:', err);
  process.exit(1);
});

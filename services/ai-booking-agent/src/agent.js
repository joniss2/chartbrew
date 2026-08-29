const OpenAI = require('openai');
const { createAppointment } = require('./db');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'unserem Salon';
const BUSINESS_HOURS = process.env.BUSINESS_HOURS || 'Mo-Fr 9-18 Uhr';
const BUSINESS_SERVICES = process.env.BUSINESS_SERVICES || 'Haarschnitt, Färben, Bart trimmen';

const SYSTEM_PROMPT = `Du bist der freundliche Telefonassistent von ${BUSINESS_NAME}.
Öffnungszeiten: ${BUSINESS_HOURS}.
Angebotene Leistungen: ${BUSINESS_SERVICES}.

Deine Aufgabe: Nimm Terminanfragen entgegen. Frage nach Name, gewünschter Leistung und Wunschtermin (Tag + Uhrzeit).
Sobald du alle drei Informationen hast, rufe die Funktion "book_appointment" auf.
Antworte kurz, natürlich und in ganzen, gesprochenen Sätzen (das wird per Sprachausgabe vorgelesen).
Wenn eine Anfrage außerhalb der Öffnungszeiten liegt, weise freundlich darauf hin und schlage eine Alternative vor.
Wenn der Anrufer etwas fragt, das du nicht beantworten kannst (z.B. Preise, die du nicht kennst), sag ehrlich, dass du das nicht weißt, und biete an, einen Rückruf durch einen Mitarbeiter zu veranlassen.`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description: 'Bucht einen Termin, sobald Name, Leistung und Wunschzeit bekannt sind.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: { type: 'string' },
          service: { type: 'string' },
          requested_time: { type: 'string', description: 'z.B. "Donnerstag 15 Uhr"' },
        },
        required: ['customer_name', 'service', 'requested_time'],
      },
    },
  },
];

const sessions = new Map();

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, [{ role: 'system', content: SYSTEM_PROMPT }]);
  }
  return sessions.get(callSid);
}

function clearSession(callSid) {
  sessions.delete(callSid);
}

async function handleUserSpeech({ callSid, callerNumber, text }) {
  const messages = getSession(callSid);
  messages.push({ role: 'user', content: text });

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages,
    tools,
    tool_choice: 'auto',
  });

  const choice = completion.choices[0];
  const msg = choice.message;

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    messages.push(msg);

    for (const call of msg.tool_calls) {
      if (call.function.name === 'book_appointment') {
        const args = JSON.parse(call.function.arguments);
        await createAppointment({
          caller_number: callerNumber,
          customer_name: args.customer_name,
          service: args.service,
          requested_time: args.requested_time,
        });

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Termin gebucht für ${args.customer_name}, ${args.service}, ${args.requested_time}.`,
        });
      }
    }

    const followUp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
    });
    const finalText = followUp.choices[0].message.content;
    messages.push({ role: 'assistant', content: finalText });
    return finalText;
  }

  messages.push({ role: 'assistant', content: msg.content });
  return msg.content;
}

module.exports = { handleUserSpeech, clearSession };

const OpenAI = require("openai");
const { createAppointment, logCall } = require("./db");

const openai = new OpenAI({ apiKey: process.env.BOOKING_OPENAI_API_KEY });

const BUSINESS_NAME = process.env.BUSINESS_NAME || "My Business";
const BUSINESS_HOURS = process.env.BUSINESS_HOURS || "Mon-Fri 9am-6pm";
const BUSINESS_SERVICES = (process.env.BUSINESS_SERVICES || "General").split(",").map((s) => s.trim());

const SYSTEM_PROMPT = `You are a friendly phone receptionist for "${BUSINESS_NAME}".
Business hours: ${BUSINESS_HOURS}.
Available services: ${BUSINESS_SERVICES.join(", ")}.

Your job:
1. Greet the caller warmly.
2. Ask what service they need.
3. Ask for their preferred date and time.
4. Ask for their name.
5. Confirm the booking details and tell them they will receive a confirmation.

Keep responses short (1-2 sentences) since this is a phone conversation.
When you have all details (service, date/time, name), respond with a JSON block on its own line:
{"action":"book","service":"...","requestedTime":"YYYY-MM-DD HH:mm","customerName":"..."}
followed by a confirmation message to the caller.`;

async function handleConversation(messages, callerNumber, callSid) {
  const chatMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages,
  ];

  const completion = await openai.chat.completions.create({
    model: process.env.BOOKING_OPENAI_MODEL || "gpt-4o-mini",
    messages: chatMessages,
    temperature: 0.7,
    max_tokens: 300,
  });

  const reply = completion.choices[0].message.content;

  const jsonMatch = reply.match(/\{[\s]*"action"\s*:\s*"book".*\}/);
  if (jsonMatch) {
    try {
      const booking = JSON.parse(jsonMatch[0]);
      await createAppointment({
        callerNumber,
        customerName: booking.customerName,
        service: booking.service,
        requestedTime: booking.requestedTime,
      });
      await logCall({
        callSid,
        callerNumber,
        transcript: JSON.stringify(messages),
        outcome: "booked",
      });
    } catch (err) {
      console.error("Failed to save booking:", err.message);
      return "I'm sorry, there was a problem saving your appointment. Please try calling again or contact us directly.";
    }
  }

  return reply.replace(/\{[\s]*"action"\s*:\s*"book".*\}/, "").trim();
}

module.exports = { handleConversation };

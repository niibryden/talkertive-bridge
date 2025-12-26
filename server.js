import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import OpenAI from 'openai';
import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Talkertive Bridge Server (Bespoke Metal Prints aligned)
 * - Railway healthcheck hardened (plain-text /health + explicit bind)
 * - n8n webhook payload aligned to your n8n Webhook node output:
 *   $json.body.eventType, $json.body.customerName, etc (NO double-nesting)
 */

// ============= SECURITY: Credential Sanitization =============
function sanitizeForLog(obj) {
  if (typeof obj === 'string') {
    return obj
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***REDACTED***')
      .replace(/sk-proj-[a-zA-Z0-9_-]{20,}/g, 'sk-proj-***REDACTED***')
      .replace(/AC[a-z0-9]{32}/g, 'AC***REDACTED***')
      .replace(/[a-f0-9]{32}/g, '***REDACTED***')
      .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer ***REDACTED***')
      .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, 'JWT***REDACTED***');
  }
  if (typeof obj === 'object' && obj !== null) {
    if (obj instanceof Error) {
      return {
        name: obj.name,
        message: sanitizeForLog(obj.message),
        stack: '***STACK_REDACTED***',
      };
    }
    const sanitized = {};
    for (const key in obj) {
      const lowerKey = key.toLowerCase();
      if (
        ['apikey', 'api_key', 'token', 'password', 'secret', 'auth', 'bearer', 'key', 'sid', 'credential'].some((k) =>
          lowerKey.includes(k),
        )
      ) {
        sanitized[key] = '***REDACTED***';
      } else {
        sanitized[key] = sanitizeForLog(obj[key]);
      }
    }
    return sanitized;
  }
  return obj;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

console.log('🔒 SECURITY TEST:');
console.log('Test:', sanitizeForLog('Key: sk-1234567890abcdefghij'));
console.log('');

const requiredEnvVars = ['OPENAI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PORT'];

console.log('🔧 Environment Check:');
requiredEnvVars.forEach((varName) => {
  const exists = !!process.env[varName];
  console.log(`  ${exists ? '✅' : '❌'} ${varName}: ${exists ? 'Configured' : 'MISSING'}`);
});

// Optional environment variables
const optionalEnvVars = ['N8N_WEBHOOK_URL', 'TWILIO_PHONE_NUMBER'];
optionalEnvVars.forEach((varName) => {
  const exists = !!process.env[varName];
  console.log(`  ${exists ? '✅' : '⚠️'} ${varName}: ${exists ? 'Configured' : 'Optional - not set'}`);
});
console.log('');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const PORT = process.env.PORT || 3000;
const activeSessions = new Map();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// ✅ Railway healthcheck: keep it dead simple + fast
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Optional richer health endpoint for humans
app.get('/healthz', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'talkertive-websocket-bridge',
    version: '2.2.1',
    features: ['sms', 'n8n-webhook', 'order-lookup', 'real-time-lead-capture', 'appointment-booking'],
    activeSessions: activeSessions.size,
    timestamp: new Date().toISOString(),
  });
});

async function getUserSettingsByPhone(phoneNumber) {
  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 FETCHING USER SETTINGS');
    console.log('📞 Looking up phone:', phoneNumber);

    const response = await fetch(
      process.env.SUPABASE_URL + '/functions/v1/make-server-4e1c9511/settings/by-phone/' + encodeURIComponent(phoneNumber),
      {
        headers: {
          Authorization: 'Bearer ' + process.env.SUPABASE_ANON_KEY,
        },
      },
    );

    console.log('📡 Response status:', response.status, response.statusText);

    if (response.ok) {
      const data = await response.json();
      console.log('✅ SUCCESS - Settings found!');
      console.log('📋 Business Name:', data.settings?.businessName || '(not set)');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      return data.settings || null;
    } else {
      console.log('❌ FAILED - No settings found');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      return null;
    }
  } catch (error) {
    console.error('❌ ERROR fetching user settings');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return null;
  }
}

// ============= SMS Helper Function =============
async function sendSMS(toNumber, message) {
  if (!process.env.TWILIO_PHONE_NUMBER) {
    console.log('⚠️ SMS not sent - TWILIO_PHONE_NUMBER not configured');
    return { success: false, reason: 'not_configured' };
  }

  try {
    console.log('📱 SENDING SMS');
    console.log('   To:', toNumber);
    console.log('   Message:', message);

    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: toNumber,
    });

    console.log('✅ SMS sent successfully! SID:', result.sid);
    return { success: true, sid: result.sid };
  } catch (error) {
    console.error('❌ SMS failed:', error.message);
    return { success: false, error: error.message };
  }
}

// ============= n8n Webhook Helper (payload aligned to your n8n node) =============
async function triggerN8nWebhook(eventType, data) {
  if (!process.env.N8N_WEBHOOK_URL) {
    console.log('⚠️ n8n webhook not triggered - N8N_WEBHOOK_URL not configured');
    return { success: false, reason: 'not_configured' };
  }

  try {
    console.log('🔔 TRIGGERING N8N WEBHOOK');
    console.log('   Event Type:', eventType);
    console.log('   Data:', sanitizeForLog(data));

    // ✅ MATCHES your n8n webhook input: $json.body.eventType, etc.
    const payload = {
      eventType,
      ...data,
      timestamp: data?.timestamp || new Date().toISOString(),
    };

    console.log('📦 Sending payload:', sanitizeForLog(payload));

    const response = await fetch(process.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    const asJson = safeJsonParse(text);

    if (response.ok) {
      console.log('✅ n8n webhook triggered successfully!');
      if (asJson) console.log('📨 Response (json):', asJson);
      else console.log('📨 Response (text):', text);
      return { success: true, response: asJson ?? text };
    } else {
      console.error('❌ n8n webhook failed:', response.status, text);
      return { success: false, status: response.status, error: text };
    }
  } catch (error) {
    console.error('❌ n8n webhook error:', error.message);
    return { success: false, error: error.message };
  }
}

function buildAIInstructions(userSettings) {
  const businessName = userSettings?.businessName || 'the business';
  const businessHours = userSettings?.businessHours || 'standard business hours';
  const customInstructions = userSettings?.aiPrompt || '';

  console.log('🤖 BUILDING AI INSTRUCTIONS:');
  console.log('   Business Name: "' + businessName + '"');

  let instructions = '═══════════════════════════════════════════════════════\n';
  instructions += '🎯 CRITICAL: SPEAK LIKE A REAL HUMAN RECEPTIONIST\n';
  instructions += '═══════════════════════════════════════════════════════\n\n';

  instructions += 'You are Krystle, a warm, friendly receptionist for ' + businessName + '.\n';
  instructions += 'Business Hours: ' + businessHours + '\n\n';

  if (customInstructions) {
    instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    instructions += 'BUSINESS INFORMATION:\n' + customInstructions + '\n\n';
    instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  }

  instructions += 'GREETING (USE THIS EXACTLY):\n';
  instructions += '"Hi! Thank you for calling ' + businessName + ' today. My name is Krystle, how can I help you?"\n\n';

  instructions += 'LEAD CAPTURE:\n';
  instructions += '- Ask for SMS consent: "Can I send you updates via text message?"\n';
  instructions += '- Call capture_lead_info immediately when you get new info.\n\n';

  instructions += 'APPOINTMENT BOOKING:\n';
  instructions += '- Ask "Can I send you a confirmation text?" before booking.\n';
  instructions += '- Only accept appointments within the next 14 days.\n';
  instructions += '- Today is: ' + new Date().toISOString().split('T')[0] + '\n';
  instructions +=
    '- Maximum booking date: ' + new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] + '\n\n';

  instructions += 'REMEMBER: You’re Krystle - be warm, natural, and helpful.\n';

  return instructions;
}

// Define function tools for OpenAI
const FUNCTION_TOOLS = [
  {
    type: 'function',
    name: 'capture_lead_info',
    description: 'Capture customer information in real-time during the conversation. Ask for SMS consent first, then capture.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Customer's full name" },
        email: { type: 'string', description: "Customer's email address" },
        phone: { type: 'string', description: "Customer's phone number (if different from caller ID)" },
        notes: { type: 'string', description: 'Any important notes about what the customer needs or is asking about' },
        smsConsent: { type: 'boolean', description: 'Whether customer consented to receive SMS messages.' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'book_appointment',
    description: 'Book an appointment for the customer. Ask for SMS consent first.',
    parameters: {
      type: 'object',
      properties: {
        customerName: { type: 'string', description: "Customer's full name" },
        customerEmail: { type: 'string', description: "Customer's email address" },
        customerPhone: { type: 'string', description: "Customer's phone number" },
        smsConsent: { type: 'boolean', description: 'SMS consent (ask first)' },
        dateTime: { type: 'string', description: 'ISO 8601 datetime' },
        duration: { type: 'number', description: 'Duration in minutes' },
        purpose: { type: 'string', description: 'Purpose of appointment' },
        timeZone: { type: 'string', description: 'IANA timezone like America/New_York' },
      },
      required: ['customerName', 'dateTime', 'purpose'],
    },
  },
  {
    type: 'function',
    name: 'lookup_order_status',
    description: "Look up the status of a customer's order when they provide an order ID.",
    parameters: {
      type: 'object',
      properties: { orderId: { type: 'string', description: 'Order ID (e.g., ORD-12345 or 12345)' } },
      required: ['orderId'],
    },
  },
];

app.post('/incoming-call', async (req, res) => {
  console.log('📞 INCOMING CALL');

  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;

  console.log('   From:', from);
  console.log('   To:', to);

  const twiml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Response>\n' +
    '  <Connect>\n' +
    '    <Stream url="wss://' +
    req.headers.host +
    '/media-stream">\n' +
    '      <Parameter name="callSid" value="' +
    callSid +
    '" />\n' +
    '      <Parameter name="from" value="' +
    from +
    '" />\n' +
    '      <Parameter name="to" value="' +
    to +
    '" />\n' +
    '    </Stream>\n' +
    '  </Connect>\n' +
    '</Response>';

  res.type('text/xml');
  res.send(twiml);
});

wss.on('connection', async (ws) => {
  console.log('🔌 NEW WEBSOCKET CONNECTION');

  const sessionId = uuidv4();
  let callSid = null;
  let streamSid = null;
  let openaiWs = null;
  let toPhoneNumber = null;
  let fromPhoneNumber = null;
  let userSettings = null;
  let userId = null;
  let callStartTime = new Date();

  let webhookSent = false;

  let capturedLeadInfo = { name: null, email: null, phone: null, notes: null, smsConsent: false };
  let appointmentBooked = false;
  let appointmentDetails = null;

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message.toString());

      switch (msg.event) {
        case 'start': {
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;

          const customParams = msg.start.customParameters;
          toPhoneNumber = customParams?.to || msg.start.to;
          fromPhoneNumber = customParams?.from || msg.start.from;

          console.log('📞 CALL STARTED');
          console.log('   To Phone:', toPhoneNumber);
          console.log('   From Phone:', fromPhoneNumber);
          console.log('   Call SID:', callSid);

          userSettings = await getUserSettingsByPhone(toPhoneNumber);
          userId = userSettings?.userId;

          await initializeOpenAI(userSettings);
          break;
        }

        case 'media': {
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
          }
          break;
        }

        case 'stop': {
          console.log('📞 CALL ENDED');

          if (webhookSent) {
            console.log('⚠️ Webhook already sent for this call - skipping duplicate');
            break;
          }
          webhookSent = true;

          const durationSeconds = Math.floor((new Date() - callStartTime) / 1000);
          const hasLeadInfo = !!(capturedLeadInfo.name || capturedLeadInfo.email);

          const base = {
            appointmentId: appointmentDetails?.appointmentId,
            userId: userId || undefined,
            customerName: (appointmentDetails?.customerName || capturedLeadInfo.name) || undefined,
            customerEmail: (appointmentDetails?.customerEmail || capturedLeadInfo.email) || undefined,
            customerPhone: (appointmentDetails?.customerPhone || capturedLeadInfo.phone || fromPhoneNumber) || undefined,
            purpose: appointmentDetails?.purpose || undefined,
            duration: appointmentDetails?.duration || durationSeconds || 0,
            timeZone: appointmentDetails?.timeZone || 'America/New_York',
            googleCalendarEventCreated: false,
            callSid: callSid || undefined,
          };

          if (appointmentBooked && appointmentDetails?.dateTime) {
            await triggerN8nWebhook('appointment_booked', {
              ...base,
              appointmentDate: new Date(appointmentDetails.dateTime).toISOString(),
              appointmentTime: appointmentDetails.appointmentTime || undefined,
              appointmentDateTime: appointmentDetails.appointmentDateTime || undefined,
              smsConsent: !!appointmentDetails.smsConsent,
            });
          } else if (hasLeadInfo) {
            await triggerN8nWebhook('lead_captured', {
              ...base,
              summary: capturedLeadInfo.notes || 'No summary provided',
              smsConsent: !!capturedLeadInfo.smsConsent,
            });
          } else {
            await triggerN8nWebhook('call_completed', { ...base, duration: durationSeconds });
          }

          if (openaiWs) openaiWs.close();
          break;
        }
      }
    } catch (error) {
      console.error('❌ Error:', sanitizeForLog(error));
    }
  });

  async function handleFunctionCall(functionName, functionArgs) {
    console.log('🔧 FUNCTION CALL:', functionName);
    console.log('📋 Args:', sanitizeForLog(functionArgs));

    if (functionName === 'capture_lead_info') {
      if (functionArgs.name) capturedLeadInfo.name = functionArgs.name;
      if (functionArgs.email) capturedLeadInfo.email = functionArgs.email;
      if (functionArgs.phone) capturedLeadInfo.phone = functionArgs.phone;
      if (functionArgs.notes) capturedLeadInfo.notes = capturedLeadInfo.notes ? capturedLeadInfo.notes + '\n' + functionArgs.notes : functionArgs.notes;
      if (functionArgs.smsConsent !== undefined) capturedLeadInfo.smsConsent = functionArgs.smsConsent;

      const customerPhone = capturedLeadInfo.phone || fromPhoneNumber;
      const customerName = capturedLeadInfo.name || 'there';
      const businessName = userSettings?.businessName || 'us';

      if (customerPhone && capturedLeadInfo.smsConsent) {
        const smsMessage = `Hi ${customerName}! Thanks for calling ${businessName}. We’ve got your info and will follow up shortly.`;
        await sendSMS(customerPhone, smsMessage);
      }

      return JSON.stringify({ success: true, message: 'Lead information captured successfully.' });
    }

    if (functionName === 'book_appointment') {
      appointmentBooked = true;
      appointmentDetails = functionArgs;

      const customerName = functionArgs.customerName || capturedLeadInfo.name;
      const customerPhone = functionArgs.customerPhone || capturedLeadInfo.phone || fromPhoneNumber;

      if (customerPhone && functionArgs.smsConsent) {
        const businessName = userSettings?.businessName || 'us';
        const appointmentTime = new Date(functionArgs.dateTime).toLocaleString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: functionArgs.timeZone || 'America/New_York',
        });

        const smsMessage = `Hi ${customerName}! Your appointment with ${businessName} is confirmed for ${appointmentTime}.`;
        await sendSMS(customerPhone, smsMessage);
      }

      return JSON.stringify({ success: true, message: 'Appointment booked successfully.' });
    }

    if (functionName === 'lookup_order_status') {
      let cleanOrderId = functionArgs.orderId.toString().trim().toUpperCase();
      cleanOrderId = cleanOrderId.replace(/^#/, '');

      try {
        const response = await fetch(process.env.SUPABASE_URL + '/functions/v1/make-server-4e1c9511/orders/lookup/' + encodeURIComponent(cleanOrderId), {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + process.env.SUPABASE_ANON_KEY },
        });

        if (response.ok) {
          const result = await response.json();
          const order = result.order;
          return JSON.stringify({ success: true, message: `Your order ${order.orderId} is currently ${order.status}.`, order });
        }
        return JSON.stringify({ success: false, message: `I couldn't find an order with ID ${cleanOrderId}.` });
      } catch (err) {
        return JSON.stringify({ success: false, message: 'Trouble looking that up right now.' });
      }
    }

    return JSON.stringify({ success: false, message: 'Unknown function' });
  }

  async function initializeOpenAI(settings) {
    try {
      openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
        headers: {
          Authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      openaiWs.on('open', () => {
        const instructions = buildAIInstructions(settings);

        openaiWs.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions,
              voice: 'shimmer',
              input_audio_format: 'g711_ulaw',
              output_audio_format: 'g711_ulaw',
              input_audio_transcription: { model: 'whisper-1' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1500 },
              temperature: 1.0,
              max_response_output_tokens: 800,
              tools: FUNCTION_TOOLS,
            },
          }),
        );
      });

      openaiWs.on('message', async (data) => {
        try {
          const event = JSON.parse(data.toString());

          if (event.type === 'session.updated') openaiWs.send(JSON.stringify({ type: 'response.create' }));

          if (event.type === 'response.audio.delta' && event.delta) {
            ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
          }

          if (event.type === 'response.function_call_arguments.done') {
            const result = await handleFunctionCall(event.name, JSON.parse(event.arguments));

            openaiWs.send(
              JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'function_call_output', call_id: event.call_id, output: result },
              }),
            );

            openaiWs.send(JSON.stringify({ type: 'response.create' }));
          }
        } catch (err) {
          console.error('❌ Error processing OpenAI message:', sanitizeForLog(err));
        }
      });
    } catch (err) {
      console.error('❌ Failed to connect:', sanitizeForLog(err));
    }
  }

  ws.on('close', () => {
    if (openaiWs) openaiWs.close();
  });

  activeSessions.set(sessionId, { callSid });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🚀 Talkertive WebSocket Bridge Server v2.2.1');
  console.log('📡 Listening on:', `0.0.0.0:${PORT}`);
  console.log('📱 SMS Status:', process.env.TWILIO_PHONE_NUMBER ? 'Enabled' : 'Disabled (set TWILIO_PHONE_NUMBER)');
  console.log('🔔 n8n Webhook:', process.env.N8N_WEBHOOK_URL ? 'Enabled' : 'Disabled (set N8N_WEBHOOK_URL)');
  console.log('');
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  server.close(() => process.exit(0));
});

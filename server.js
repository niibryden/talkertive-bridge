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

// ============= SECURITY: Credential Sanitization =============
function sanitizeForLog(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***REDACTED***')
      .replace(/sk-proj-[a-zA-Z0-9_-]{20,}/g, 'sk-proj-***REDACTED***')
      .replace(/AC[a-z0-9]{32}/gi, 'AC***REDACTED***')
      .replace(/[a-f0-9]{32}/gi, '***REDACTED***')
      .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer ***REDACTED***')
      .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, 'JWT***REDACTED***');
  }
  if (typeof obj === 'object' && obj !== null) {
    if (obj instanceof Error) {
      return { name: obj.name, message: sanitizeForLog(obj.message), stack: '***STACK_REDACTED***' };
    }
    const sanitized = Array.isArray(obj) ? [] : {};
    for (const key in obj) {
      const lowerKey = key.toLowerCase();
      if (['apikey', 'api_key', 'token', 'password', 'secret', 'auth', 'bearer', 'key', 'sid', 'credential'].some(k => lowerKey.includes(k))) {
        sanitized[key] = '***REDACTED***';
      } else {
        sanitized[key] = sanitizeForLog(obj[key]);
      }
    }
    return sanitized;
  }
  return obj;
}

const requiredEnvVars = [
  'OPENAI_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'PORT'
];

console.log('🔧 Environment Check:');
requiredEnvVars.forEach(varName => {
  const exists = !!process.env[varName];
  console.log(`  ${exists ? '✅' : '❌'} ${varName}: ${exists ? 'Configured' : 'MISSING'}`);
});
const optionalEnvVars = ['N8N_WEBHOOK_URL', 'TWILIO_PHONE_NUMBER'];
optionalEnvVars.forEach(varName => {
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

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'talkertive-websocket-bridge',
    version: '2.3.0-bmp-n8n-aligned',
    features: ['sms', 'n8n-webhook', 'order-lookup', 'real-time-lead-capture', 'appointment-booking'],
    activeSessions: activeSessions.size,
    timestamp: new Date().toISOString()
  });
});

async function getUserSettingsByPhone(phoneNumber) {
  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 FETCHING USER SETTINGS');
    console.log('📞 Looking up phone:', phoneNumber);

    const response = await fetch(
      process.env.SUPABASE_URL +
        '/functions/v1/make-server-4e1c9511/settings/by-phone/' +
        encodeURIComponent(phoneNumber),
      { headers: { Authorization: 'Bearer ' + process.env.SUPABASE_ANON_KEY } }
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

// ============= SMS Helper Function (Bespoke Metal Prints branded) =============
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
      to: toNumber
    });

    console.log('✅ SMS sent successfully! SID:', result.sid);
    return { success: true, sid: result.sid };
  } catch (error) {
    console.error('❌ SMS failed:', error.message);
    return { success: false, error: error.message };
  }
}

// ============= FIXED: n8n Webhook Helper Function (matches your webhook output JSON) =============
// Your n8n Webhook node shows fields at: $json.body.eventType, $json.body.customerEmail, etc.
// That means the POST body from this server MUST be a flat JSON object with those keys.
async function triggerN8nWebhook(eventType, data) {
  if (!process.env.N8N_WEBHOOK_URL) {
    console.log('⚠️ n8n webhook not triggered - N8N_WEBHOOK_URL not configured');
    return { success: false, reason: 'not_configured' };
  }

  try {
    console.log('🔔 TRIGGERING N8N WEBHOOK');
    console.log('   Event Type:', eventType);
    console.log('   Data:', sanitizeForLog(data));

    const payload = {
      eventType,
      ...data,
      timestamp: data?.timestamp || new Date().toISOString()
    };

    console.log('📦 Sending payload:', sanitizeForLog(payload));

    const response = await fetch(process.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }

    if (response.ok) {
      console.log('✅ n8n webhook triggered successfully!');
      console.log('📨 Response:', sanitizeForLog(parsed));
      return { success: true, response: parsed };
    } else {
      console.error('❌ n8n webhook failed:', response.status, sanitizeForLog(parsed));
      return { success: false, status: response.status, error: parsed };
    }
  } catch (error) {
    console.error('❌ n8n webhook error:', error.message);
    return { success: false, error: error.message };
  }
}

function buildAIInstructions(userSettings) {
  const businessName = userSettings?.businessName || 'Bespoke Metal Prints';
  const businessHours = userSettings?.businessHours || 'standard business hours';
  const customInstructions = userSettings?.aiPrompt || '';

  console.log('🤖 BUILDING AI INSTRUCTIONS:');
  console.log('   Business Name: "' + businessName + '"');

  let instructions = '═══════════════════════════════════════════════════════\\n';
  instructions += '🎯 CRITICAL: SPEAK LIKE A REAL HUMAN RECEPTIONIST\\n';
  instructions += '═══════════════════════════════════════════════════════\\n\\n';

  instructions += 'You are Krystle, a warm, friendly receptionist for ' + businessName + '.\\n';
  instructions += 'Business Hours: ' + businessHours + '\\n\\n';

  if (customInstructions) {
    instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\n';
    instructions += 'BUSINESS INFORMATION:\\n' + customInstructions + '\\n\\n';
    instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\n\\n';
  }

  instructions += 'GREETING (USE THIS EXACTLY):\\n';
  instructions += '\"Hi! Thank you for calling ' + businessName + ' today. My name is Krystle, how can I help you?\"\\n\\n';

  instructions += 'LEAD CAPTURE:\\n';
  instructions += '- Ask for SMS consent: \"Can I send you updates via text message?\"\\n';
  instructions += '- Call capture_lead_info immediately when you get new info.\\n\\n';

  instructions += 'APPOINTMENT BOOKING:\\n';
  instructions += '- Ask: \"Can I send you a confirmation text?\" before setting smsConsent.\\n';
  instructions += '- Only accept appointments within the next 14 days.\\n\\n';

  instructions += 'REMEMBER: You\\'re Krystle - be warm, natural, and helpful.\\n';
  return instructions;
}

const FUNCTION_TOOLS = [
  {
    type: 'function',
    name: 'capture_lead_info',
    description: 'Capture customer information. Ask for SMS consent first.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        notes: { type: 'string' },
        smsConsent: { type: 'boolean' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'book_appointment',
    description: 'Book an appointment. Ask for SMS consent first.',
    parameters: {
      type: 'object',
      properties: {
        customerName: { type: 'string' },
        customerEmail: { type: 'string' },
        customerPhone: { type: 'string' },
        smsConsent: { type: 'boolean' },
        dateTime: { type: 'string' },
        duration: { type: 'number' },
        purpose: { type: 'string' },
        timeZone: { type: 'string' }
      },
      required: ['customerName', 'dateTime', 'purpose']
    }
  },
  {
    type: 'function',
    name: 'lookup_order_status',
    description: 'Look up the status of an order.',
    parameters: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId']
    }
  }
];

app.post('/incoming-call', async (req, res) => {
  console.log('📞 INCOMING CALL');
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;

  const twiml =
    '<?xml version="1.0" encoding="UTF-8"?>\\n' +
    '<Response>\\n' +
    '  <Connect>\\n' +
    '    <Stream url="wss://' +
    req.headers.host +
    '/media-stream">\\n' +
    '      <Parameter name="callSid" value="' +
    callSid +
    '" />\\n' +
    '      <Parameter name="from" value="' +
    from +
    '" />\\n' +
    '      <Parameter name="to" value="' +
    to +
    '" />\\n' +
    '    </Stream>\\n' +
    '  </Connect>\\n' +
    '</Response>';

  res.type('text/xml');
  res.send(twiml);
});

wss.on('connection', async (ws, req) => {
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

  ws.on('message', async message => {
    try {
      const msg = JSON.parse(message.toString());

      switch (msg.event) {
        case 'start': {
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;

          const customParams = msg.start.customParameters;
          toPhoneNumber = customParams?.to || msg.start.to;
          fromPhoneNumber = customParams?.from || msg.start.from;

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
          if (webhookSent) break;
          webhookSent = true;

          const callDurationSeconds = Math.floor((new Date() - callStartTime) / 1000);
          const hasLeadInfo = !!(capturedLeadInfo.name || capturedLeadInfo.email);

          const base = {
            callSid,
            userId: userId || null,
            timeZone: 'America/New_York',
            timestamp: new Date().toISOString(),
            callDurationSeconds
          };

          if (appointmentBooked && appointmentDetails) {
            const customerName = appointmentDetails.customerName || capturedLeadInfo.name || 'Customer';
            const customerEmail = appointmentDetails.customerEmail || capturedLeadInfo.email || '';
            const customerPhone = appointmentDetails.customerPhone || capturedLeadInfo.phone || fromPhoneNumber || '';
            const appointmentDateISO = new Date(appointmentDetails.dateTime).toISOString();

            await triggerN8nWebhook('appointment_booked', {
              ...base,
              appointmentId: appointmentDetails.appointmentId || appointmentDetails.id || null,
              customerName,
              customerEmail,
              customerPhone,
              appointmentDate: appointmentDateISO,
              appointmentTime: appointmentDetails.appointmentTime || null,
              appointmentDateTime: appointmentDetails.appointmentDateTime || null,
              purpose: appointmentDetails.purpose || 'Consultation',
              duration: appointmentDetails.duration || 30,
              googleCalendarEventCreated: false
            });
          } else if (hasLeadInfo) {
            await triggerN8nWebhook('lead_captured', {
              ...base,
              appointmentId: null,
              customerName: capturedLeadInfo.name || 'Customer',
              customerEmail: capturedLeadInfo.email || '',
              customerPhone: capturedLeadInfo.phone || fromPhoneNumber || '',
              appointmentDate: null,
              appointmentTime: null,
              appointmentDateTime: null,
              purpose: capturedLeadInfo.notes || 'Lead captured',
              duration: null,
              googleCalendarEventCreated: false
            });
          } else {
            await triggerN8nWebhook('call_completed', {
              ...base,
              appointmentId: null,
              customerName: null,
              customerEmail: null,
              customerPhone: fromPhoneNumber || null,
              appointmentDate: null,
              appointmentTime: null,
              appointmentDateTime: null,
              purpose: 'Call completed',
              duration: null,
              googleCalendarEventCreated: false
            });
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
    if (functionName === 'capture_lead_info') {
      if (functionArgs.name) capturedLeadInfo.name = functionArgs.name;
      if (functionArgs.email) capturedLeadInfo.email = functionArgs.email;
      if (functionArgs.phone) capturedLeadInfo.phone = functionArgs.phone;
      if (functionArgs.notes) capturedLeadInfo.notes = functionArgs.notes;
      if (functionArgs.smsConsent !== undefined) capturedLeadInfo.smsConsent = functionArgs.smsConsent;

      const customerPhone = capturedLeadInfo.phone || fromPhoneNumber;
      const customerName = capturedLeadInfo.name || 'there';
      if (customerPhone && capturedLeadInfo.smsConsent) {
        const smsMessage =
          `Hi ${customerName}! Thanks for contacting Bespoke Metal Prints. ` +
          `We received your request and will follow up shortly. — bespokemetalprints.com`;
        await sendSMS(customerPhone, smsMessage);
      }

      return JSON.stringify({ success: true, message: 'Lead captured.' });
    }

    if (functionName === 'book_appointment') {
      appointmentBooked = true;
      appointmentDetails = functionArgs;

      const customerName = functionArgs.customerName || capturedLeadInfo.name || 'Customer';
      const customerPhone = functionArgs.customerPhone || capturedLeadInfo.phone || fromPhoneNumber;

      if (customerPhone && functionArgs.smsConsent) {
        const appointmentTime = new Date(functionArgs.dateTime).toLocaleString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: functionArgs.timeZone || 'America/New_York'
        });

        const smsMessage =
          `Hi ${customerName}! Your Bespoke Metal Prints consultation is confirmed for ${appointmentTime}. ` +
          `You’ll also receive an email with your meeting link. — bespokemetalprints.com`;
        await sendSMS(customerPhone, smsMessage);
      }

      return JSON.stringify({ success: true, message: 'Appointment booked.' });
    }

    return JSON.stringify({ success: false, message: 'Unknown function' });
  }

  async function initializeOpenAI(settings) {
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        Authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
        'OpenAI-Beta': 'realtime=v1'
      }
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
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 1500
            },
            temperature: 1.0,
            max_response_output_tokens: 800,
            tools: FUNCTION_TOOLS
          }
        })
      );
    });

    openaiWs.on('message', async data => {
      const event = JSON.parse(data.toString());

      if (event.type === 'session.updated') {
        openaiWs.send(JSON.stringify({ type: 'response.create' }));
      }

      if (event.type === 'response.audio.delta' && event.delta) {
        ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
      }

      if (event.type === 'response.function_call_arguments.done') {
        const functionName = event.name;
        const functionArgs = JSON.parse(event.arguments);

        const result = await handleFunctionCall(functionName, functionArgs);

        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: event.call_id, output: result }
          })
        );

        openaiWs.send(JSON.stringify({ type: 'response.create' }));
      }
    });
  }

  ws.on('close', () => {
    if (openaiWs) openaiWs.close();
  });
});

server.listen(PORT, () => {
  console.log('🚀 Talkertive WebSocket Bridge Server (BMP / n8n aligned)');
  console.log('📡 Port:', PORT);
  console.log('📱 SMS Status:', process.env.TWILIO_PHONE_NUMBER ? 'Enabled' : 'Disabled (set TWILIO_PHONE_NUMBER)');
  console.log('🔔 n8n Webhook:', process.env.N8N_WEBHOOK_URL ? 'Enabled' : 'Disabled (set N8N_WEBHOOK_URL)');
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  server.close(() => process.exit(0));
});

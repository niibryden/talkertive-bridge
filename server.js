/**
 * Talkertive WebSocket Bridge Server (server.js)
 * - Twilio <Stream> media websocket bridge to OpenAI Realtime
 * - Lead capture + appointment booking + order lookup
 * - Emits clean, flat JSON webhook payloads to n8n
 *
 * Key fixes in this version:
 *  1) NEVER emits eventType="appointment_booked" unless a real booking exists
 *     (i.e., we have a valid ISO dateTime AND a backend appointmentId).
 *  2) If booking intent happened but wasn't finalized, we fall back to lead_captured
 *     (or call_completed if nothing captured).
 *  3) n8n payload is flat JSON (no double-nested body), matching your webhook node output.
 *
 * NOTE:
 *  - This file assumes Node 18+ (global fetch available). If on older Node, add: import fetch from 'node-fetch';
 */

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

// ========================= SECURITY: Credential Sanitization =========================
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
      return { name: obj.name, message: sanitizeForLog(obj.message), stack: '***STACK_REDACTED***' };
    }
    const sanitized = Array.isArray(obj) ? [] : {};
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

const requiredEnvVars = ['OPENAI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PORT'];
console.log('🔧 Environment Check:');
requiredEnvVars.forEach((varName) => {
  const exists = !!process.env[varName];
  console.log(`  ${exists ? '✅' : '❌'} ${varName}: ${exists ? 'Configured' : 'MISSING'}`);
});
['N8N_WEBHOOK_URL', 'TWILIO_PHONE_NUMBER'].forEach((varName) => {
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
    version: '2.2.2',
    features: ['sms', 'n8n-webhook', 'order-lookup', 'real-time-lead-capture', 'appointment-booking'],
    activeSessions: activeSessions.size,
    timestamp: new Date().toISOString(),
  });
});

// ========================= Supabase settings lookup =========================
async function getUserSettingsByPhone(phoneNumber) {
  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 FETCHING USER SETTINGS');
    console.log('📞 Looking up phone:', phoneNumber);

    const response = await fetch(
      `${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/settings/by-phone/${encodeURIComponent(phoneNumber)}`,
      {
        headers: { Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` },
      },
    );

    console.log('📡 Response status:', response.status, response.statusText);

    if (!response.ok) {
      console.log('❌ FAILED - No settings found');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      return null;
    }

    const data = await response.json();
    console.log('✅ SUCCESS - Settings found!');
    console.log('📋 Business Name:', data.settings?.businessName || '(not set)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return data.settings || null;
  } catch (error) {
    console.error('❌ ERROR fetching user settings', sanitizeForLog(error));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return null;
  }
}

// ========================= SMS helper =========================
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

// ========================= n8n webhook helper (FLAT JSON) =========================
async function triggerN8nWebhook(eventType, data) {
  if (!process.env.N8N_WEBHOOK_URL) {
    console.log('⚠️ n8n webhook not triggered - N8N_WEBHOOK_URL not configured');
    return { success: false, reason: 'not_configured' };
  }

  try {
    const payload = {
      eventType,
      timestamp: new Date().toISOString(),
      ...data,
    };

    console.log('🔔 TRIGGERING N8N WEBHOOK');
    console.log('   Event Type:', eventType);
    console.log('📦 Payload:', sanitizeForLog(payload));

    const response = await fetch(process.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      let result = null;
      try {
        result = await response.json();
      } catch (_) {}
      console.log('✅ n8n webhook triggered successfully!');
      if (result) console.log('📨 Response:', sanitizeForLog(result));
      return { success: true, response: result };
    }

    const errorText = await response.text();
    console.error('❌ n8n webhook failed:', response.status, errorText);
    return { success: false, status: response.status, error: errorText };
  } catch (error) {
    console.error('❌ n8n webhook error:', error.message);
    return { success: false, error: error.message };
  }
}

// ========================= AI instructions builder =========================
function buildAIInstructions(userSettings) {
  const businessName = userSettings?.businessName || 'the business';
  const businessHours = userSettings?.businessHours || 'standard business hours';
  const customInstructions = userSettings?.aiPrompt || '';

  let instructions = '';
  instructions += 'You are Krystle, a warm, friendly receptionist for ' + businessName + '.\n';
  instructions += 'Business Hours: ' + businessHours + '\n\n';

  if (customInstructions) {
    instructions += 'BUSINESS INFO:\n' + customInstructions + '\n\n';
  }

  instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
  instructions += '🔴 CRITICAL: CALL FLOW (FOLLOW THIS ORDER) 🔴\n';
  instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

  instructions += 'STEP 1 - GREETING:\n';
  instructions += `Say: "Hi! Thank you for calling ${businessName} today. My name is Krystle."\n\n`;

  instructions += 'STEP 2 - COLLECT NAME:\n';
  instructions += 'Ask: "May I have your name please?"\n';
  instructions += '→ WAIT for answer\n';
  instructions += '→ Confirm spelling if unclear\n';
  instructions += '→ Say: "Thank you, [NAME]"\n\n';

  instructions += 'STEP 3 - COLLECT PHONE NUMBER:\n';
  instructions += 'Ask: "And what\'s the best phone number to reach you?"\n';
  instructions += '→ WAIT for answer\n';
  instructions += '→ Read back to confirm\n';
  instructions += '→ 🔴 IMMEDIATELY call capture_lead_info() with name and phone - NO EXCEPTIONS\n';
  instructions += '→ You MUST call this function right now, do not wait or skip this step\n\n';

  instructions += 'STEP 4 - NOW ASK HOW TO HELP:\n';
  instructions += 'Ask: "How can I help you today?"\n';
  instructions += '→ WAIT for customer to explain their needs\n';
  instructions += '→ When customer asks ANY product/service question, IMMEDIATELY UPDATE capture_lead_info() with notes\n';
  instructions += '→ Example: Customer asks "What sizes?" → Call capture_lead_info({notes: "Asked about product sizes"})\n\n';

  instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
  instructions += '🔴 ADDITIONAL INFO FOR APPOINTMENTS 🔴\n';
  instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

  instructions += 'IF CUSTOMER WANTS TO BOOK AN APPOINTMENT - COLLECT (ONE AT A TIME):\n';
  instructions += '1. EMAIL ADDRESS - Ask: "Could I get your email address for the confirmation?"\n';
  instructions += '   → WAIT for answer, confirm spelling\n';
  instructions += '2. DATE AND TIME - Ask: "What date and time works best for you? We use Eastern Time."\n';
  instructions += '   → WAIT for answer, confirm: "Just to confirm, that\'s [DATE] at [TIME] Eastern Time?"\n';
  instructions += '3. SMS CONSENT - Ask: "May I send you a text message confirmation?"\n';
  instructions += '   → WAIT for clear yes/no answer\n';
  instructions += '   → If YES: set smsConsent=true, say "Perfect! I\'ll send you a confirmation via SMS, or email if SMS fails."\n';
  instructions += '   → If NO or UNSURE: set smsConsent=false, say "No problem, I\'ll send the confirmation via email."\n\n';

  instructions += '⚠️ CRITICAL RULES:\n';
  instructions += '- ASK QUESTIONS ONE AT A TIME\n';
  instructions += '- WAIT FOR THE CUSTOMER\'S ANSWER BEFORE PROCEEDING\n';
  instructions += '- DO NOT ask multiple questions in one breath\n';
  instructions += '- DO NOT proceed to the next question until you receive a clear answer\n';
  instructions += '- CONFIRM unclear information by repeating it back\n';
  instructions += '- Use Eastern Time (America/New_York) as default timezone\n\n';

  instructions += 'APPOINTMENT BOOKING:\n';
  instructions += '- ONLY call book_appointment() when you have ALL required information:\n';
  instructions += '  ✓ Customer name (confirmed)\n';
  instructions += '  ✓ Customer email (confirmed)\n';
  instructions += '  ✓ Customer phone (confirmed)\n';
  instructions += '  ✓ Specific date and time (confirmed)\n';
  instructions += '  ✓ SMS consent answer (yes or no)\n';
  instructions += '- If customer does NOT confirm a specific time, DO NOT call book_appointment\n';
  instructions += '- timeZone should be "America/New_York" unless customer specifies otherwise\n\n';

  instructions += 'LEAD CAPTURE:\n';
  instructions += '🔴 CRITICAL: Call capture_lead_info() in these scenarios:\n';
  instructions += '✅ Customer provides name + phone AND shows ANY product/service interest\n';
  instructions += '✅ Customer asks questions about products, services, pricing, availability, features\n';
  instructions += '✅ Customer is gathering information (even without requesting follow-up)\n';
  instructions += '✅ Call ends without booking appointment but customer engaged meaningfully\n\n';
  
  instructions += '❌ DO NOT capture as lead when:\n';
  instructions += '- Wrong number / misdial\n';
  instructions += '- Spam call\n';
  instructions += '- Customer only asks ultra-basic info (hours, address) with zero engagement\n\n';
  
  instructions += 'WHEN TO CALL capture_lead_info():\n';
  instructions += '1. IMMEDIATELY after collecting name + phone (Step 3)\n';
  instructions += '2. UPDATE it when customer asks product questions or shows interest\n';
  instructions += '3. UPDATE it again before call ends with final notes\n\n';
  
  instructions += 'EXAMPLE - Product Inquiry Call:\n';
  instructions += 'Customer: "What sizes do you have available?"\n';
  instructions += '→ This is a QUALIFIED LEAD! Call capture_lead_info() with:\n';
  instructions += '  notes: "Asked about product sizes - interested in purchasing"\n\n';
  
  instructions += '⚠️ REMEMBER: Always ask for SMS consent before setting smsConsent=true\n\n';

  instructions += 'CONVERSATION FLOW:\n';
  instructions += '- Be warm, natural, and professional\n';
  instructions += '- Pace yourself - don\'t rush through questions\n';
  instructions += '- Pause between questions to let the customer speak\n';
  instructions += '- If you don\'t understand, politely ask them to repeat\n';
  instructions += '- Thank them for their patience when collecting information\n\n';

  return instructions;
}

// ========================= OpenAI function tools =========================
const FUNCTION_TOOLS = [
  {
    type: 'function',
    name: 'capture_lead_info',
    description:
      'Capture customer lead information. Call this IMMEDIATELY after collecting name+phone, then UPDATE it when customer shows product/service interest (asks about pricing, features, availability, etc). Always ask for SMS consent before setting smsConsent=true.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Customer's full name" },
        email: { type: 'string', description: "Customer's email address" },
        phone: { type: 'string', description: "Customer's phone number (if different from caller ID)" },
        notes: { type: 'string', description: 'Notes about what the customer needs' },
        smsConsent: { type: 'boolean', description: 'Customer consented to SMS: true/false' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'book_appointment',
    description:
      'Book an appointment ONLY after the customer confirms a specific date/time. Ask SMS consent before setting smsConsent=true.',
    parameters: {
      type: 'object',
      properties: {
        customerName: { type: 'string', description: "Customer's full name" },
        customerEmail: { type: 'string', description: "Customer's email address" },
        customerPhone: { type: 'string', description: "Customer's phone number" },
        smsConsent: { type: 'boolean', description: 'Customer agreed to receive SMS: true/false' },
        dateTime: {
          type: 'string',
          description: 'Appointment date/time in ISO 8601 (e.g., 2026-01-03T10:00:00-05:00)',
        },
        duration: { type: 'number', description: 'Duration in minutes (default 30)' },
        purpose: { type: 'string', description: 'Purpose of the appointment' },
        timeZone: { type: 'string', description: 'IANA timezone, e.g., America/New_York' },
      },
      required: ['customerName', 'dateTime', 'purpose'],
    },
  },
  {
    type: 'function',
    name: 'lookup_order_status',
    description: 'Look up the status of an order by orderId',
    parameters: {
      type: 'object',
      properties: { orderId: { type: 'string', description: 'Order ID, e.g. ORD-12345' } },
      required: ['orderId'],
    },
  },
];

// ========================= Twilio inbound webhook =========================
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
    `    <Stream url="wss://${req.headers.host}/media-stream">\n` +
    `      <Parameter name="callSid" value="${callSid}" />\n` +
    `      <Parameter name="from" value="${from}" />\n` +
    `      <Parameter name="to" value="${to}" />\n` +
    '    </Stream>\n' +
    '  </Connect>\n' +
    '</Response>';

  res.type('text/xml');
  res.send(twiml);
});

// ========================= Websocket handling =========================
wss.on('connection', async (ws) => {
  console.log('🔌 NEW WEBSOCKET CONNECTION');

  const sessionId = uuidv4();
  activeSessions.set(sessionId, { startedAt: new Date().toISOString() });

  let callSid = null;
  let streamSid = null;
  let openaiWs = null;

  let toPhoneNumber = null;
  let fromPhoneNumber = null;

  let userSettings = null;
  let userId = null;

  const callStartTime = new Date();

  // Prevent duplicate webhook sends
  let webhookSent = false;

  // Lead info
  const capturedLeadInfo = {
    name: null,
    email: null,
    phone: null,
    notes: null,
    smsConsent: false,
  };

  // Appointment info
  let appointmentIntent = false; // AI attempted booking
  let appointmentDetails = null; // function args
  let appointmentResult = null; // backend response

  // Conversation transcript
  const conversationTranscript = [];

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
          userId = userSettings?.userId || null;

          // Log call start to backend (best-effort)
          if (userId && callSid) {
            try {
              await fetch(`${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/calls/bridge-log`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
                },
                body: JSON.stringify({
                  callSid,
                  toNumber: toPhoneNumber,
                  fromNumber: fromPhoneNumber,
                  status: 'in-progress',
                  duration: 0,
                }),
              });
              console.log('✅ Call logged to backend');
            } catch (err) {
              console.error('⚠️ Failed to log call:', err.message);
            }
          }

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

          const durationSec = Math.floor((new Date() - callStartTime) / 1000);

          const base = {
            callSid,
            userId: userId || undefined,
            fromNumber: fromPhoneNumber || undefined,
            toNumber: toPhoneNumber || undefined,
            duration: durationSec,
            businessName: userSettings?.businessName || 'Unknown',
            status: 'completed',
          };

          const hasLeadInfo = !!(capturedLeadInfo.name || capturedLeadInfo.email || capturedLeadInfo.notes);

          const hasIsoDateTime = !!(appointmentDetails?.dateTime && typeof appointmentDetails.dateTime === 'string');
          const hasAppointmentId = !!(appointmentResult?.appointmentId && typeof appointmentResult.appointmentId === 'string');

          console.log('🧪 Booking flags:', {
            appointmentIntent,
            hasIsoDateTime,
            hasAppointmentId,
            calendarEventCreated: appointmentResult?.calendarEventCreated,
          });

          // Format conversation log
          const conversationLog = conversationTranscript.length > 0 
            ? conversationTranscript.map(entry => `[${entry.speaker}]: ${entry.text}`).join('\n')
            : 'Conversation transcript not available';

          if (appointmentIntent && hasIsoDateTime && hasAppointmentId) {
            await triggerN8nWebhook('appointment_booked', {
              ...base,
              appointmentId: appointmentResult.appointmentId,
              customerName: appointmentDetails.customerName || capturedLeadInfo.name || 'Unknown',
              customerEmail: appointmentDetails.customerEmail || capturedLeadInfo.email || '',
              customerPhone: appointmentDetails.customerPhone || capturedLeadInfo.phone || fromPhoneNumber || '',
              appointmentDate: new Date(appointmentDetails.dateTime).toISOString(),
              appointmentTime: undefined,
              appointmentDateTime: new Date(appointmentDetails.dateTime).toUTCString(),
              purpose: appointmentDetails.purpose || 'consultation',
              duration: appointmentDetails.duration || 30,
              timeZone: appointmentDetails.timeZone || 'America/New_York',
              googleCalendarEventCreated: !!appointmentResult.calendarEventCreated,
              meetLink: appointmentResult.meetLink || undefined,
              smsConsent: !!appointmentDetails.smsConsent,
              leadCaptured: hasLeadInfo,
              conversationLog,
            });
          } else if (hasLeadInfo) {
            await triggerN8nWebhook('lead_captured', {
              ...base,
              customerName: capturedLeadInfo.name || 'Unknown',
              customerEmail: capturedLeadInfo.email || '',
              customerPhone: capturedLeadInfo.phone || fromPhoneNumber || '',
              summary: capturedLeadInfo.notes || 'Lead captured; no summary provided.',
              smsConsent: !!capturedLeadInfo.smsConsent,
              appointmentBooked: false,
              leadCaptured: true,
              bookingIntent: appointmentIntent,
              conversationLog,
            });
          } else {
            await triggerN8nWebhook('call_completed', {
              ...base,
              appointmentBooked: false,
              leadCaptured: false,
              bookingIntent: appointmentIntent,
              conversationLog,
            });
          }

          // Finalize call in backend (best-effort)
          if (userId && callSid) {
            try {
              await fetch(`${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/calls/${callSid}`, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
                },
                body: JSON.stringify({
                  status: 'completed',
                  duration: durationSec,
                  leadCaptured: hasLeadInfo,
                }),
              });
              console.log('✅ Call finalized in backend');
            } catch (err) {
              console.error('⚠️ Failed to finalize call:', err.message);
            }
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
      if (functionArgs.notes) {
        capturedLeadInfo.notes = capturedLeadInfo.notes ? `${capturedLeadInfo.notes}\n${functionArgs.notes}` : functionArgs.notes;
      }
      if (functionArgs.smsConsent !== undefined) capturedLeadInfo.smsConsent = !!functionArgs.smsConsent;

      console.log('💾 Updated lead info:', sanitizeForLog(capturedLeadInfo));

      const customerPhone = capturedLeadInfo.phone || fromPhoneNumber;
      const customerName = capturedLeadInfo.name || 'there';
      const businessName = userSettings?.businessName || 'us';

      if (customerPhone && capturedLeadInfo.smsConsent) {
        const smsMessage = `Hi ${customerName}! Thanks for calling ${businessName}. We’ve got your info and will follow up shortly.`;
        await sendSMS(customerPhone, smsMessage);
      }

      if (userId && callSid) {
        try {
          const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/leads/realtime-update`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({
              userId,
              callSid,
              name: capturedLeadInfo.name,
              email: capturedLeadInfo.email,
              phone: capturedLeadInfo.phone || fromPhoneNumber,
              notes: capturedLeadInfo.notes,
            }),
          });

          if (response.ok) console.log('✅ Lead updated in real-time!');
          else console.error('⚠️ Failed to update lead:', await response.text());
        } catch (err) {
          console.error('⚠️ Failed to update lead:', err.message);
        }
      }

      return JSON.stringify({
        success: true,
        message: 'Lead information captured successfully.' + (capturedLeadInfo.smsConsent ? ' Confirmation text sent.' : ''),
      });
    }

    if (functionName === 'book_appointment') {
      appointmentIntent = true;
      appointmentDetails = functionArgs;

      const customerName = functionArgs.customerName || capturedLeadInfo.name || 'Unknown';
      const customerEmail = functionArgs.customerEmail || capturedLeadInfo.email || '';
      const customerPhone = functionArgs.customerPhone || capturedLeadInfo.phone || fromPhoneNumber || '';
      const tz = functionArgs.timeZone || 'America/New_York';

      if (customerPhone && functionArgs.smsConsent && functionArgs.dateTime) {
        const businessName = userSettings?.businessName || 'us';
        const appointmentTime = new Date(functionArgs.dateTime).toLocaleString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: tz,
        });
        const smsMessage = `Hi ${customerName}! Your appointment with ${businessName} is confirmed for ${appointmentTime}.`;
        await sendSMS(customerPhone, smsMessage);
      }

      if (userId && callSid) {
        try {
          const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/appointments/book`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({
              userId,
              callSid,
              customerName,
              customerEmail,
              customerPhone,
              dateTime: functionArgs.dateTime,
              duration: functionArgs.duration || 30,
              purpose: functionArgs.purpose,
              timeZone: tz,
            }),
          });

          if (!response.ok) {
            const txt = await response.text();
            console.error('⚠️ Failed to book appointment:', txt);
            appointmentResult = null;
            return JSON.stringify({ success: false, message: 'Failed to book appointment. Please try again.' });
          }

          const result = await response.json();
          console.log('✅ Appointment booked successfully!');
          console.log('📅 Calendar event created:', result.calendarEventCreated);

          appointmentResult = {
            appointmentId: result.appointment?.id || result.appointmentId || null,
            calendarEventCreated: !!result.calendarEventCreated,
            meetLink: result.meetLink || result.hangoutLink || result.appointment?.meetLink || null,
          };

          return JSON.stringify({
            success: true,
            message: "Appointment booked successfully. You'll receive a confirmation shortly.",
            appointmentId: appointmentResult.appointmentId,
            calendarEventCreated: appointmentResult.calendarEventCreated,
          });
        } catch (err) {
          console.error('⚠️ Failed to book appointment:', err.message);
          appointmentResult = null;
          return JSON.stringify({ success: false, message: 'Failed to book appointment. Please try again.' });
        }
      }

      appointmentResult = null;
      return JSON.stringify({ success: false, message: 'Unable to book appointment at this time.' });
    }

    if (functionName === 'lookup_order_status') {
      let cleanOrderId = functionArgs.orderId?.toString().trim().toUpperCase() || '';
      cleanOrderId = cleanOrderId.replace(/^#/, '');

      try {
        const response = await fetch(
          `${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/orders/lookup/${encodeURIComponent(cleanOrderId)}`,
          { method: 'GET', headers: { Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` } },
        );

        if (!response.ok) {
          return JSON.stringify({
            success: false,
            message: `I couldn't find an order with ID ${cleanOrderId}. Could you double-check the number?`,
          });
        }

        const result = await response.json();
        const order = result.order;

        let statusMessage = `I found your order! Order ${order.orderId} `;
        if (order.customerName) statusMessage += `for ${order.customerName} `;
        statusMessage += `is currently ${order.status}. `;
        if (order.statusMessage) statusMessage += `${order.statusMessage}. `;
        if (order.estimatedDelivery) statusMessage += `Estimated delivery: ${order.estimatedDelivery}. `;
        if (order.trackingNumber) statusMessage += `Tracking number: ${order.trackingNumber}. `;
        if (order.items?.length) statusMessage += `Items: ${order.items.join(', ')}. `;

        return JSON.stringify({ success: true, message: statusMessage, order });
      } catch (err) {
        return JSON.stringify({ success: false, message: "I'm having trouble checking that order right now. Try again shortly." });
      }
    }

    return JSON.stringify({ success: false, message: 'Unknown function' });
  }

  async function initializeOpenAI(settings) {
    try {
      console.log('🔗 Connecting to OpenAI...');

      openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
        headers: {
          Authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      openaiWs.on('open', () => {
        console.log('✅ Connected to OpenAI');

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
                silence_duration_ms: 1500,
              },
              temperature: 0.9,
              max_response_output_tokens: 800,
              tools: FUNCTION_TOOLS,
            },
          }),
        );
      });

      openaiWs.on('message', async (data) => {
        try {
          const event = JSON.parse(data.toString());

          if (event.type === 'session.updated') {
            openaiWs.send(JSON.stringify({ type: 'response.create' }));
          }

          if (event.type === 'response.audio.delta' && event.delta) {
            ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
          }

          if (event.type === 'conversation.item.input_audio_transcription.completed') {
            console.log('👤 User:', event.transcript);
            conversationTranscript.push({
              speaker: 'Customer',
              text: event.transcript,
              timestamp: new Date().toISOString()
            });
          }

          if (event.type === 'response.audio_transcript.done') {
            console.log('🤖 Krystle:', event.transcript);
            conversationTranscript.push({
              speaker: 'Krystle',
              text: event.transcript,
              timestamp: new Date().toISOString()
            });
          }

          if (event.type === 'error' || event.type === 'response.failed') {
            console.error('❌ OpenAI Error:', JSON.stringify(event, null, 2));
          }

          if (event.type === 'response.function_call_arguments.done') {
            const functionName = event.name;
            const functionArgs = JSON.parse(event.arguments);

            const result = await handleFunctionCall(functionName, functionArgs);

            openaiWs.send(
              JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'function_call_output', call_id: event.call_id, output: result },
              }),
            );

            openaiWs.send(JSON.stringify({ type: 'response.create' }));
          }
        } catch (error) {
          console.error('❌ Error processing OpenAI message:', sanitizeForLog(error));
        }
      });

      openaiWs.on('error', (error) => {
        console.error('❌ OpenAI error:', sanitizeForLog(error));
      });
    } catch (error) {
      console.error('❌ Failed to connect:', sanitizeForLog(error));
    }
  }

  ws.on('close', () => {
    console.log('🔌 Twilio closed');
    activeSessions.delete(sessionId);
    if (openaiWs) openaiWs.close();
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('🚀 Talkertive WebSocket Bridge Server v2.2.2');
  console.log('📡 Port:', PORT);
  console.log('🎤 Receptionist: Krystle (Shimmer voice)');
  console.log('📱 SMS Status:', process.env.TWILIO_PHONE_NUMBER ? 'Enabled' : 'Disabled (set TWILIO_PHONE_NUMBER)');
  console.log('🔔 n8n Webhook:', process.env.N8N_WEBHOOK_URL ? 'Enabled' : 'Disabled (set N8N_WEBHOOK_URL)');
  console.log('');
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  server.close(() => process.exit(0));
});
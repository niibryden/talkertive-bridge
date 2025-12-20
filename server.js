import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { createServer } from 'http';
import OpenAI from 'openai';
import { ElevenLabsClient } from 'elevenlabs';
import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import 'dotenv/config';

const app = express();
const server = createServer(app);

// WebSocket server for Twilio <Stream>
const wss = new WebSocketServer({ server });

// -----------------------------
// ENV + clients
// -----------------------------
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'PORT',
];

let missingEnv = false;
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`❌ Missing required environment variable: ${varName}`);
    missingEnv = true;
  }
});

if (missingEnv) {
  console.warn('⚠️ One or more required env vars are missing. The service may not work correctly.');
}

// Initialize clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const PORT = Number(process.env.PORT);
if (!PORT) {
  console.error('❌ PORT not provided (Railway requires PORT).');
  process.exit(1);
}

// Store active sessions
const activeSessions = new Map();

// 🎤 VOICE SELECTION - Change this to customize the voice
// Options: 'alloy', 'echo', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse'
const AI_VOICE = process.env.AI_VOICE || 'shimmer'; // shimmer is more feminine and warm

// -----------------------------
// Middleware
// -----------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.options('/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.sendStatus(204);
});

app.get('/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  res.json({
    status: 'healthy',
    service: 'talkertive-websocket-bridge',
    activeSessions: activeSessions.size,
    voice: AI_VOICE,
    timestamp: new Date().toISOString(),
  });
});

// -----------------------------
// Twilio webhook endpoint
// -----------------------------
app.post('/incoming-call', async (req, res) => {
  console.log('📞 Incoming call received:', req.body);

  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;

  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/call-logs`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          userId: 'system',
          customerPhone: from,
          customerName: 'Unknown Caller',
          duration: 0,
          status: 'in-progress',
          callSid,
          direction: 'inbound',
        }),
      }
    );

    if (!response.ok) {
      console.error('Failed to log call start:', await response.text());
    }
  } catch (error) {
    console.error('Error logging call start:', error);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream">
      <Parameter name="callSid" value="${callSid}" />
      <Parameter name="from" value="${from}" />
      <Parameter name="to" value="${to}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// -----------------------------
// WebSocket handler for Twilio Media Streams
// -----------------------------
wss.on('connection', async (ws, req) => {
  console.log('🔌 New WebSocket connection established');

  const sessionId = uuidv4();
  let callSid = null;
  let streamSid = null;
  let openaiWs = null;
  const callStartTime = Date.now();

  const conversationContext = {
    messages: [],
    leadInfo: {},
    appointmentRequested: false,
  };

  activeSessions.set(sessionId, {
    twilioWs: ws,
    openaiWs: null,
    callSid: null,
    startTime: callStartTime,
  });

  // Initialize OpenAI Realtime API connection
  try {
    openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      }
    );

    openaiWs.on('open', () => {
      console.log('✅ Connected to OpenAI Realtime API');

      // Configure session with Twilio's audio format
      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: `You are a professional AI receptionist for Talkertive.io, an AI receptionist SaaS platform. You are friendly, helpful, and efficient.

Your responsibilities:
1. Greet callers warmly and ask how you can help them
2. Collect lead information (name, email, phone, reason for calling)
3. Help schedule appointments if requested
4. Answer questions about Talkertive.io services
5. Be multilingual - detect the caller's language and respond appropriately

When you collect information:
- Name: Ask "May I have your name please?"
- Email: Ask "What's the best email address to reach you?"
- Phone: You already have their phone number from the call
- Purpose: Ask "What can I help you with today?"

If they want to book an appointment, ask:
- Preferred date and time
- Type of service/meeting they need
- Any special requirements

Always be polite, professional, and warm. Keep responses concise and natural for phone conversations.`,
            voice: AI_VOICE, // 🎤 CUSTOMIZABLE VOICE
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
            temperature: 0.8,
            max_response_output_tokens: 4096,
          },
        })
      );

      // Send initial greeting
      setTimeout(() => {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          console.log('🎤 Triggering initial AI greeting...');
          openaiWs.send(
            JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['text', 'audio'],
                instructions: 'Greet the caller warmly and ask how you can help them today.',
              },
            })
          );
        }
      }, 1000);
    });

    openaiWs.on('message', async (data) => {
      try {
        const event = JSON.parse(data.toString());

        switch (event.type) {
          case 'session.created':
            console.log('✅ OpenAI session created');
            break;

          case 'session.updated':
            console.log('✅ OpenAI session updated');
            break;

          case 'conversation.item.created':
            if (event.item?.content) {
              conversationContext.messages.push({
                role: event.item.role,
                content: event.item.content,
              });
            }
            break;

          case 'response.audio.delta':
            // Stream audio back to Twilio
            if (event.delta && ws.readyState === ws.OPEN && streamSid) {
              ws.send(
                JSON.stringify({
                  event: 'media',
                  streamSid,
                  media: {
                    payload: event.delta,
                  },
                })
              );
            }
            break;

          case 'response.audio_transcript.delta':
            console.log('🤖 AI:', event.delta);
            break;

          case 'conversation.item.input_audio_transcription.completed':
            console.log('👤 User:', event.transcript);
            extractLeadInfo(event.transcript, conversationContext);
            break;

          case 'error':
            console.error('❌ OpenAI error:', event.error);
            break;

          default:
            break;
        }
      } catch (error) {
        console.error('Error processing OpenAI message:', error);
      }
    });

    openaiWs.on('error', (error) => {
      console.error('❌ OpenAI WebSocket error:', error);
    });

    openaiWs.on('close', () => {
      console.log('🔌 OpenAI WebSocket closed');
    });

    const session = activeSessions.get(sessionId);
    if (session) session.openaiWs = openaiWs;
  } catch (error) {
    console.error('❌ Failed to connect to OpenAI:', error);
  }

  // Handle Twilio messages
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message.toString());

      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          console.log(`📞 Call started - CallSid: ${callSid}, StreamSid: ${streamSid}`);

          {
            const session = activeSessions.get(sessionId);
            if (session) session.callSid = callSid;
          }
          break;

        case 'media':
          // Forward audio from Twilio to OpenAI
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: msg.media.payload,
              })
            );
          }
          break;

        case 'stop':
          console.log('📞 Call ended');
          await handleCallEnd(callSid, callStartTime, conversationContext);

          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
          break;

        default:
          break;
      }
    } catch (error) {
      console.error('Error processing Twilio message:', error);
    }
  });

  ws.on('close', () => {
    console.log('🔌 Twilio WebSocket closed');
    activeSessions.delete(sessionId);

    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  ws.on('error', (error) => {
    console.error('❌ Twilio WebSocket error:', error);
  });
});

// -----------------------------
// Lead extraction
// -----------------------------
function extractLeadInfo(transcript, context) {
  const text = (transcript || '').toLowerCase();

  const emailMatch = transcript?.match?.(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) {
    context.leadInfo.email = emailMatch[0];
    console.log('📧 Email captured:', context.leadInfo.email);
  }

  if (text.includes('my name is') || text.includes("i'm ") || text.includes('i am ')) {
    const nameMatch = transcript.match(
      /(?:my name is|i'm|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i
    );
    if (nameMatch) {
      context.leadInfo.name = nameMatch[1];
      console.log('👤 Name captured:', context.leadInfo.name);
    }
  }

  if (text.includes('appointment') || text.includes('booking') || text.includes('schedule')) {
    context.appointmentRequested = true;
    console.log('📅 Appointment requested');
  }
}

// -----------------------------
// Call end handler
// -----------------------------
async function handleCallEnd(callSid, startTime, context) {
  const duration = Math.floor((Date.now() - startTime) / 1000);

  console.log('📊 Call summary:', {
    callSid,
    duration,
    leadInfo: context.leadInfo,
    appointmentRequested: context.appointmentRequested,
  });

  try {
    await fetch(
      `${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/call-logs/${callSid}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          duration,
          status: 'completed',
          customerName: context.leadInfo.name || 'Unknown Caller',
        }),
      }
    );
  } catch (error) {
    console.error('Error updating call log:', error);
  }

  if (context.leadInfo.name || context.leadInfo.email) {
    try {
      await fetch(`${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/leads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          userId: 'system',
          name: context.leadInfo.name || 'Unknown',
          email: context.leadInfo.email || '',
          phone: context.leadInfo.phone || '',
          source: 'phone_call',
          status: 'new',
          notes: `Captured from call ${callSid}. Appointment requested: ${context.appointmentRequested}`,
        }),
      });

      console.log('✅ Lead created in Supabase');
    } catch (error) {
      console.error('Error creating lead:', error);
    }
  }
}

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Talkertive WebSocket Bridge Server Started');
  console.log('='.repeat(50));
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🔌 WebSocket endpoint: /media-stream`);
  console.log(`📞 Twilio webhook: /incoming-call`);
  console.log(`❤️ Health check: /health`);
  console.log(`🎤 AI Voice: ${AI_VOICE}`);
  console.log('='.repeat(50));

  console.log('✅ OpenAI:', process.env.OPENAI_API_KEY ? 'Configured' : '❌ Missing');
  console.log('✅ ElevenLabs:', process.env.ELEVENLABS_API_KEY ? 'Configured' : '❌ Missing');
  console.log('✅ Twilio:', process.env.TWILIO_ACCOUNT_SID ? 'Configured' : '❌ Missing');
  console.log('✅ Supabase:', process.env.SUPABASE_URL ? 'Configured' : '❌ Missing');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
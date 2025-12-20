import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { createServer } from 'http';
import OpenAI from 'openai';
import { ElevenLabsClient, stream } from 'elevenlabs';
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

// Railway expects you to bind to process.env.PORT
const PORT = Number(process.env.PORT);
if (!PORT) {
  console.error('❌ PORT not provided (Railway requires PORT).');
  process.exit(1);
}

// Store active sessions
const activeSessions = new Map();

// ElevenLabs Voice ID - CHANGE THIS TO YOUR VOICE ID
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Default: Bella

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
// Helper: Convert text to speech with ElevenLabs
// -----------------------------
async function textToSpeech(text, twilioWs, streamSid) {
  try {
    console.log('🎤 ElevenLabs TTS:', text);

    const audioStream = await elevenlabs.textToSpeech.convertAsStream(ELEVENLABS_VOICE_ID, {
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
      output_format: 'ulaw_8000', // Twilio's format
    });

    // Stream audio chunks to Twilio
    for await (const chunk of audioStream) {
      if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
        twilioWs.send(
          JSON.stringify({
            event: 'media',
            streamSid,
            media: {
              payload: chunk.toString('base64'),
            },
          })
        );
      }
    }
  } catch (error) {
    console.error('❌ ElevenLabs TTS error:', error);
  }
}

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

  // Send initial greeting via ElevenLabs
  const sendGreeting = async () => {
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for streamSid
    if (streamSid) {
      await textToSpeech('Hello! Thank you for calling. How can I help you today?', ws, streamSid);
    }
  };

  // Initialize OpenAI Realtime API (TEXT ONLY mode with audio input)
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

      // Configure for TEXT responses (audio input, text output)
      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text'], // TEXT ONLY - we'll use ElevenLabs for voice
            instructions: `You are a professional AI receptionist for a business. You are friendly, helpful, and efficient.

Your responsibilities:
1. Greet callers warmly and ask how you can help them
2. Collect lead information (name, email, phone, reason for calling)
3. Help schedule appointments if requested
4. Answer common questions about the business
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

Always be polite, professional, and warm. Keep responses concise for phone conversations.`,
            input_audio_format: 'g711_ulaw',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
            temperature: 0.8,
            max_response_output_tokens: 150, // Shorter responses for phone
          },
        })
      );

      // Trigger initial greeting
      setTimeout(() => {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(
            JSON.stringify({
              type: 'response.create',
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
            sendGreeting(); // Send greeting after session ready
            break;

          case 'response.text.delta':
            // Accumulate text response
            if (!conversationContext.currentResponse) {
              conversationContext.currentResponse = '';
            }
            conversationContext.currentResponse += event.delta;
            break;

          case 'response.text.done':
            // Full text response received - convert to speech with ElevenLabs
            if (conversationContext.currentResponse) {
              console.log('🤖 AI Response:', conversationContext.currentResponse);
              await textToSpeech(conversationContext.currentResponse, ws, streamSid);
              conversationContext.currentResponse = '';
            }
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
  console.log(`🎤 ElevenLabs Voice ID: ${ELEVENLABS_VOICE_ID}`);
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

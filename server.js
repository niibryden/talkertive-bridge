import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import OpenAI from 'openai';
import { ElevenLabsClient } from 'elevenlabs';
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
    // Mask API keys in strings
    return obj.replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***REDACTED***')
              .replace(/AC[a-z0-9]{32}/g, 'AC***REDACTED***')
              .replace(/[a-f0-9]{32}/g, '***REDACTED***');
  }
  if (typeof obj === 'object' && obj !== null) {
    const sanitized = {};
    for (const key in obj) {
      if (['apiKey', 'api_key', 'token', 'password', 'secret', 'auth'].some(k => key.toLowerCase().includes(k))) {
        sanitized[key] = '***REDACTED***';
      } else {
        sanitized[key] = sanitizeForLog(obj[key]);
      }
    }
    return sanitized;
  }
  return obj;
}

// Environment variables validation (don't log actual values)
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'PORT'
];

requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`❌ Missing required environment variable: ${varName}`);
  }
});

// Initialize clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const PORT = process.env.PORT || 3000;

// Store active sessions
const activeSessions = new Map();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'talkertive-websocket-bridge',
    activeSessions: activeSessions.size,
    timestamp: new Date().toISOString()
  });
});

// ============= FETCH USER SETTINGS BY PHONE NUMBER =============
async function getUserSettingsByPhone(phoneNumber) {
  try {
    console.log(`🔍 Looking up user settings for phone: ${phoneNumber}`);
    
    const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/settings/by-phone/${encodeURIComponent(phoneNumber)}`, {
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Found settings for user`);
      return data.settings || null;
    } else {
      console.log(`⚠️ No settings found for phone ${phoneNumber}`);
      return null;
    }
  } catch (error) {
    console.error('Error fetching user settings:', sanitizeForLog(error.message));
    return null;
  }
}

// ============= BUILD DYNAMIC AI INSTRUCTIONS =============
function buildAIInstructions(userSettings) {
  const businessName = userSettings?.businessName || 'the business';
  const businessHours = userSettings?.businessHours || 'standard business hours';
  const customInstructions = userSettings?.aiPrompt || '';
  
  const baseInstructions = `You are an energetic, friendly AI receptionist for ${businessName}.

GREETING (Always start with this):
"Hi! Thanks so much for calling ${businessName}! How can I help you today?"

BUSINESS INFORMATION:
- Business Name: ${businessName}
- Business Hours: ${businessHours}

${customInstructions ? `CUSTOM BUSINESS INSTRUCTIONS:\n${customInstructions}\n` : ''}

PERSONALITY:
- Be warm, upbeat, and enthusiastic! Use an energetic, conversational tone
- Smile through your voice - be genuinely excited to help
- Be patient and don't rush - let callers speak fully before responding
- Keep the conversation going naturally - don't be quick to end the call
- Ask follow-up questions to better understand their needs
- NEVER suggest ending the call unless the caller explicitly says goodbye or thanks you for your time
- Be helpful and knowledgeable about ${businessName}

YOUR RESPONSIBILITIES:
1. Capture lead information naturally through conversation:
   - Full name: "I'd love to get your name for our records!"
   - Email address: "What's the best email to send you information?"
   - Phone number: "And what's a good callback number?" (if they don't volunteer it)
   - Their need/inquiry: "Tell me more about what you're looking for! I'm all ears."

2. Answer questions about ${businessName}:
   - Be helpful and provide information based on what the caller asks
   - If you don't know specific details, say: "That's a great question! Let me take your information and have someone from our team get back to you with those details."
   - Reference our business hours: ${businessHours}

3. Offer to help schedule callbacks or appointments:
   - "I'd love to get you scheduled! When works best for you this week?"
   - Collect: preferred date/time, their timezone
   - "How about Tuesday at 2pm, or would Thursday morning work better?"

4. Handle inquiries professionally:
   - Listen carefully to what they need
   - Take detailed notes about their inquiry
   - Always offer to have someone call them back if you can't answer
   - Example: "I want to make sure you get the exact information you need. Can I have someone from ${businessName} give you a call back?"

CONVERSATION STYLE:
- Use natural filler words: "Absolutely!", "That's great!", "Oh, I'd love to help with that!"
- Ask open-ended questions: "What else can I tell you?", "What would make this perfect for you?"
- Acknowledge what they say: "That makes total sense!", "I hear you!", "Great question!"
- Be persistent but friendly: Don't give up after one exchange - keep the conversation flowing
- Mirror their energy: If they're excited, be excited. If they're calm, be warm and professional.

LANGUAGE PROTOCOL:
- ALWAYS speak in English by default
- Only switch to another language if the caller EXPLICITLY asks: "Can you speak Spanish?", "Hablas español?", etc.
- If unclear, ask: "Just to make sure I'm helping you in the best way - would you prefer to continue in English or another language?"

WHAT NOT TO DO:
- Don't rush to end the call
- Don't be robotic or stiff
- Don't just answer one question and ask if they need anything else
- Don't switch languages unless explicitly requested
- Don't say "Is there anything else I can help you with?" after every response
- Don't mention that you're an AI unless directly asked
- Don't provide specific business details you don't know - instead, offer a callback

KEEP THE ENERGY UP! You're not just answering questions - you're representing ${businessName} and making a great first impression!`;

  return baseInstructions;
}

// Twilio webhook endpoint - handles incoming calls
app.post('/incoming-call', async (req, res) => {
  console.log('📞 Incoming call received');
  
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;
  
  // Log call start to Supabase
  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/calls/bridge-log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        toNumber: to,
        fromNumber: from,
        callSid: callSid,
        status: 'in-progress',
        duration: 0,
        leadCaptured: false,
        appointmentBooked: false
      })
    });
    
    if (!response.ok) {
      console.error('Failed to log call start');
    } else {
      console.log('✅ Call logged to database');
    }
  } catch (error) {
    console.error('Error logging call start:', sanitizeForLog(error.message));
  }
  
  // TwiML response - connect to WebSocket
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

// WebSocket handler for Twilio Media Streams
wss.on('connection', async (ws, req) => {
  console.log('🔌 New WebSocket connection established');
  
  const sessionId = uuidv4();
  let callSid = null;
  let streamSid = null;
  let openaiWs = null;
  let callStartTime = Date.now();
  let toPhoneNumber = null;
  let userSettings = null;
  let conversationContext = {
    messages: [],
    leadInfo: {},
    appointmentRequested: false
  };
  
  // Store session
  activeSessions.set(sessionId, {
    twilioWs: ws,
    openaiWs: null,
    callSid: null,
    startTime: callStartTime
  });
  
  // Handle Twilio messages
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message.toString());
      
      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          
          // Extract phone number from custom parameters
          const customParams = msg.start.customParameters;
          toPhoneNumber = customParams?.to || msg.start.to;
          
          console.log(`📞 Call started - CallSid: ${callSid}`);
          
          // Update session
          const session = activeSessions.get(sessionId);
          if (session) {
            session.callSid = callSid;
          }
          
          // ============= FETCH USER SETTINGS =============
          userSettings = await getUserSettingsByPhone(toPhoneNumber);
          
          // Initialize OpenAI connection NOW with user-specific settings
          await initializeOpenAI(userSettings);
          break;
          
        case 'media':
          // Forward audio from Twilio to OpenAI
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
            };
            openaiWs.send(JSON.stringify(audioAppend));
          }
          break;
          
        case 'stop':
          console.log('📞 Call ended');
          await handleCallEnd(callSid, callStartTime, conversationContext, toPhoneNumber);
          
          // Close OpenAI connection
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
          break;
      }
    } catch (error) {
      console.error('Error processing Twilio message:', sanitizeForLog(error.message));
    }
  });
  
  // Initialize OpenAI with dynamic settings
  async function initializeOpenAI(settings) {
    try {
      openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });
      
      openaiWs.on('open', () => {
        console.log('✅ Connected to OpenAI Realtime API');
        
        // Build dynamic instructions with user's business info
        const instructions = buildAIInstructions(settings);
        
        // Send session configuration
        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: instructions,
            voice: 'shimmer',
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            input_audio_transcription: {
              model: 'whisper-1'
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 700
            },
            temperature: 0.9,
            max_response_output_tokens: 4096
          }
        }));
      });
      
      // Handle OpenAI responses
      openaiWs.on('message', async (data) => {
        try {
          const event = JSON.parse(data.toString());
          
          switch (event.type) {
            case 'session.created':
              console.log('✅ OpenAI session created');
              break;
              
            case 'session.updated':
              console.log('✅ OpenAI session updated');
              
              // Trigger the AI to greet the caller
              const businessName = settings?.businessName || 'the business';
              openaiWs.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['text', 'audio'],
                  instructions: `Greet the caller warmly with: "Hi! Thanks so much for calling ${businessName}! How can I help you today?"`
                }
              }));
              break;
              
            case 'conversation.item.created':
              if (event.item?.content) {
                conversationContext.messages.push({
                  role: event.item.role,
                  content: event.item.content
                });
              }
              break;
              
            case 'response.audio.delta':
              if (event.delta && ws.readyState === ws.OPEN) {
                const audioPayload = {
                  event: 'media',
                  streamSid: streamSid,
                  media: {
                    payload: event.delta
                  }
                };
                ws.send(JSON.stringify(audioPayload));
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
              console.error('❌ OpenAI error:', sanitizeForLog(event.error));
              break;
          }
        } catch (error) {
          console.error('Error processing OpenAI message:', sanitizeForLog(error.message));
        }
      });
      
      openaiWs.on('error', (error) => {
        console.error('❌ OpenAI WebSocket error:', sanitizeForLog(error.message));
      });
      
      openaiWs.on('close', () => {
        console.log('🔌 OpenAI WebSocket closed');
      });
      
      // Update session
      const session = activeSessions.get(sessionId);
      if (session) {
        session.openaiWs = openaiWs;
      }
      
    } catch (error) {
      console.error('❌ Failed to connect to OpenAI:', sanitizeForLog(error.message));
    }
  }
  
  ws.on('close', () => {
    console.log('🔌 Twilio WebSocket closed');
    activeSessions.delete(sessionId);
    
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
  
  ws.on('error', (error) => {
    console.error('❌ Twilio WebSocket error:', sanitizeForLog(error.message));
  });
});

// Extract lead information from conversation
function extractLeadInfo(transcript, context) {
  const text = transcript.toLowerCase();
  
  // Email pattern
  const emailMatch = transcript.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) {
    context.leadInfo.email = emailMatch[0];
    console.log('📧 Email captured');
  }
  
  // Name pattern
  if (text.includes('my name is') || text.includes("i'm ")) {
    const nameMatch = transcript.match(/(?:my name is|i'm|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
    if (nameMatch) {
      context.leadInfo.name = nameMatch[1];
      console.log('👤 Name captured');
    }
  }
  
  // Appointment detection
  if (text.includes('appointment') || text.includes('booking') || text.includes('schedule')) {
    context.appointmentRequested = true;
    console.log('📅 Appointment requested');
  }
}

// Handle call end - log to Supabase
async function handleCallEnd(callSid, startTime, context, toPhoneNumber) {
  const duration = Math.floor((Date.now() - startTime) / 1000);
  
  console.log('📊 Call completed');
  
  const callData = {
    callSid,
    duration,
    status: 'completed',
    leadCaptured: !!context.leadInfo.name || !!context.leadInfo.email,
    appointmentBooked: context.appointmentRequested,
    leadInfo: context.leadInfo,
    timestamp: new Date().toISOString()
  };
  
  // Update call log in Supabase
  try {
    await fetch(`${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/calls/${callSid}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        duration,
        status: 'completed',
        leadCaptured: callData.leadCaptured,
        appointmentBooked: context.appointmentRequested
      })
    });
    
    console.log('✅ Call log updated');
  } catch (error) {
    console.error('Error updating call log:', sanitizeForLog(error.message));
  }
  
  // Create lead if we have information
  if (context.leadInfo.name || context.leadInfo.email) {
    try {
      await fetch(`${process.env.SUPABASE_URL}/functions/v1/make-server-4e1c9511/leads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({
          userId: 'system',
          name: context.leadInfo.name || 'Unknown',
          email: context.leadInfo.email || '',
          phone: context.leadInfo.phone || '',
          source: 'phone_call',
          status: 'new',
          notes: `Captured from call ${callSid}. Appointment requested: ${context.appointmentRequested}`
        })
      });
      
      console.log('✅ Lead created');
    } catch (error) {
      console.error('Error creating lead:', sanitizeForLog(error.message));
    }
  }
  
  // Trigger n8n webhook for post-call automation
  if (process.env.N8N_WEBHOOK_URL) {
    try {
      console.log('🔔 Triggering n8n webhook...');
      
      const response = await fetch(process.env.N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event: 'call_completed',
          callSid: callData.callSid,
          duration: callData.duration,
          timestamp: callData.timestamp,
          lead: {
            name: context.leadInfo.name || null,
            email: context.leadInfo.email || null,
            phone: context.leadInfo.phone || null
          },
          appointmentRequested: context.appointmentRequested,
          leadCaptured: callData.leadCaptured,
          conversation: context.messages.slice(-10)
        })
      });
      
      if (response.ok) {
        console.log('✅ n8n webhook triggered');
      } else {
        console.error('❌ n8n webhook failed');
      }
    } catch (error) {
      console.error('❌ Error triggering n8n webhook:', sanitizeForLog(error.message));
    }
  }
}

// Start server
server.listen(PORT, () => {
  console.log('🚀 Talkertive WebSocket Bridge Server Started');
  console.log('━'.repeat(50));
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🔗 WebSocket endpoint: ws://localhost:${PORT}/media-stream`);
  console.log(`📞 Twilio webhook: http://localhost:${PORT}/incoming-call`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  console.log('━'.repeat(50));
  console.log('✅ OpenAI:', process.env.OPENAI_API_KEY ? 'Configured' : '❌ Missing');
  console.log('✅ ElevenLabs:', process.env.ELEVENLABS_API_KEY ? 'Configured' : '❌ Missing');
  console.log('✅ Twilio:', process.env.TWILIO_ACCOUNT_SID ? 'Configured' : '❌ Missing');
  console.log('✅ Supabase:', process.env.SUPABASE_URL ? 'Configured' : '❌ Missing');
  console.log('━'.repeat(50));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
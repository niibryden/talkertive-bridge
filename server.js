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
    return obj.replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***REDACTED***')
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
        stack: '***STACK_REDACTED***'
      };
    }
    const sanitized = {};
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

console.log('🔒 SECURITY TEST:');
console.log('Test:', sanitizeForLog('Key: sk-1234567890abcdefghij'));
console.log('');

const requiredEnvVars = [
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
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
console.log('');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
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
    activeSessions: activeSessions.size,
    timestamp: new Date().toISOString()
  });
});

async function getUserSettingsByPhone(phoneNumber) {
  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 FETCHING USER SETTINGS');
    console.log('📞 Looking up phone:', phoneNumber);
    console.log('🔗 Endpoint:', process.env.SUPABASE_URL + '/functions/v1/make-server-4e1c9511/settings/by-phone/' + encodeURIComponent(phoneNumber));
    
    const response = await fetch(process.env.SUPABASE_URL + '/functions/v1/make-server-4e1c9511/settings/by-phone/' + encodeURIComponent(phoneNumber), {
      headers: {
        'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY
      }
    });
    
    console.log('📡 Response status:', response.status, response.statusText);
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅ SUCCESS - Settings found!');
      console.log('📋 Business Name:', data.settings?.businessName || '(not set)');
      console.log('📋 Business Hours:', data.settings?.businessHours || '(not set)');
      console.log('📋 Has Custom Prompt:', data.settings?.aiPrompt ? 'Yes' : 'No');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      return data.settings || null;
    } else {
      const errorText = await response.text();
      console.log('❌ FAILED - No settings found');
      console.log('Error:', errorText);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      return null;
    }
  } catch (error) {
    console.error('❌ ERROR fetching user settings');
    console.error('Message:', sanitizeForLog(error.message));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return null;
  }
}

function buildAIInstructions(userSettings) {
  const businessName = userSettings?.businessName || 'the business';
  const businessHours = userSettings?.businessHours || 'standard business hours';
  const customInstructions = userSettings?.aiPrompt || '';
  
  console.log('🤖 BUILDING AI INSTRUCTIONS:');
  console.log('   Business Name: "' + businessName + '"');
  console.log('   Business Hours: "' + businessHours + '"');
  console.log('   Custom AI Instructions:', customInstructions ? 'Yes (' + customInstructions.substring(0, 50) + '...)' : 'None');
  
  let instructions = '═══════════════════════════════════════════════════════\n';
  instructions += '🚨 CRITICAL: YOU MUST FOLLOW THESE RULES STRICTLY\n';
  instructions += '═══════════════════════════════════════════════════════\n\n';
  
  instructions += 'IDENTITY:\n';
  instructions += 'You are the AI receptionist for ' + businessName + '.\n';
  instructions += 'Business Hours: ' + businessHours + '\n\n';
  
  // PRIORITIZE CUSTOM AI INSTRUCTIONS AT THE TOP
  if (customInstructions) {
    instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    instructions += '🏢 BUSINESS INFORMATION & YOUR INSTRUCTIONS:\n';
    instructions += '(FOLLOW THESE EXACTLY - THIS IS YOUR PRIMARY GUIDE)\n';
    instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    instructions += customInstructions + '\n\n';
    instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  }
  
  instructions += 'GREETING (Start every call with this):\n';
  instructions += '"Hi! Thanks so much for calling ' + businessName + '! How can I help you today?"\n\n';
  
  instructions += 'CORE RESPONSIBILITIES:\n';
  instructions += '1. Answer questions about ' + businessName + ' using the Business Information above\n';
  instructions += '2. Capture lead information naturally:\n';
  instructions += '   - Full name: "I would love to get your name for our records!"\n';
  instructions += '   - Email: "What is the best email to send you information?"\n';
  instructions += '   - Phone: "And what is a good callback number?"\n';
  instructions += '   - Their inquiry: "Tell me more about what you are looking for!"\n\n';
  
  instructions += '3. Schedule appointments:\n';
  instructions += '   - "I would love to get you scheduled! When works best for you?"\n';
  instructions += '   - Collect: preferred date/time, timezone\n\n';
  
  instructions += 'PERSONALITY:\n';
  instructions += '- Warm, friendly, and professional\n';
  instructions += '- Patient - wait for caller to finish speaking before responding\n';
  instructions += '- Natural conversational tone\n';
  instructions += '- Be helpful about ' + businessName + '\n\n';
  
  instructions += 'CONVERSATION GUIDELINES:\n';
  instructions += '- Use natural acknowledgments: "Absolutely!", "Great question!", "I hear you!"\n';
  instructions += '- Ask follow-up questions to understand their needs\n';
  instructions += '- Keep the conversation flowing naturally\n';
  instructions += '- DO NOT rush to end the call\n';
  instructions += '- DO NOT speak immediately after greeting - WAIT for the caller to respond first\n\n';
  
  instructions += 'LANGUAGE:\n';
  instructions += '- ALWAYS speak English by default\n';
  instructions += '- Only switch languages if caller explicitly requests\n\n';
  
  instructions += 'WHAT TO AVOID:\n';
  instructions += '- Do not be robotic or scripted\n';
  instructions += '- Do not rush responses\n';
  instructions += '- Do not interrupt the caller\n';
  instructions += '- Do not say "Is there anything else?" after every answer\n';
  instructions += '- Do not provide details you do not know - offer a callback instead\n\n';
  
  instructions += '🎯 REMEMBER: Your primary job is to represent ' + businessName + ' professionally and capture lead information!';
  
  return instructions;
}

app.post('/incoming-call', async (req, res) => {
  console.log('📞 INCOMING CALL');
  console.log('');
  console.log('🔍 REQUEST BODY (SANITIZED):');
  console.log(JSON.stringify(sanitizeForLog(req.body), null, 2));
  console.log('');
  
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;
  const called = req.body.Called;
  const calledVia = req.body.CalledVia;
  const forwardedFrom = req.body.ForwardedFrom;
  
  console.log('📋 CALL DETAILS:');
  console.log('   From:', from);
  console.log('   To:', to);
  console.log('   CallSid:', callSid);
  console.log('');
  
  try {
    const response = await fetch(process.env.SUPABASE_URL + '/functions/v1/make-server-4e1c9511/calls/bridge-log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY
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
      console.error('❌ Failed to log call start');
    } else {
      console.log('✅ Call logged to database');
    }
  } catch (error) {
    console.error('❌ Error logging call start:', sanitizeForLog(error));
  }
  
  const twiml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Response>\n' +
    '  <Connect>\n' +
    '    <Stream url="wss://' + req.headers.host + '/media-stream">\n' +
    '      <Parameter name="callSid" value="' + callSid + '" />\n' +
    '      <Parameter name="from" value="' + from + '" />\n' +
    '      <Parameter name="to" value="' + to + '" />\n' +
    '    </Stream>\n' +
    '  </Connect>\n' +
    '</Response>';
  
  res.type('text/xml');
  res.send(twiml);
});

wss.on('connection', async (ws, req) => {
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('🔌 NEW WEBSOCKET CONNECTION');
  console.log('═══════════════════════════════════════');
  
  const sessionId = uuidv4();
  let callSid = null;
  let streamSid = null;
  let openaiWs = null;
  let callStartTime = Date.now();
  let toPhoneNumber = null;
  let fromPhoneNumber = null;
  let userSettings = null;
  let conversationContext = {
    messages: [],
    leadInfo: {},
    appointmentRequested: false,
    currentResponse: ''
  };
  
  activeSessions.set(sessionId, {
    twilioWs: ws,
    openaiWs: null,
    callSid: null,
    startTime: callStartTime
  });
  
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message.toString());
      
      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          
          const customParams = msg.start.customParameters;
          toPhoneNumber = customParams?.to || msg.start.to;
          fromPhoneNumber = customParams?.from || msg.start.from;
          
          console.log('📞 CALL STARTED');
          console.log('   CallSid:', callSid);
          console.log('   StreamSid:', streamSid);
          console.log('   To Phone:', toPhoneNumber);
          console.log('   From Phone:', fromPhoneNumber);
          
          const session = activeSessions.get(sessionId);
          if (session) {
            session.callSid = callSid;
          }
          
          userSettings = await getUserSettingsByPhone(toPhoneNumber);
          
          if (!userSettings) {
            console.log('⚠️  WARNING: No settings found - using default');
            console.log('⚠️  AI will greet with "the business" instead of your business name');
            console.log('⚠️  To fix: Ensure phone number in Settings matches exactly:', toPhoneNumber);
          }
          
          await initializeOpenAI(userSettings);
          break;
          
        case 'media':
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
            };
            openaiWs.send(JSON.stringify(audioAppend));
          }
          break;
          
        case 'stop':
          console.log('📞 CALL ENDED');
          await handleCallEnd(callSid, callStartTime, conversationContext, toPhoneNumber, fromPhoneNumber, userSettings);
          
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
          break;
      }
    } catch (error) {
      console.error('❌ Error processing Twilio message:', sanitizeForLog(error));
    }
  });
  
  async function initializeOpenAI(settings) {
    // ElevenLabs speech synthesis function
    async function speakWithElevenLabs(text) {
      if (!text || text.trim() === '') return;
      
      try {
        console.log('🎤 ElevenLabs speaking:', text.substring(0, 50) + '...');
        
        const audioStream = await elevenlabs.textToSpeech.convertAsStream(
          'nJvj5shg2xu1GKGxqfkE',  // Voice ID
          {
            text: text,
            model_id: 'eleven_multilingual_v2',
            output_format: 'ulaw_8000'  // Match Twilio format
          }
        );
        
        // Stream audio chunks to Twilio
        for await (const chunk of audioStream) {
          if (ws.readyState === ws.OPEN) {
            const base64Audio = Buffer.from(chunk).toString('base64');
            const audioPayload = {
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: base64Audio
              }
            };
            ws.send(JSON.stringify(audioPayload));
          }
        }
        
        console.log('✅ ElevenLabs speech complete');
      } catch (error) {
        console.error('❌ ElevenLabs error:', sanitizeForLog(error));
      }
    }
    
    try {
      console.log('🔗 Connecting to OpenAI Realtime API...');
      
      openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
        headers: {
          'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
          'OpenAI-Beta': 'realtime=v1'
        }
      });
      
      openaiWs.on('open', () => {
        console.log('✅ Connected to OpenAI Realtime API');
        
        const instructions = buildAIInstructions(settings);
        
        console.log('⚙️  Configuring OpenAI session...');
        console.log('🎤 Voice Mode: ElevenLabs (nJvj5shg2xu1GKGxqfkE)');
        
        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],  // Accept audio input, generate text output
            instructions: instructions,
            input_audio_format: 'g711_ulaw',
            input_audio_transcription: {
              model: 'whisper-1'
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.6,
              prefix_padding_ms: 300,
              silence_duration_ms: 1200
            },
            temperature: 0.9,
            max_response_output_tokens: 4096
          }
        }));
      });
      
      openaiWs.on('message', async (data) => {
        try {
          const event = JSON.parse(data.toString());
          
          switch (event.type) {
            case 'session.created':
              console.log('✅ OpenAI session created');
              break;
              
            case 'session.updated':
              console.log('✅ OpenAI session configured');
              
              const businessName = settings?.businessName || 'the business';
              console.log('🎤 Triggering greeting with business name: "' + businessName + '"');
              
              // Trigger OpenAI to generate the greeting text
              openaiWs.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['text'],
                  instructions: `Greet the caller with: "Hi! Thanks so much for calling ${businessName}! How can I help you today?"`
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
              
            case 'conversation.item.input_audio_transcription.completed':
              console.log('👤 User:', event.transcript);
              extractLeadInfo(event.transcript, conversationContext);
              break;
              
            case 'response.text.delta':
              // Accumulate text chunks
              if (!conversationContext.currentResponse) {
                conversationContext.currentResponse = '';
              }
              conversationContext.currentResponse += event.delta;
              break;
              
            case 'response.text.done':
              // Full text response received from OpenAI
              const fullText = conversationContext.currentResponse || event.text;
              console.log('🤖 AI Response:', fullText);
              
              // Send to ElevenLabs for speech synthesis
              await speakWithElevenLabs(fullText);
              
              // Clear the accumulated response
              conversationContext.currentResponse = '';
              break;
              
            case 'error':
              console.error('❌ OpenAI error:', sanitizeForLog(event.error));
              break;
          }
        } catch (error) {
          console.error('❌ Error processing OpenAI message:', sanitizeForLog(error));
        }
      });
      
      openaiWs.on('error', (error) => {
        console.error('❌ OpenAI WebSocket error:', sanitizeForLog(error));
      });
      
      openaiWs.on('close', () => {
        console.log('🔌 OpenAI WebSocket closed');
      });
      
      const session = activeSessions.get(sessionId);
      if (session) {
        session.openaiWs = openaiWs;
      }
      
    } catch (error) {
      console.error('❌ Failed to connect to OpenAI:', sanitizeForLog(error));
    }
  }
  
  ws.on('close', () => {
    console.log('🔌 Twilio WebSocket closed');
    console.log('═══════════════════════════════════════');
    console.log('');
    activeSessions.delete(sessionId);
    
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
  
  ws.on('error', (error) => {
    console.error('❌ Twilio WebSocket error:', sanitizeForLog(error));
  });
});

function extractLeadInfo(transcript, context) {
  const text = transcript.toLowerCase();
  
  const emailMatch = transcript.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) {
    context.leadInfo.email = emailMatch[0];
    console.log('📧 Email captured:', emailMatch[0]);
  }
  
  if (text.includes('my name is') || text.includes("i'm ")) {
    const nameMatch = transcript.match(/(?:my name is|i'm|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
    if (nameMatch) {
      context.leadInfo.name = nameMatch[1];
      console.log('👤 Name captured:', nameMatch[1]);
    }
  }
  
  if (text.includes('appointment') || text.includes('booking') || text.includes('schedule')) {
    context.appointmentRequested = true;
    console.log('📅 Appointment requested');
  }
}

async function handleCallEnd(callSid, startTime, context, toPhoneNumber, fromPhoneNumber, userSettings) {
  const duration = Math.floor((Date.now() - startTime) / 1000);
  
  console.log('📊 CALL SUMMARY:');
  console.log('   Duration:', duration + 's');
  console.log('   Lead Captured:', (!!context.leadInfo.name || !!context.leadInfo.email ? 'Yes' : 'No'));
  console.log('   Appointment Requested:', (context.appointmentRequested ? 'Yes' : 'No'));
  
  // Use the actual userId from settings, not 'system'
  const userId = userSettings?.userId || 'unknown';
  
  // Store the caller's phone number if we don't have one from the conversation
  if (!context.leadInfo.phone && fromPhoneNumber) {
    context.leadInfo.phone = fromPhoneNumber;
    console.log('📱 Using caller phone:', fromPhoneNumber);
  }
  
  const callData = {
    callSid,
    duration,
    status: 'completed',
    leadCaptured: !!context.leadInfo.name || !!context.leadInfo.email,
    appointmentBooked: context.appointmentRequested,
    leadInfo: context.leadInfo,
    timestamp: new Date().toISOString()
  };
  
  try {
    await fetch(process.env.SUPABASE_URL + '/functions/v1/make-server-4e1c9511/calls/' + callSid, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY
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
    console.error('❌ Error updating call log:', sanitizeForLog(error));
  }
  
  if (context.leadInfo.name || context.leadInfo.email) {
    try {
      await fetch(process.env.SUPABASE_URL + '/functions/v1/make-server-4e1c9511/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          userId: userId,
          name: context.leadInfo.name || 'Unknown',
          email: context.leadInfo.email || '',
          phone: context.leadInfo.phone || '',
          source: 'phone_call',
          status: 'new',
          notes: 'Captured from call ' + callSid + '. Appointment requested: ' + context.appointmentRequested
        })
      });
      
      console.log('✅ Lead created');
    } catch (error) {
      console.error('❌ Error creating lead:', sanitizeForLog(error));
    }
  }
  
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
      console.error('❌ Error triggering n8n webhook:', sanitizeForLog(error));
    }
  }
}

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   🚀 Talkertive WebSocket Bridge Server         ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('📡 Server running on port ' + PORT);
  console.log('🔗 WebSocket: ws://localhost:' + PORT + '/media-stream');
  console.log('📞 Webhook: http://localhost:' + PORT + '/incoming-call');
  console.log('❤️  Health: http://localhost:' + PORT + '/health');
  console.log('');
  console.log('Environment:');
  console.log('  ✅ OpenAI:', process.env.OPENAI_API_KEY ? 'Configured' : '❌ Missing');
  console.log('  ✅ ElevenLabs:', process.env.ELEVENLABS_API_KEY ? 'Configured' : '❌ Missing');
  console.log('  ✅ Twilio:', process.env.TWILIO_ACCOUNT_SID ? 'Configured' : '❌ Missing');
  console.log('  ✅ Supabase:', process.env.SUPABASE_URL ? 'Configured' : '❌ Missing');
  console.log('');
  console.log('Ready to receive calls! 📞');
  console.log('');
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
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

function buildAIInstructions(userSettings) {
  const businessName = userSettings?.businessName || 'the business';
  const businessHours = userSettings?.businessHours || 'standard business hours';
  const customInstructions = userSettings?.aiPrompt || '';
  
  console.log('🤖 BUILDING AI INSTRUCTIONS:');
  console.log('   Business Name: "' + businessName + '"');
  
  let instructions = '═══════════════════════════════════════════════════════\n';
  instructions += '🎯 CRITICAL: SPEAK LIKE A REAL HUMAN RECEPTIONIST\n';
  instructions += '═══════════════════════════════════════════════════════\n\n';
  
  instructions += 'You are a warm, friendly receptionist for ' + businessName + '.\n';
  instructions += 'Business Hours: ' + businessHours + '\n\n';
  
  if (customInstructions) {
    instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    instructions += 'BUSINESS INFORMATION:\n' + customInstructions + '\n\n';
    instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  }
  
  instructions += 'GREETING:\n';
  instructions += '"Hi! Thanks so much for calling ' + businessName + '! How can I help you today?"\n\n';
  
  instructions += 'SPEAKING STYLE (CRITICAL - SOUND HUMAN!):\n';
  instructions += '✅ Use natural conversational filler words: "um", "you know", "let me see", "hmm"\n';
  instructions += '✅ Use contractions: "I\'m", "we\'re", "that\'s", "you\'re", "can\'t", "won\'t"\n';
  instructions += '✅ Add warmth: "Oh great!", "Perfect!", "Wonderful!", "Awesome!", "Absolutely!"\n';
  instructions += '✅ Show empathy: "I totally understand", "I hear you", "That makes sense"\n';
  instructions += '✅ Be conversational: Use short sentences, pause naturally\n';
  instructions += '✅ React naturally: "Oh!", "Ah!", "Mmhmm", "Right", "Gotcha"\n';
  instructions += '✅ Ask clarifying questions naturally: "So just to make sure I got that right..."\n';
  instructions += '✅ Use friendly language: "Would love to help!", "Happy to assist!"\n\n';
  
  instructions += '❌ AVOID (SOUNDS ROBOTIC):\n';
  instructions += '- Formal language: "I would be delighted to assist you" → Use "I\'d be happy to help!"\n';
  instructions += '- Perfect grammar all the time\n';
  instructions += '- Overly structured responses\n';
  instructions += '- Corporate speak\n';
  instructions += '- Saying "Is there anything else?" after EVERY answer\n\n';
  
  instructions += 'CONVERSATION FLOW:\n';
  instructions += '1. Listen actively - let them finish speaking\n';
  instructions += '2. Acknowledge what they said: "Okay, so you\'re looking to..."\n';
  instructions += '3. Respond naturally with helpful info\n';
  instructions += '4. Capture their info smoothly: "I\'d love to get your name for our records!"\n';
  instructions += '5. Keep it flowing - don\'t rush to end the call\n\n';
  
  instructions += 'LEAD CAPTURE (naturally weave into conversation):\n';
  instructions += '- Name: "By the way, what\'s your name?"\n';
  instructions += '- Email: "What\'s a good email I can send some info to?"\n';
  instructions += '- Phone: "And what\'s a good callback number?"\n\n';
  
  instructions += 'REMEMBER: You\'re a REAL person having a REAL conversation. Be warm, natural, and helpful!\n';
  
  return instructions;
}

app.post('/incoming-call', async (req, res) => {
  console.log('📞 INCOMING CALL');
  
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;
  
  console.log('   From:', from);
  console.log('   To:', to);
  
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
  console.log('🔌 NEW WEBSOCKET CONNECTION');
  
  const sessionId = uuidv4();
  let callSid = null;
  let streamSid = null;
  let openaiWs = null;
  let toPhoneNumber = null;
  let fromPhoneNumber = null;
  let userSettings = null;
  
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
          console.log('   To Phone:', toPhoneNumber);
          
          userSettings = await getUserSettingsByPhone(toPhoneNumber);
          await initializeOpenAI(userSettings);
          break;
          
        case 'media':
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
            }));
          }
          break;
          
        case 'stop':
          console.log('📞 CALL ENDED');
          if (openaiWs) openaiWs.close();
          break;
      }
    } catch (error) {
      console.error('❌ Error:', sanitizeForLog(error));
    }
  });
  
  async function initializeOpenAI(settings) {
    try {
      console.log('🔗 Connecting to OpenAI...');
      
      openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
        headers: {
          'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
          'OpenAI-Beta': 'realtime=v1'
        }
      });
      
      openaiWs.on('open', () => {
        console.log('✅ Connected to OpenAI');
        
        const instructions = buildAIInstructions(settings);
        
        console.log('🎤 Voice: Shimmer (warm & natural)');
        
        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: instructions,
            voice: 'shimmer', // CHANGED: Shimmer is warmer and more natural than Alloy
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5, // CHANGED: Lower threshold for more natural conversation
              prefix_padding_ms: 300,
              silence_duration_ms: 800 // CHANGED: Shorter silence = more natural back-and-forth
            },
            temperature: 1.0, // CHANGED: Higher temperature = more natural variation
            max_response_output_tokens: 150 // CHANGED: Shorter responses = more natural conversation
          }
        }));
      });
      
      openaiWs.on('message', async (data) => {
        try {
          const event = JSON.parse(data.toString());
          
          if (event.type === 'session.updated') {
            console.log('✅ Session configured - triggering greeting');
            openaiWs.send(JSON.stringify({ type: 'response.create' }));
          }
          
          if (event.type === 'response.audio.delta' && event.delta) {
            const audioPayload = {
              event: 'media',
              streamSid: streamSid,
              media: { payload: event.delta }
            };
            ws.send(JSON.stringify(audioPayload));
          }
          
          if (event.type === 'conversation.item.input_audio_transcription.completed') {
            console.log('👤 User:', event.transcript);
          }
          
          if (event.type === 'response.audio_transcript.done') {
            console.log('🤖 AI:', event.transcript);
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
    if (openaiWs) openaiWs.close();
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('🚀 Talkertive WebSocket Bridge Server');
  console.log('📡 Port:', PORT);
  console.log('🎤 Voice: Shimmer (warm & human-like)');
  console.log('');
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  server.close(() => process.exit(0));
});
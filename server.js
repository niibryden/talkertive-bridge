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
  
  instructions += 'You are Krystle, a warm, friendly receptionist for ' + businessName + '.\n';
  instructions += 'Business Hours: ' + businessHours + '\n\n';
  
  if (customInstructions) {
    instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    instructions += 'BUSINESS INFORMATION:\n' + customInstructions + '\n\n';
    instructions += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  }
  
  instructions += 'GREETING (USE THIS EXACTLY):\n';
  instructions += '"Hi! Thank you for calling ' + businessName + ' today. My name is Krystle, how can I help you?"\n\n';
  
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
  
  instructions += 'LEAD CAPTURE (Use the capture_lead_info function when you get customer info):\n';
  instructions += '- When they give you their name → call capture_lead_info with name\n';
  instructions += '- When they give you their email → call capture_lead_info with email\n';
  instructions += '- When they tell you what they need → call capture_lead_info with notes\n';
  instructions += '- Call the function IMMEDIATELY when you get new info, don\'t wait until end of call\n\n';
  
  instructions += 'APPOINTMENT BOOKING (Use the book_appointment function when they want to schedule):\n';
  instructions += '- Ask for preferred date and time naturally\n';
  instructions += '- Get their name, phone, and email if you don\'t have it yet\n';
  instructions += '- Call book_appointment with all the details\n';
  instructions += '- Confirm: "Perfect! I\'ve got you scheduled for [date/time]. You\'ll receive a confirmation email shortly!"\n\n';
  
  instructions += 'ORDER STATUS LOOKUP (Use the lookup_order_status function when customers ask about their order):\n';
  instructions += '- Listen for phrases like: "Where\'s my order?", "Order status", "Track my order", "Check on order #12345"\n';
  instructions += '- Ask for the order number: "Sure! What\'s your order number? It should start with ORD or just be numbers."\n';
  instructions += '- Call lookup_order_status with the order ID they provide\n';
  instructions += '- If found: Read the status naturally - "Great news! Your order is [status]. [additional info]"\n';
  instructions += '- If not found: "Hmm, I couldn\'t find that order. Could you double-check the number? Or I can have someone call you back to help!"\n';
  instructions += '- Always be empathetic and helpful with order inquiries\n\n';
  
  instructions += 'REMEMBER: You\'re Krystle - a REAL person having a REAL conversation. Be warm, natural, and helpful!\n';
  
  return instructions;
}

// Define function tools for OpenAI
const FUNCTION_TOOLS = [
  {
    type: 'function',
    name: 'capture_lead_info',
    description: 'Capture customer information in real-time during the conversation. Call this IMMEDIATELY when you learn new info about the customer, don\'t wait until the end of the call.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Customer\'s full name'
        },
        email: {
          type: 'string',
          description: 'Customer\'s email address'
        },
        phone: {
          type: 'string',
          description: 'Customer\'s phone number (if different from caller ID)'
        },
        notes: {
          type: 'string',
          description: 'Any important notes about what the customer needs or is asking about'
        }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'book_appointment',
    description: 'Book an appointment for the customer. Call this when the customer wants to schedule a time to meet or have a service.',
    parameters: {
      type: 'object',
      properties: {
        customerName: {
          type: 'string',
          description: 'Customer\'s full name'
        },
        customerEmail: {
          type: 'string',
          description: 'Customer\'s email address'
        },
        customerPhone: {
          type: 'string',
          description: 'Customer\'s phone number'
        },
        dateTime: {
          type: 'string',
          description: 'Appointment date and time in ISO 8601 format (e.g., 2024-01-15T14:30:00-05:00)'
        },
        duration: {
          type: 'number',
          description: 'Duration of appointment in minutes (default: 30)'
        },
        purpose: {
          type: 'string',
          description: 'Purpose of the appointment (consultation, service, meeting, etc.)'
        },
        timeZone: {
          type: 'string',
          description: 'Time zone for the appointment (e.g., America/New_York, America/Los_Angeles)'
        }
      },
      required: ['customerName', 'dateTime', 'purpose']
    }
  },
  {
    type: 'function',
    name: 'lookup_order_status',
    description: 'Look up the status of a customer\'s order when they provide an order ID. Call this when the customer asks about their order status, tracking, or delivery information.',
    parameters: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'The order ID provided by the customer (e.g., ORD-12345, #12345, or 12345)'
        }
      },
      required: ['orderId']
    }
  }
];

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
  let userId = null;
  let callStartTime = new Date();
  
  // Track captured lead info
  let capturedLeadInfo = {
    name: null,
    email: null,
    phone: null,
    notes: null
  };
  
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
          console.log('   From Phone:', fromPhoneNumber);
          console.log('   Call SID:', callSid);
          
          userSettings = await getUserSettingsByPhone(toPhoneNumber);
          userId = userSettings?.userId;
          
          if (userId) {
            // Log call start to backend
            try {
              await fetch(process.env.SUPABASE_URL + '/functions/v1/make-server-4e1c9511/calls/bridge-log', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY
                },
                body: JSON.stringify({
                  callSid,
                  toNumber: toPhoneNumber,
                  fromNumber: fromPhoneNumber,
                  status: 'in-progress',
                  duration: 0
                })
              });
              console.log('✅ Call logged to backend');
            } catch (err) {
              console.error('⚠️ Failed to log call:', err.message);
            }
          }
          
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
          
          // Calculate duration
          const duration = Math.floor((new Date() - callStartTime) / 1000);
          
          // Update call log with final info
          if (userId && callSid) {
            try {
              await fetch(process.env.SUPABASE_URL + '/functions/v1/make-server-4e1c9511/calls/' + callSid, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY
                },
                body: JSON.stringify({
                  status: 'completed',
                  duration,
                  leadCaptured: !!(capturedLeadInfo.name || capturedLeadInfo.email)
                })
              });
              console.log('✅ Call finalized in backend');
            } catch (err) {
              console.error('⚠️ Failed to finalize call:', err.message);
            }
          }
          
          if (openaiWs) openaiWs.close();
          break;
      }
    } catch (error) {
      console.error('❌ Error:', sanitizeForLog(error));
    }
  });
  
  async function handleFunctionCall(functionName, functionArgs) {
    console.log('🔧 FUNCTION CALL:', functionName);
    console.log('📋 Args:', sanitizeForLog(functionArgs));
    
    if (functionName === 'capture_lead_info') {
      // Update captured lead info
      if (functionArgs.name) capturedLeadInfo.name = functionArgs.name;
      if (functionArgs.email) capturedLeadInfo.email = functionArgs.email;
      if (functionArgs.phone) capturedLeadInfo.phone = functionArgs.phone;
      if (functionArgs.notes) {
        capturedLeadInfo.notes = capturedLeadInfo.notes 
          ? capturedLeadInfo.notes + '\n' + functionArgs.notes
          : functionArgs.notes;
      }
      
      console.log('💾 Updated lead info:', sanitizeForLog(capturedLeadInfo));
      
      // Send to backend in real-time
      if (userId) {
        try {
          const response = await fetch(process.env.SUPABASE_URL + '/functions/v1/make-server-4e1c9511/leads/realtime-update', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY
            },
            body: JSON.stringify({
              userId,
              callSid,
              name: capturedLeadInfo.name,
              email: capturedLeadInfo.email,
              phone: capturedLeadInfo.phone || fromPhoneNumber,
              notes: capturedLeadInfo.notes
            })
          });
          
          if (response.ok) {
            console.log('✅ Lead updated in real-time!');
          } else {
            console.error('⚠️ Failed to update lead:', await response.text());
          }
        } catch (err) {
          console.error('⚠️ Failed to update lead:', err.message);
        }
      }
      
      return JSON.stringify({ 
        success: true, 
        message: 'Lead information captured successfully' 
      });
    }
    
    if (functionName === 'book_appointment') {
      console.log('📅 BOOKING APPOINTMENT');
      
      // Send appointment to backend
      if (userId) {
        try {
          const response = await fetch(process.env.SUPABASE_URL + '/functions/v1/make-server-4e1c9511/appointments/book', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY
            },
            body: JSON.stringify({
              userId,
              callSid,
              customerName: functionArgs.customerName || capturedLeadInfo.name,
              customerEmail: functionArgs.customerEmail || capturedLeadInfo.email,
              customerPhone: functionArgs.customerPhone || capturedLeadInfo.phone || fromPhoneNumber,
              dateTime: functionArgs.dateTime,
              duration: functionArgs.duration || 30,
              purpose: functionArgs.purpose,
              timeZone: functionArgs.timeZone || 'America/New_York'
            })
          });
          
          if (response.ok) {
            const result = await response.json();
            console.log('✅ Appointment booked successfully!');
            console.log('📅 Calendar event created:', result.calendarEventCreated);
            
            return JSON.stringify({ 
              success: true, 
              message: 'Appointment booked successfully. Confirmation will be sent via email.',
              appointmentId: result.appointment?.id,
              calendarEventCreated: result.calendarEventCreated
            });
          } else {
            console.error('⚠️ Failed to book appointment:', await response.text());
            return JSON.stringify({ 
              success: false, 
              message: 'Failed to book appointment. Please try again.' 
            });
          }
        } catch (err) {
          console.error('⚠️ Failed to book appointment:', err.message);
          return JSON.stringify({ 
            success: false, 
            message: 'Failed to book appointment. Please try again.' 
          });
        }
      }
      
      return JSON.stringify({ 
        success: false, 
        message: 'Unable to book appointment at this time.' 
      });
    }
    
    if (functionName === 'lookup_order_status') {
      console.log('📦 LOOKING UP ORDER STATUS');
      console.log('Order ID:', functionArgs.orderId);
      
      // Clean up order ID (remove #, spaces, etc.)
      let cleanOrderId = functionArgs.orderId.toString().trim().toUpperCase();
      cleanOrderId = cleanOrderId.replace(/^#/, ''); // Remove leading #
      
      try {
        const response = await fetch(process.env.SUPABASE_URL + '/functions/v1/make-server-4e1c9511/orders/lookup/' + encodeURIComponent(cleanOrderId), {
          method: 'GET',
          headers: {
            'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY
          }
        });
        
        if (response.ok) {
          const result = await response.json();
          console.log('✅ Order found:', sanitizeForLog(result.order));
          
          const order = result.order;
          
          // Format response for AI to speak naturally
          let statusMessage = `I found your order! `;
          statusMessage += `Order ${order.orderId} `;
          
          if (order.customerName) {
            statusMessage += `for ${order.customerName} `;
          }
          
          statusMessage += `is currently ${order.status}. `;
          
          if (order.statusMessage) {
            statusMessage += `${order.statusMessage}. `;
          }
          
          if (order.estimatedDelivery) {
            statusMessage += `Your estimated delivery date is ${order.estimatedDelivery}. `;
          }
          
          if (order.trackingNumber) {
            statusMessage += `Your tracking number is ${order.trackingNumber}. `;
          }
          
          if (order.items && order.items.length > 0) {
            statusMessage += `This order includes: ${order.items.join(', ')}. `;
          }
          
          return JSON.stringify({
            success: true,
            message: statusMessage,
            order: order
          });
        } else {
          console.log('❌ Order not found');
          return JSON.stringify({
            success: false,
            message: `I couldn't find an order with ID ${cleanOrderId}. Could you please double-check the order number? It should be something like ORD-12345.`
          });
        }
      } catch (err) {
        console.error('⚠️ Failed to lookup order:', err.message);
        return JSON.stringify({
          success: false,
          message: 'I\'m having trouble looking up that order right now. Could you try again in a moment?'
        });
      }
    }
    
    return JSON.stringify({ success: false, message: 'Unknown function' });
  }
  
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
        
        console.log('🎤 Voice: Shimmer (Krystle)');
        console.log('🔧 Tools: capture_lead_info, book_appointment, lookup_order_status');
        
        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: instructions,
            voice: 'shimmer',
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 800
            },
            temperature: 1.0,
            max_response_output_tokens: 150,
            tools: FUNCTION_TOOLS
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
            console.log('🤖 Krystle:', event.transcript);
          }
          
          // Handle function calls
          if (event.type === 'response.function_call_arguments.done') {
            const functionName = event.name;
            const functionArgs = JSON.parse(event.arguments);
            
            // Execute function
            const result = await handleFunctionCall(functionName, functionArgs);
            
            // Send result back to OpenAI
            openaiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: event.call_id,
                output: result
              }
            }));
            
            // Continue the response
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
    if (openaiWs) openaiWs.close();
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('🚀 Talkertive WebSocket Bridge Server v2.0');
  console.log('📡 Port:', PORT);
  console.log('🎤 Receptionist: Krystle (Shimmer voice)');
  console.log('🔧 Features: Real-time lead capture + Appointment booking');
  console.log('');
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  server.close(() => process.exit(0));
});

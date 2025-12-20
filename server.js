// websocket-bridge.js
import { WebSocket, WebSocketServer } from 'ws';
import OpenAI from 'openai';
import fetch from 'node-fetch';

const wss = new WebSocketServer({ port: 8080 });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

wss.on('connection', async (ws, req) => {
  console.log('New Twilio MediaStream connection');
  
  // Extract call parameters from URL
  const url = new URL(req.url, 'http://localhost');
  const callSid = url.searchParams.get('callSid');
  const userId = url.searchParams.get('userId');
  
  let streamSid = null;
  let leadData = {
    name: '',
    phone: '',
    email: '',
    summary: '',
    timestamp: new Date().toISOString()
  };
  
  // Connect to ChatGPT Realtime API
  const realtimeSession = await openai.chat.completions.create({
    model: "gpt-4-realtime-preview",
    stream: true,
    messages: [{
      role: "system",
      content: `You are a friendly AI receptionist. Your job is to:
1. Greet the caller warmly
2. Ask for their name, phone number, and email
3. Ask why they're calling
4. Offer to schedule an appointment if appropriate
5. Be conversational and natural

Always extract and remember:
- Full name
- Phone number  
- Email address
- Reason for calling
- Whether they want an appointment`
    }]
  });
  
  // Handle incoming messages from Twilio
  ws.on('message', async (message) => {
    const msg = JSON.parse(message);
    
    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      console.log(`MediaStream started: ${streamSid}`);
    }
    
    if (msg.event === 'media') {
      // Forward audio to ChatGPT Realtime
      const audioChunk = Buffer.from(msg.media.payload, 'base64');
      // Process with ChatGPT + ElevenLabs
      // ... implementation details ...
    }
    
    if (msg.event === 'stop') {
      console.log('Call ended, sending lead data to platform');
      
      // Send lead data to your platform
      await fetch(`https://YOUR_PROJECT_ID.supabase.co/functions/v1/make-server-4e1c9511/webhook/lead-done`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({
          ...leadData,
          callSid,
          userId
        })
      });
    }
  });
});

console.log('WebSocket bridge running on wss://localhost:8080');
```

**Deployment Steps:**
1. Deploy to a hosting service with WebSocket support
2. Get your public WSS URL (e.g., `wss://your-bridge.railway.app`)
3. Update n8n workflow with the real URL
4. Configure environment variables

---

### Option 2: Use a Pre-Built Service (Quickest)

There are several services that handle Twilio + AI voice:

1. **Vocode.dev**
   - Website: https://vocode.dev
   - Pre-built Twilio + ChatGPT + ElevenLabs integration
   - Provides webhook URLs you can use directly
   - Pricing: ~$0.10/minute + AI costs

2. **Bland.ai**
   - Website: https://bland.ai
   - Full conversational AI for phone calls
   - Has webhook support for lead capture
   - Pricing: Custom

3. **Synthflow.ai**
   - Website: https://synthflow.ai
   - No-code AI phone agent builder
   - Twilio integration built-in
   - Pricing: From $30/month

**Setup with Pre-Built Service:**
1. Sign up for the service
2. Create an AI agent with your receptionist script
3. Get the WebSocket/Webhook URL from the service
4. Configure the service to send lead data to your platform backend:
   ```
   https://YOUR_PROJECT_ID.supabase.co/functions/v1/make-server-4e1c9511/webhook/lead-done
   ```
5. Update your n8n workflow with the service's WebSocket URL

---

### Option 3: Simplified Testing Setup (For Development)

For testing purposes, you can use a mock WebSocket that doesn't do real AI:

```javascript
// mock-websocket-bridge.js
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws) => {
  console.log('Mock WebSocket connected');
  
  ws.on('message', (message) => {
    const msg = JSON.parse(message);
    console.log('Received:', msg.event);
    
    if (msg.event === 'start') {
      console.log('Call started');
      
      // Simulate a short call ending with lead data
      setTimeout(() => {
        console.log('Simulating call end with lead data');
        // In real setup, Twilio sends 'stop' event
        // For testing, manually trigger lead webhook
      }, 5000);
    }
  });
});
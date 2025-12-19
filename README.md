# Talkertive.io WebSocket Bridge

This is the **WebSocket bridge server** that powers Talkertive.io's AI receptionist functionality. It connects:

- 📞 **Twilio** (phone calls)
- 🤖 **OpenAI Realtime API** (AI conversation)
- 🎙️ **ElevenLabs** (AI voice - optional, using OpenAI voice for now)
- 🗄️ **Supabase** (your backend database)

---

## 🚀 Quick Deploy to Railway

### Step 1: Get Your API Keys

Before deploying, you need these API keys:

#### 1. OpenAI API Key
- Go to: https://platform.openai.com/api-keys
- Create a new API key
- **Cost:** ~$0.06-0.30 per hour of conversation

#### 2. ElevenLabs API Key (Optional)
- Go to: https://elevenlabs.io/app/settings/api-keys
- Create a new API key
- **Cost:** $5-99/month depending on usage
- **Note:** Currently using OpenAI's built-in voice, but ElevenLabs provides higher quality

#### 3. Twilio Credentials
- Go to: https://console.twilio.com
- Get your **Account SID** and **Auth Token** from the dashboard
- Buy a phone number: https://console.twilio.com/us1/develop/phone-numbers/manage/search
- **Cost:** $1-2/month per number + $0.0085/minute for calls

#### 4. Supabase Credentials
- You already have these from your Talkertive.io platform
- Find them in your Supabase project settings

---

### Step 2: Deploy to Railway

1. **Create a GitHub repository** (if you haven't already)
   ```bash
   cd websocket-bridge
   git init
   git add .
   git commit -m "Initial commit - Talkertive WebSocket Bridge"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/talkertive-bridge.git
   git push -u origin main
   ```

2. **Go to Railway**: https://railway.app

3. **Click "New Project"** → **"Deploy from GitHub repo"**

4. **Select your repository**: `talkertive-bridge`

5. **Add Environment Variables**:
   Click on your deployment → **Variables** tab → Add all these:
   
   ```
   PORT=3000
   NODE_ENV=production
   OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxx
   ELEVENLABS_API_KEY=xxxxxxxxxxxxx
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=xxxxxxxxxxxxx
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxxxx
   ```

6. **Deploy**: Railway will automatically detect Node.js and deploy

7. **Get your Railway URL**: 
   - Go to **Settings** → **Networking** → **Generate Domain**
   - You'll get a URL like: `your-app.railway.app`
   - **Save this URL** - you need it for Twilio!

---

### Step 3: Configure Twilio Webhook

1. **Go to Twilio Console**: https://console.twilio.com/us1/develop/phone-numbers/manage/incoming

2. **Click on your phone number**

3. **Scroll to "Voice Configuration"**

4. **Set "A Call Comes In" webhook**:
   ```
   URL: https://your-app.railway.app/incoming-call
   Method: HTTP POST
   ```

5. **Save**

---

### Step 4: Test Your AI Receptionist! 📞

1. **Call your Twilio phone number**

2. **You should hear the AI receptionist answer!**

3. **Check logs**:
   - Railway: Go to your project → **Deployments** → Click latest → **View Logs**
   - You'll see real-time connection logs

4. **Check your Talkertive.io dashboard**:
   - Go to **Call Logs** - you should see the call appear
   - Go to **Leads** - if you gave your name/email during the call, it should be captured

---

## 🧪 Testing Locally (Optional)

If you want to test locally before deploying:

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Edit .env with your API keys
nano .env

# Run the server
npm start
```

To test with Twilio locally, you need to expose your local server:

```bash
# Install ngrok: https://ngrok.com
ngrok http 3000

# Use the ngrok URL in Twilio webhook:
# https://xxxx-xx-xx-xxx-xxx.ngrok-free.app/incoming-call
```

---

## 📊 Monitoring

### Health Check
Visit: `https://your-app.railway.app/health`

You should see:
```json
{
  "status": "healthy",
  "service": "talkertive-websocket-bridge",
  "activeSessions": 0,
  "timestamp": "2024-12-19T..."
}
```

### Railway Logs
- Real-time logs show:
  - Incoming calls
  - WebSocket connections
  - OpenAI API interactions
  - Lead capture events
  - Errors

### Talkertive.io Dashboard
- **Settings → System Status** - shows WebSocket bridge connectivity
- **Call Logs** - shows all incoming calls
- **Leads** - shows captured lead information

---

## 🔧 Troubleshooting

### "WebSocket connection failed"
- Check that your Railway app is deployed and running
- Verify the Railway URL is correct in Twilio webhook
- Check Railway logs for errors

### "OpenAI authentication failed"
- Verify your `OPENAI_API_KEY` is correct
- Make sure you have credits in your OpenAI account
- Check that you have access to the Realtime API (it's in beta)

### "No audio on the call"
- This usually means the WebSocket isn't connecting properly
- Check Railway logs for connection errors
- Verify Twilio webhook is pointing to the correct URL

### "Calls not showing in dashboard"
- Check that `SUPABASE_URL` and `SUPABASE_ANON_KEY` are correct
- Verify your Supabase backend is running
- Check Railway logs for API errors

---

## 💰 Cost Estimates

### Railway Hosting
- **Starter Plan**: $5/month (sufficient for testing and low volume)
- **Developer Plan**: $20/month (recommended for production)

### Per-Call Costs (5-minute call example)
- **Twilio**: $0.04 per call
- **OpenAI Realtime**: $0.025 per call
- **Total per call**: ~$0.07

### Monthly Estimates
- **100 calls/month**: ~$12 in usage + $5-20 Railway = **$17-32/month**
- **500 calls/month**: ~$35 in usage + $20 Railway = **$55/month**
- **2000 calls/month**: ~$140 in usage + $20 Railway = **$160/month**

**Your pricing**: $149-399/month per customer = **Healthy profit margins** ✅

---

## 🔐 Security Notes

- ✅ All API keys are stored as environment variables (never in code)
- ✅ HTTPS/WSS encryption for all connections
- ✅ Twilio validates webhook signatures (can be enhanced)
- ✅ Supabase handles authentication

**Recommended enhancements**:
- Add Twilio webhook signature validation
- Implement rate limiting
- Add request logging for security audits

---

## 📞 Support

If you run into issues:

1. **Check Railway logs** - most issues show up here
2. **Check Twilio debugger**: https://console.twilio.com/us1/monitor/debugger
3. **Check OpenAI status**: https://status.openai.com
4. **Test health endpoint**: `https://your-app.railway.app/health`

---

## 🎯 Next Steps

Once your bridge is deployed and working:

1. ✅ **Test end-to-end**: Call your number and have a conversation
2. ✅ **Check lead capture**: Verify leads appear in your dashboard
3. ✅ **Customize AI instructions**: Edit the `instructions` field in `server.js`
4. ✅ **Add your business info**: Update the AI with your company details
5. ✅ **Set up multiple numbers**: Add more Twilio numbers for different clients
6. ✅ **Enable multilingual**: AI already supports multiple languages automatically

---

## 📝 License

MIT License - Talkertive.io

---

**Ready to take calls?** 🚀

Deploy to Railway, configure Twilio, and start receiving calls with your AI receptionist!

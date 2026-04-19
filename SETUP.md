# CodeForge Instagram Bot — ManyChat Setup Guide

## Step 1 — Create ManyChat Account

1. Go to https://manychat.com
2. Click "Get Started Free"
3. Sign up with your email
4. Choose "Instagram" as your channel

---

## Step 2 — Connect Instagram Business Account

Requirements before connecting:
- Instagram account must be a **Professional/Business account**
  (Instagram → Settings → Account → Switch to Professional Account)
- Instagram must be connected to a **Facebook Page**
  (Facebook → Settings → Linked Accounts → Instagram)

In ManyChat:
1. Go to Settings → Channels → Instagram
2. Click "Connect Instagram"
3. Log in with Facebook → Select your Facebook Page
4. Select your Instagram account
5. Click "Connect"

---

## Step 3 — Get ManyChat API Key

1. In ManyChat → go to Settings (gear icon)
2. Click "API" in left sidebar
3. Click "Generate API Key"
4. Copy the key — looks like: `Bearer eyJhbGci...`
5. Save it — you'll need it in .env

---

## Step 4 — Expose Your Server Publicly

### For Testing (Local Machine) — use ngrok

```bash
# Install ngrok
npm install -g ngrok

# Start your bot server first
cd D:\offlineai\instagram-bot
npm start

# In another terminal — expose port 3000
ngrok http 3000
```

ngrok gives you a URL like:
`https://abc123.ngrok.io`

### For Production — use Railway (free hosting)

1. Go to https://railway.app
2. Sign up with GitHub
3. Click "New Project" → "Deploy from GitHub"
4. Connect your repo
5. Set environment variables (from .env.example)
6. Railway gives you: `https://your-app.railway.app`

---

## Step 5 — Create ManyChat Flow (receives DMs → sends to our server)

This is the key step — ManyChat needs to forward every DM to our server.

1. In ManyChat → go to **Flows** → click **"New Flow"**
2. Name it: "CodeForge Bot Handler"

3. Add trigger:
   - Click "+" → Add Trigger
   - Select **"Instagram: Any Message"**
   - This fires on EVERY DM the business receives

4. Add action step:
   - Click "+" → Add Step → **"External Request"**
   - Method: **POST**
   - URL: `https://your-server-url.com/webhook/manychat`
   - Headers: `Content-Type: application/json`
   - Body (select "Custom JSON"):
   ```json
   {
     "subscriber_id": "{{user_id}}",
     "first_name":    "{{first name}}",
     "last_name":     "{{last name}}",
     "text":          "{{last_input_text}}",
     "page_id":       "{{page_id}}"
   }
   ```

5. Click **"Publish Flow"**

---

## Step 6 — Set Environment Variables

Copy .env.example to .env and fill in:

```bash
cp .env.example .env
```

Edit .env:
```
PORT=3000
SERVER_URL=https://your-server-url.com
MANYCHAT_API_KEY=Bearer eyJhbGci...   ← from Step 3
RAZORPAY_KEY_ID=rzp_test_xxxx         ← from Razorpay dashboard
RAZORPAY_KEY_SECRET=xxxxxxxxxxxx
BUSINESS_NAME=Your Store Name
BUSINESS_GST=27AABCU9603R1ZX
```

---

## Step 7 — Start the Server

```bash
cd D:\offlineai\instagram-bot
npm start
```

You should see:
```
[CodeForge Instagram Bot] Running on port 3000
[ManyChat webhook] POST http://your-server.com/webhook/manychat
[Orders] No orders file found, starting fresh
[Catalog] Loaded 8 products
```

---

## Step 8 — Test It

1. Open Instagram on your phone
2. DM your business account: **"jeans"**
3. You should get a reply with product results within 5 seconds

---

## Step 9 — Upload Your Product Catalog

### Option A — CSV Upload (easiest)

Create a CSV file with these columns:
```
name, price, category, colors, sizes, material, image url, rating, tags
```

Example:
```
Blue Slim Jeans, 799, jeans, Blue;Dark Blue, 28;30;32;34;36, denim, https://img.jpg, 4.3, jeans;casual
```

Then call the upload endpoint:
```bash
curl -X POST http://localhost:3000/api/catalog/upload \
  -H "Content-Type: text/plain" \
  --data-binary @your-catalog.csv
```

### Option B — Manual via API

```bash
curl -X POST http://localhost:3000/api/catalog/add \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Blue Slim Jeans",
    "price": 799,
    "colors": ["Blue", "Black"],
    "sizes": ["28","30","32","34"],
    "category": "jeans",
    "imageUrl": "https://your-image.jpg"
  }'
```

---

## Step 10 — Set Up Razorpay (for payments)

1. Go to https://razorpay.com → Sign up
2. Complete KYC (business verification)
3. Go to Settings → API Keys → Generate Key
4. Copy Key ID and Secret to .env
5. Test with test keys first (rzp_test_xxx)

---

## Checklist

- [ ] ManyChat account created
- [ ] Instagram Business account connected
- [ ] ManyChat API key added to .env
- [ ] Server running and publicly accessible
- [ ] ManyChat flow created and published
- [ ] Product catalog uploaded
- [ ] Razorpay keys added
- [ ] Test DM sent and received reply

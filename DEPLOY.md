# Deployment Guide — FAQ Stress Tester

---

## Option A: Railway (Recommended)

Railway supports Python/Flask natively via Nixpacks. SSE streaming is supported with the `X-Accel-Buffering: no` header already added.

### Pre-requisites
- GitHub account with this repo pushed to it
- Railway account (railway.app)
- All 4 env vars ready (see below)

### Implementation Checklist

#### 1. Prepare the repo
- [ ] Push all code to a GitHub repository
- [ ] Confirm `Procfile`, `railway.toml`, and `requirements.txt` are committed
- [ ] Confirm `.env` is in `.gitignore` (never commit it)

#### 2. Google Service Account for Railway
- [ ] Open your `service_account.json` file
- [ ] Copy the **entire JSON content** (the `{ ... }` block)
- [ ] You will paste this as the value of `GOOGLE_SERVICE_ACCOUNT_JSON` in Railway (no file upload needed)

#### 3. Create the Railway project
- [ ] Go to railway.app → New Project → Deploy from GitHub repo
- [ ] Select this repository
- [ ] Railway will auto-detect Python and run Nixpacks build

#### 4. Set environment variables in Railway dashboard
Go to your service → Variables tab, add all 4:
- [ ] `ANTHROPIC_API_KEY` — your Claude API key
- [ ] `SLACK_WEBHOOK_URL` — your Slack incoming webhook URL
- [ ] `GOOGLE_DRIVE_FOLDER_ID` — the parent folder ID from Google Drive URL
- [ ] `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the full JSON content of your service account file

#### 5. Deploy
- [ ] Click Deploy (or it auto-deploys on push)
- [ ] Watch build logs — should complete in ~2 minutes
- [ ] Visit the generated Railway URL to confirm the upload screen loads
- [ ] Test with a sample `.xlsx` file end-to-end

#### 6. Custom domain (optional)
- [ ] In Railway → Settings → Domains → Add custom domain

---

## Option B: Render (Free Tier Available)

Use this if Railway doesn't work or you want a free-tier option.

### Implementation Checklist

#### 1. Prepare the repo
- [ ] Same as Railway — push to GitHub, confirm `Procfile` is present

#### 2. Create Render service
- [ ] Go to render.com → New → Web Service
- [ ] Connect GitHub repo
- [ ] Build command: `pip install -r requirements.txt`
- [ ] Start command: `gunicorn app:app --workers 1 --threads 4 --timeout 120`

#### 3. Set environment variables
- [ ] Add all 4 env vars in Render → Environment tab
- [ ] `GOOGLE_SERVICE_ACCOUNT_JSON` → paste full JSON content (same as Railway)

#### 4. Deploy
- [ ] Trigger deploy → wait for build
- [ ] Test on the Render `.onrender.com` URL

> Note: Render free tier spins down after 15 min of inactivity (cold start ~30s). Upgrade to paid to avoid this.

---

## Option C: Fly.io (Docker-based, most control)

Use this for production-grade deployments with persistent storage needs.

### Implementation Checklist

- [ ] Install flyctl: `curl -L https://fly.io/install.sh | sh`
- [ ] `fly auth login`
- [ ] `fly launch` — auto-detects Python, creates `fly.toml`
- [ ] Set secrets: `fly secrets set ANTHROPIC_API_KEY=... SLACK_WEBHOOK_URL=... GOOGLE_DRIVE_FOLDER_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='...'`
- [ ] `fly deploy`

---

## Frontend Checklist (already built — verify these work)

The frontend lives in `templates/index.html`, `static/style.css`, `static/main.js`.

- [ ] **Screen 1 (Upload):** Client Code field + drag-and-drop zone loads correctly
- [ ] **File validation:** Non-.xlsx files show an error before uploading
- [ ] **Client Code gate:** Empty client code blocks upload with an error message
- [ ] **File stats:** After upload, filename / total rows / FAQ count appear
- [ ] **Screen 2 (Processing):** Progress bar advances through all 7 stages
- [ ] **Stage list:** Each stage highlights active → turns green (done) as it completes
- [ ] **Screen 3 (Results):** Total / Processed / Needs Review stats display correctly
- [ ] **Download Doc button:** Downloads `FAQ_DocStyle_Output.docx`
- [ ] **Download Needs Review button:** Downloads `FAQ_Needs_Review.xlsx`
- [ ] **Open Drive Folder button:** Opens the correct Google Drive folder URL
- [ ] **Slack error notice:** Shows warning if Slack notification failed (but still shows results)
- [ ] **Process another file:** Reloads the page cleanly

---

## Backend Module Checklist (verify before deploy)

- [ ] `parser.py` — Excel parsed, session saved to `outputs/<session_id>/`
- [ ] `extractor.py` — Priority rules applied, Needs Review items separated
- [ ] `generator.py` — Claude API generates 2-paragraph answers, `.docx` + `.txt` created
- [ ] `uploader.py` — Drive folder created as `ClientCode_FAQ_Run_YYYY-MM-DD`, all files uploaded
- [ ] `notifier.py` — Slack message sent only after confirmed Drive upload
- [ ] Error handling — Drive failure blocks Slack; Slack failure still shows results page

---

## Environment Variables Reference

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `SLACK_WEBHOOK_URL` | Slack app settings → Incoming Webhooks |
| `GOOGLE_DRIVE_FOLDER_ID` | Open the Drive folder → copy ID from URL (`/folders/<ID>`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | GCP Console → IAM → Service Accounts → Keys → JSON (paste full content) |

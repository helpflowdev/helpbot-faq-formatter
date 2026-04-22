# Deployment Guide — FAQ Stress Tester

---

## Option A: Railway (Recommended)

Railway supports Next.js natively via Nixpacks. SSE streaming is supported with
the `X-Accel-Buffering: no` header already set in `app/api/process/route.js`.

### Pre-requisites
- GitHub account with this repo pushed to it
- Railway account (railway.app)
- All 4 env vars ready (see below)
- Node.js >= 20.9.0 locally (Railway will use the same via Nixpacks)

### Implementation Checklist

#### 1. Prepare the repo
- [ ] Push all code to a GitHub repository
- [ ] Confirm `Procfile`, `railway.toml`, and `package.json` are committed
- [ ] Confirm `.env.local` is in `.gitignore` (never commit it)

#### 2. Google Service Account for Railway
- [ ] Open your `service_account.json` file
- [ ] Copy the **entire JSON content** (the `{ ... }` block)
- [ ] You will paste this as the value of `GOOGLE_SERVICE_ACCOUNT_JSON` in
      Railway (no file upload needed)

#### 3. Create the Railway project
- [ ] Go to railway.app → New Project → Deploy from GitHub repo
- [ ] Select this repository
- [ ] Railway auto-detects Node.js and runs `npm install && npm run build`

#### 4. Set environment variables in Railway dashboard
Go to your service → Variables tab, add all 4:
- [ ] `OPENAI_API_KEY` — your OpenAI API key
- [ ] `SLACK_WEBHOOK_URL` — your Slack incoming webhook URL
- [ ] `GOOGLE_DRIVE_FOLDER_ID` — the parent folder ID from the Drive URL
- [ ] `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the full JSON content of your
      service account file

#### 5. Deploy
- [ ] Auto-deploys on push to `main` (or click Deploy)
- [ ] Watch build logs — should complete in ~2–3 minutes
- [ ] Visit the generated Railway URL to confirm the upload screen loads
- [ ] Test with a sample `.xlsx` file end-to-end

#### 6. Custom domain (optional)
- [ ] In Railway → Settings → Domains → Add custom domain

> **Why Railway (not Vercel):** this app writes generated files to
> `outputs/<session>/` before uploading to Google Drive. Vercel's serverless
> functions have a read-only filesystem, which breaks that flow. Railway gives
> a persistent container filesystem out of the box.

---

## Option B: Render

Use this if Railway doesn't work or you want a free-tier option.

### Implementation Checklist

#### 1. Prepare the repo
- [ ] Same as Railway — push to GitHub, confirm `Procfile` and `package.json`
      are present

#### 2. Create Render service
- [ ] Go to render.com → New → Web Service
- [ ] Connect GitHub repo
- [ ] Build command: `npm install && npm run build`
- [ ] Start command: `npm start`
- [ ] Node version: 20 or later (set in Environment tab if Render doesn't
      detect it)

#### 3. Set environment variables
- [ ] Add all 4 env vars in Render → Environment tab
- [ ] `GOOGLE_SERVICE_ACCOUNT_JSON` → paste full JSON content (same as Railway)

#### 4. Deploy
- [ ] Trigger deploy → wait for build
- [ ] Test on the Render `.onrender.com` URL

> **Note:** Render's free tier spins down after 15 min of inactivity
> (cold start ~30s). Upgrade to paid to avoid this. Also verify your plan
> supports a persistent disk for `outputs/` — free tiers often don't.

---

## Option C: Fly.io (Docker-based, most control)

Use this for production-grade deployments with a real persistent volume for
`outputs/`.

### Implementation Checklist

- [ ] Install flyctl: `curl -L https://fly.io/install.sh | sh`
- [ ] `fly auth login`
- [ ] `fly launch` — auto-detects Next.js, creates `fly.toml` + Dockerfile
- [ ] Attach a volume for `outputs/` (so generated files survive restarts):
      `fly volumes create faq_outputs --size 1`
      and mount it at `/app/outputs` in `fly.toml`
- [ ] Set secrets:
      `fly secrets set OPENAI_API_KEY=... SLACK_WEBHOOK_URL=... GOOGLE_DRIVE_FOLDER_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='...'`
- [ ] `fly deploy`

---

## Frontend Checklist (already built — verify these work)

The frontend lives in `app/page.jsx` and `app/globals.css` (Next.js App Router,
React single-page UI, no Tailwind).

- [ ] **Screen 1 (Upload):** Client Code field + drag-and-drop zone loads
      correctly
- [ ] **File validation:** Non-`.xlsx`/`.csv` files show an error before
      uploading
- [ ] **Client Code gate:** Empty client code blocks upload with an error
      message
- [ ] **File stats:** After upload, filename / total rows / FAQ count appear
- [ ] **Screen 2 (Processing):** Progress bar advances through all 7 stages
- [ ] **Stage list:** Each stage highlights active → turns green (done) as it
      completes
- [ ] **Screen 3 (Results):** Total / Processed / Needs Review stats display
      correctly
- [ ] **Rich text preview:** Main FAQs appear grouped by category; Needs
      Review entries display with their reason
- [ ] **Download Doc button:** Downloads `FAQ_DocStyle_Output.docx`
- [ ] **Download Needs Review button:** Downloads `FAQ_Needs_Review.xlsx`
- [ ] **Open Drive Folder button:** Opens the correct Google Drive folder URL
- [ ] **Slack error notice:** Shows warning if Slack notification failed
      (but still shows results)
- [ ] **Process another file:** Reloads the page cleanly

---

## Backend Module Checklist (verify before deploy)

- [ ] `lib/parser.js` — Excel/CSV parsed, session saved to
      `outputs/<session_id>/data.json` + `meta.json`
- [ ] `lib/extractor.js` — 4-step priority applied; RTO / Escalation / Other
      routed to Needs Review with `type` metadata
- [ ] `lib/generator.js` — batched category classification (20 per call),
      parallel rewrites (concurrency 5), outputs grouped by category
- [ ] `lib/uploader.js` — Drive folder created as
      `ClientCode_FAQ_Run_YYYY-MM-DD`, all files uploaded
- [ ] `lib/notifier.js` — Slack message sent only after confirmed Drive upload
- [ ] Error handling — Drive failure blocks Slack; Slack failure still shows
      results page

---

## Environment Variables Reference

| Variable | Where to get it |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com → API Keys |
| `SLACK_WEBHOOK_URL` | Slack app settings → Incoming Webhooks |
| `GOOGLE_DRIVE_FOLDER_ID` | Open the Drive folder → copy ID from URL (`/folders/<ID>`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | GCP Console → IAM → Service Accounts → Keys → JSON (paste full content) |

Locally these go in `.env.local` (Next.js loads it automatically). In Railway /
Render / Fly they go in the platform's secrets / env vars UI.

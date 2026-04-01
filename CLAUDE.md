# CLAUDE.md

## Project Context
This is the FAQ Stress Tester + Policy Regression Checker — a web-based tool that:
- Accepts .xlsx FAQ files
- Extracts policy-safe answers using strict priority rules
- Generates clean Doc-style customer-facing outputs
- Uploads results to Google Drive and sends a Slack notification

Always read the `PRD.md` file before coding any feature. The PRD is the source of truth.

---

## Tech Stack
- **Framework:** Next.js 14 (App Router)
- **Language:** JavaScript (JSX for UI)
- **Frontend:** React — single-page, 3-screen UI, minimal CSS (no Tailwind)
- **Excel Parsing:** SheetJS (`xlsx`)
- **Claude Integration:** Anthropic Node.js SDK (`@anthropic-ai/sdk`)
- **DOCX Generation:** `docx` npm package
- **Google Drive:** `googleapis` npm package (service account auth)
- **Slack:** Incoming Webhook (native `fetch`)
- **Config:** `.env.local` (Next.js built-in)
- **Deployment:** Railway (primary), Vercel not supported — requires persistent filesystem

---

## Project Structure
```
FAQ Formatter/
├── app/
│   ├── layout.jsx              # Root layout + CSS import
│   ├── globals.css             # All styles (minimal, single file)
│   ├── page.jsx                # 3-screen React UI (upload → processing → results)
│   └── api/
│       ├── upload/route.js     # POST — parse Excel, return session stats
│       ├── process/route.js    # GET  — SSE pipeline (extract → Claude → Drive → Slack)
│       └── download/[sessionId]/[filename]/route.js  # File download
├── lib/
│   ├── parser.js               # Excel parsing and session storage
│   ├── extractor.js            # Answer extraction logic (4-step priority)
│   ├── generator.js            # Claude API calls + file generation
│   ├── uploader.js             # Google Drive upload
│   └── notifier.js             # Slack notification
├── outputs/                    # Generated files (gitignored, persists on Railway)
├── .env.local                  # API keys and config (never commit)
├── .env.example                # Template for env vars
├── package.json
├── next.config.mjs
├── Procfile                    # Railway start command
├── railway.toml                # Railway build/deploy config
├── PRD.md                      # Product requirements (source of truth)
└── CLAUDE.md                   # This file
```

---

## Rules
- Always read `PRD.md` before coding any feature
- Do not assume missing logic — ask for clarification
- Never hardcode API keys, tokens, or credentials — use `.env` only
- Never commit `.env` to source control
- Never expose scenario lists, risk scores, or validation logs in the UI

---

## Critical Logic — Do Not Deviate

### Answer Extraction Priority (strictly in this order):
1. Use **Reply 1** if: not empty AND Condition 1 contains "GENERAL" or is blank
2. Else use **first Reply X** (1–17) where: not empty AND Condition X contains "GENERAL"
3. Else use **General guidance** if: not empty AND does NOT start with an internal marker
4. Else: mark as **Needs Review**, exclude from output

### Internal Content Detection (General guidance column only):
- Flag if General guidance starts with: `INTERNAL`, `NOT FOR CUSTOMER`, or similar
- Must: exclude from Doc output, add to Needs Review file

### Tone Rules (every answer must have):
- Acknowledgment (always required)
- Empathy (only when contextually applicable)
- Reassurance (always required)
- Policy-safe answer (never expand, never add promises, never invent timelines)

---

## Output Format Rules (STRICT)
- Question on its own line (no "Q:" label)
- Exactly 2 paragraphs per answer (no more, no less)
- No "Q:" / "A:", no numbering, no markdown, no labels, no metadata
- One blank line between FAQ entries
- Files to generate:
  - `FAQ_DocStyle_Output.docx`
  - `FAQ_DocStyle_Output.txt`
  - `FAQ_Needs_Review.xlsx` (columns: FAQ Title, Reason Flagged, Original Extracted Answer Source)
  - `FAQ_Validation_Report.csv` (dev/internal only)

---

## Environment Variables (required in .env)
```
ANTHROPIC_API_KEY=
SLACK_WEBHOOK_URL=
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_SERVICE_ACCOUNT_JSON=
```

---

## Coding Guidelines
- Keep code simple and readable
- Add comments for key logic blocks (especially extraction and tone enforcement)
- Avoid unnecessary complexity or abstraction
- Each module should have a single clear responsibility
- Handle all failure cases explicitly (Drive fail = no Slack; Slack fail = still show success)

---

## Workflow
- Propose file/folder structure before coding
- Wait for approval before major architectural changes
- Implement one module at a time, verify before moving on

---

## Output Expectations
- Code must be copy-paste ready and fully functional
- No broken or partial implementations
- No placeholder comments like `// TODO: implement this`
- Test with an actual .xlsx file structure matching the PRD column spec

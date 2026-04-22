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

### Status-Based Exclusion (checked before extraction):
- If Status contains `Archived`, `Submitted`, or `Suggested` (case-insensitive, substring):
  - Skip extraction entirely
  - Add to Needs Review, `type = "other"`, reason = `"Status: <value> — excluded from output"`

### Internal Content Detection (General guidance column only):
- Flag if General guidance starts with: `INTERNAL` (incl. `INTERNAL ONLY`), `NOT FOR CUSTOMER`, `DO NOT SHARE`, `CONFIDENTIAL`
- Route to Needs Review with `type = "internal-review"` and carry the full unredacted text as `answer`
- Generator runs INTERNAL_REVIEW_PROMPT (agent-procedure gate + rewrite in one call)

### Internal-Review Agent-Procedure Gate (single LLM call does both):
1. **Detect:** if the source describes step-by-step agent operations on internal tools (Shopify admin, Zendesk, Gorgias, Intercom, Freshdesk, Google Drive admin, Gmail admin, backend dashboards, agent consoles, CRM, etc. — OR login/navigate/click instructions, sequential workflow steps, agent-directed language), reply EXACTLY: `AGENT_PROCEDURE_NO_REWRITE`
2. **Rewrite (only if not agent procedure):** 2-paragraph customer-safe response, stripped of internal tool names and agent-directed language
3. **Output handling:** refused → no Suggested Response, show "Agent procedure — manual review required." Otherwise show Original Source + Suggested Response side-by-side so reviewer compares

### RTO / Escalation Routing (after extraction):
- **RTO** → Status column equals `"RTO"` (case-insensitive)
- **Escalation** → answer text contains any of: `gather details`, `gather information`, `escalat`, `raise a case`, `raise a ticket`, `create a case`, `create a ticket`, `follow up with you`
- RTO takes precedence if both match
- Both route to **Needs Review** (not main output), but STILL generate a 2-paragraph response
- `type = "rto"` or `"escalation"`

### Order-Related vs Pre-Sales (RTO / Escalation only):
Keyword match in BOTH title AND source answer (case-insensitive):
- Order-related keywords: `my order`, `order number`, `order #`, `tracking number`, `tracking`, `delivered`, `shipment status`, `where is my`, `cancel order`, `modify order`, `change order`, `return`, `refund`, `exchange`, `warranty`, `replace item`, `replacement`
- **Order-Related** → use `ESCALATION_PROMPT` (ask for email first, then complete name)
- **Pre-Sales** → use `CONSENT_PROMPT` (consent phrase, verbatim)

### Consent Phrase (verbatim, no paraphrasing):
> "In order to process your request, we will need to ask for your personal information such as your email address, and/or phone number. We will only use this information to handle your request and for no other purposes unless you give us your specific consent separately. Please type \"I Agree\" in the chat so we can proceed."

### Category Classification (fixed 20, fallback OTHERS):
Company Details, Ordering and Checkout, Order Status, Stock and Supply Inquiry, Returns/Refunds/Exchanges/Warranties, Shipping Information, Competitor Comparison, Discounts and Promotions, Rewards and Affiliate Program, Product Information, Product Recommendation, Account and Subscription, Wholesale, Order Cancellation/Modification/Tracking, Do you sell? Do you have?, Services, Installation/Guide, Technical Queries, Miscellaneous, OTHERS.
- Classify every FAQ (all types — normal, RTO, Escalation, Other)
- **Tags fast-path FIRST (no LLM):** if Tags (column M) contains a fixed-category name (longest match wins) OR a tag segment uniquely matches one category, pick that directly
- **Only items that don't fast-path go to the LLM.** Batch up to 20 per call
- LLM prompt includes: Title (always), Tags (when present), Keywords (column I, when present), and a 150-char answer snippet only when title has < 5 words

### Performance:
- Rewrites run in parallel with **concurrency limit of 5** (preserve original order in output)

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
- **Main output grouped by category** (fixed 20 order, skip empty categories). **Category headings are CENTERED** in DOCX (H1 with center alignment) and visually centered in TXT.
- **Needs Review sectioned in this order:** RTO → Escalation → Internal Review → Other (each grouped by category; category H2 also centered)
- **Every Needs Review item shows:** Title, Reason · Status · Tags · Keywords line, Original Source (with actual text), and — where applicable — Suggested Response (or agent-procedure notice)
- **No auto-Suggested Response for:** Archived, Submitted, Suggested, No-valid-answer (they show original text only so reviewer can decide)
- Files to generate:
  - `FAQ_DocStyle_Output.docx`
  - `FAQ_DocStyle_Output.txt`
  - `FAQ_Needs_Review.xlsx` columns: `FAQ Title, Type, Category, Reason Flagged, Status, Tags, Keywords, Source Column, Original Source Text, Generated Response`
  - `FAQ_Validation_Report.csv` (dev/internal only — adds Category, Type columns)

---

## Environment Variables (required in .env.local)
```
OPENAI_API_KEY=
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

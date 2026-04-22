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

### Row-level mode detection (applied FIRST)
- If **any** `Condition X` on the row is specific (non-blank, non-GENERAL) → **MULTI-FAQ mode**: the row is a container and emits one FAQ per non-empty slot
- Otherwise → **SINGLE-FAQ mode**: current 4-step priority applies

### Multi-FAQ mode (PRD §7f)
For each slot (Reply X, Condition X, Guidance X):
- Specific Condition + non-empty Reply → sub-FAQ: `title = Condition X`, `answer = Reply X`
- Specific Condition + **empty** Reply → Needs Review → Other with `title = Condition X` (Option 1 transparency — shown, not silently dropped)
- Blank/GENERAL Condition + non-empty Reply → sub-FAQ with row Title (anchor/default inside a multi-FAQ container)
- Sub-FAQs inherit row-level Tags, Keywords, Status, Category
- Per-sub-FAQ escalation/push-back check scans `Guidance X + row-level General guidance` concatenated
- Row Title is a container label only, NOT a customer-facing FAQ title in multi-FAQ mode

### Single-FAQ mode — Answer Extraction Priority (strictly in this order):
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

### Push-Back Pattern (PRD §7e) — TWO main-output FAQs from one row:
When the Reply is **clean** (no escalation keywords in its own text) AND the General guidance carries an escalation signal (`gather …details`, `RTO`, or any ESCALATION_KEYWORDS), AND Status is NOT `RTO`, the extractor emits **two main-output FAQs**:
1. **Primary** — `type = 'normal'`, original title, Reply content rewritten with SYSTEM_PROMPT
2. **Push-back** — `type = 'pushback'`, derived customer-voiced title ("If you need X before Y"), body is acknowledgment + verbatim consent sentence. Generated via `PUSHBACK_PROMPT` in one call that returns `TITLE: <title>` + body. Push-back's category is copied from the primary so they render adjacent.

No Needs Review entry is created for push-back rows. Escalations where the **Reply itself** directs to escalate still go to Needs Review → Escalation.

### Internal-Review Agent-Procedure Gate (single LLM call does both):
1. **Detect:** if the source describes step-by-step agent operations on internal tools (Shopify admin, Zendesk, Gorgias, Intercom, Freshdesk, Google Drive admin, Gmail admin, backend dashboards, agent consoles, CRM, etc. — OR login/navigate/click instructions, sequential workflow steps, agent-directed language), reply EXACTLY: `AGENT_PROCEDURE_NO_REWRITE`
2. **Rewrite (only if not agent procedure):** 2-paragraph customer-safe response, stripped of internal tool names and agent-directed language
3. **Output handling:** refused → no Suggested Response, show "Agent procedure — manual review required." Otherwise show Original Source + Suggested Response side-by-side so reviewer compares

### RTO / Escalation Routing (after extraction):
Escalation scan checks **BOTH** the extracted answer AND the General guidance column (GG often carries the escalation signal in an INTERNAL agent note).

- **RTO** → Status column equals `"RTO"` (case-insensitive) — always takes precedence
- **Escalation** → answer OR General guidance matches any of:
  - Regex `/gather\s+(?:all\s+|the\s+|necessary\s+)*(?:details?|info(?:rmation)?)/i` (covers `gather details`, `gather all necessary details`, `gather the info`, etc.)
  - Regex `/\brto\b/i` (standalone "RTO" word in text)
  - Substrings: `escalat`, `raise a case`, `raise a ticket`, `create a case`, `create a ticket`, `follow up with you`
- Both route to **Needs Review** (not main output), but STILL generate a 2-paragraph response. `type = "rto"` or `"escalation"`
- **`forceConsent` flag** (set on the item when `gather …details` regex OR `rto` regex matched): always use CONSENT_PROMPT regardless of order-related check. GDPR-safe default when collecting fresh PII.
- **`internalNote` field**: when the escalation trigger came from General guidance (not the Reply), the extractor copies GG text here; generator surfaces it as "Agent Note" in the review DOCX/TXT and as an xlsx column.

### Order-Related vs Pre-Sales (RTO / Escalation only, applied AFTER forceConsent):
If `forceConsent === true` → `CONSENT_PROMPT` (skip the check below).

Otherwise, keyword match in BOTH title AND source answer (case-insensitive):
- Order-related keywords: `my order`, `order number`, `order #`, `tracking number`, `tracking`, `delivered`, `shipment status`, `where is my`, `cancel order`, `modify order`, `change order`, `return`, `refund`, `exchange`, `warranty`, `replace item`, `replacement`
- **Order-Related** → `ESCALATION_PROMPT` (ask for email first, then complete name). Rationale: customer has an order on file so we already hold their info under their existing consent (GDPR).
- **Pre-Sales** → `CONSENT_PROMPT` (consent phrase, verbatim)

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
- Files to generate (each prefixed with sanitized Client Code; empty/missing → `CLIENT`):
  - `<CLIENT>_FAQ_Formatted.docx`
  - `<CLIENT>_FAQ_Formatted.txt`
  - `<CLIENT>_FAQ_Needs_Review.xlsx` columns: `FAQ Title, Type, Category, Reason Flagged, Status, Tags, Keywords, Source Column, Original Source Text, Agent Note, Generated Response`
  - `<CLIENT>_FAQ_Validation_Report.csv` (dev/internal only — adds Category, Type columns)
- Client Code sanitization: strip illegal chars, trim, spaces→`_`, collapse repeats, uppercase. e.g. `"My Client #1"` → `MY_CLIENT_1`

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

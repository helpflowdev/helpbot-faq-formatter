1. Project Name

FAQ Stress Tester + Policy Regression Checker

2. Goal

Build a web-based tool that:

uploads FAQ Excel files
extracts valid answers
enforces policy-safe formatting
outputs clean, customer-facing FAQ documents
auto-uploads results to Google Drive + sends Slack notification

3. Problem

FAQ updates are manual and inconsistent
Risk of policy violations (wrong tone, missing qualifiers)
Formatting takes time
No validation layer before deployment

4. Users

QA Testers
Product Solutions Specialists
Support / Bot Optimization Team

5. Workflow

User uploads .xlsx file
User enters Client Code (used for Drive folder naming)
System parses and detects FAQ rows
Extracts valid answers using rules
Filters out internal / invalid entries
Generates policy-safe answers via Claude
Formats into Doc-style output
Generates additional files (review + logs)
Uploads to Google Drive
Sends Slack notification
Displays results screen

6. Requirements

Upload & Parsing

Accept .xlsx only
Drag-and-drop support
Show:
  file name
  total rows
  total FAQs

Column Detection

Must auto-detect:

  Title
  General guidance
  Reply 1–17
  Condition 1–17
  Guidance 1–17
  Status (optional)

If Title column is missing → stop with descriptive error

7. Core Logic (VERY IMPORTANT)

Answer Extraction Rules

For each FAQ row, apply the following priority order:

1. Use Reply 1 if:
   not empty
   Condition 1 contains "GENERAL" OR is blank

2. Else → use first Reply X (X = 1–17) where:
   not empty
   Condition X contains "GENERAL"

3. Else → use General guidance if:
   not empty
   does NOT start with an internal marker (see Internal Detection below)

4. Else:
   mark as Needs Review
   exclude from Doc output

Status-Based Exclusion (checked first, before extraction)

If the Status column contains any of the following (case-insensitive, substring match):
  "Archived"
  "Submitted"
  "Suggested"

→ MUST:
  skip extraction entirely
  add to Needs Review with reason = "Status: <value> — excluded from output"
  type = "other"

Internal Content Detection

Check the General guidance column ONLY.
If General guidance begins with any of the following (case-insensitive):
  "INTERNAL"          (includes "INTERNAL ONLY")
  "NOT FOR CUSTOMER"
  "DO NOT SHARE"
  "CONFIDENTIAL"

→ MUST:
  exclude from main Doc output
  route to Needs Review with type = "internal-review" (see §7d)
  carry the full General guidance text so the agent-procedure gate can run

7a. RTO / Escalation Routing

After an answer is extracted, classify the FAQ as RTO, Escalation, or Normal.
The escalation scan runs against BOTH the extracted answer AND the General
guidance column — the INTERNAL agent note often carries the escalation
signal even when the Reply itself looks like a plain customer answer.

  RTO → Status column equals "RTO" (case-insensitive)

  Escalation (any of the following, case-insensitive, in answer OR General guidance):

    "Gather …details / info" phrase (regex):
      /gather\s+(?:all\s+|the\s+|necessary\s+)*(?:details?|info(?:rmation)?)/i
      (matches "gather details", "gather information",
       "gather all necessary details", "gather the details", etc.)

    "RTO" as a standalone word (regex):
      /\brto\b/i

    Substring keywords:
      "escalat"         (escalate / escalation / etc.)
      "raise a case"
      "raise a ticket"
      "create a case"
      "create a ticket"
      "follow up with you"

  Normal → none of the above

Routing:
  Normal → main Doc output (standard rewrite)
  RTO → Needs Review, type = "rto", still generates a 2-paragraph response
  Escalation → Needs Review, type = "escalation", still generates a response

RTO (status column) takes precedence over Escalation (keyword match) if both fire.

forceConsent flag:
  When an item matched via the "Gather …details" regex OR the standalone "RTO"
  regex, the extractor sets forceConsent = true. See §7b for how this flag
  steers prompt selection.

internalNote:
  When the escalation trigger came from General guidance (not the Reply), the
  extractor copies the GG text into an internalNote field so the reviewer
  sees WHY it was flagged. Surfaces in the Needs Review output and xlsx.

7b. Order-Related vs Pre-Sales Detection (RTO / Escalation only)

For RTO and Escalation items, determine whether the FAQ is tied to an existing
order or is a pre-sales question. This determines which response prompt is used.

Match keywords (case-insensitive) in BOTH the Title AND the source answer text:

  Order-related keywords:
    "my order", "order number", "order #", "tracking number", "tracking",
    "delivered", "shipment status", "where is my", "cancel order",
    "modify order", "change order", "return", "refund", "exchange",
    "warranty", "replace item", "replacement"

  If ANY order-related keyword appears in title OR answer → Order-Related
  Otherwise → Pre-Sales

Response prompt selection (with §7a forceConsent precedence):

  1. If forceConsent = true (set in §7a — any "Gather …details" or "RTO"
     keyword fired, in the answer or General guidance) → CONSENT_PROMPT,
     regardless of order-related detection. GDPR-safe default for any flow
     that requires collecting fresh PII.

  2. Otherwise, apply the order-related check:
       Order-Related → ESCALATION_PROMPT (asks for email first, then name).
         Rationale: the customer already has an order on file, so their
         info is in the system and no new consent is required under GDPR.
       Pre-Sales    → CONSENT_PROMPT (verbatim consent phrase, see §10a).

7c. Category Classification (ALL FAQs)

Every FAQ — processed, RTO, Escalation, AND Other-type Needs Review items —
must be classified into exactly ONE of these fixed categories so the final
output can be grouped consistently:

  1.  Company Details
  2.  Ordering and Checkout
  3.  Order Status
  4.  Stock and Supply Inquiry
  5.  Returns, Refunds, Exchanges, and Warranties
  6.  Shipping Information
  7.  Competitor Comparison
  8.  Discounts and Promotions
  9.  Rewards and Affiliate Program
  10. Product Information
  11. Product Recommendation
  12. Account and Subscription
  13. Wholesale
  14. Order Cancellation / Modification / Tracking
  15. Do you sell? Do you have?
  16. Services
  17. Installation / Guide
  18. Technical Queries
  19. Miscellaneous
  20. OTHERS (fallback if none fit)

Classification rules (applied in this order):

  1. Tags fast-path (no LLM call — saves tokens):
     Check the Tags column (column M). If it contains a fixed-category name
     (substring match, case-insensitive) pick that category directly. When
     multiple match, the longest category name wins (most specific).

     If no full category name is contained, split Tags on comma/semicolon/pipe
     and check each segment (length ≥ 5) — if exactly one category contains
     the segment, pick that category. Example: Tags = "shipping" uniquely
     matches "Shipping Information".

  2. LLM batch classify (for items that did NOT fast-path):
     Call OpenAI in batches of up to 20 items. Each item sends:
        Title (always — primary signal)
        Tags (column M) when present
        Keywords (column I) when present
        First 150 chars of the source answer ONLY when Title is < 5 words

  3. Fallback: if the LLM returns a label not in the fixed list → "OTHERS".
  4. Categories with zero FAQs after classification are omitted from output.

7d. Internal-Review Flow (agent-procedure gate)

Every item with type = "internal-review" is sent to OpenAI with the
INTERNAL_REVIEW_PROMPT, which does BOTH detection and rewrite in a single call:

  STEP 1 — Agent-Procedure Detection
    The model looks for signs that the content is a step-by-step procedure
    for SUPPORT AGENTS to operate internal tools, including:
      - References to admin interfaces / internal platforms (Shopify admin,
        Zendesk, Gorgias, Intercom, Freshdesk, Google Drive admin, Gmail admin,
        backend dashboards, agent consoles, CRM, etc.)
      - Instructions to log in, navigate, click, select, or copy from a tool
      - Numbered/sequential agent workflow steps
      - Agent-directed language ("the agent should", "for support staff")

    If ANY of these signals are present, the model MUST reply with exactly:
      AGENT_PROCEDURE_NO_REWRITE
    and nothing else.

  STEP 2 — Rewrite (only if NOT an agent procedure)
    If the content is internal policy/context that can be sanitized, the
    model rewrites it into the standard 2-paragraph customer-facing response,
    stripping internal tool names, agent-directed language, and internal-only
    phrasing. Same output rules as the main SYSTEM_PROMPT.

  Handling in the output:
    - Refused (agent procedure): suggested response is OMITTED; review item
      shows the line "Agent procedure — manual review required."
    - Rewritten: both the Original Source text AND the Suggested Response
      are shown side by side so the reviewer can compare.

7e. Push-Back Pattern (two main-output FAQs from one spreadsheet row)

Some FAQs encode TWO distinct customer interactions in a single row:
  - A valid customer-facing Reply (the direct answer), AND
  - An INTERNAL agent note in General guidance that says "if the customer
    pushes back / really wants specific info, gather their details and RTO."

Instead of routing these to Needs Review (which loses the perfectly-good
primary answer), the extractor emits TWO main-output FAQ entries per row.

Detection (all must be true):
  - Status is NOT "RTO"
  - A valid Reply was extracted (§7 priority) — the Reply's own text has NO
    escalation keyword (i.e., the primary answer is clean)
  - General guidance contains any escalation signal (gather …details, RTO
    as a word, or any ESCALATION_KEYWORDS from §7a)

When detected, two items are pushed to the main faqs[] bucket:

  1) Primary — type = "normal"
       - Title: the original spreadsheet title (unchanged)
       - Rewritten with SYSTEM_PROMPT (standard 2-paragraph rewrite of Reply)

  2) Push-back — type = "pushback"
       - forceConsent = true (always uses CONSENT_PROMPT substance)
       - Carries primaryTitle, primaryAnswer (Reply text), and answer=GG text
         as LLM context
       - Rewritten with PUSHBACK_PROMPT, which returns BOTH a customer-voiced
         derived title (e.g., "If you need to know stock availability before
         placing your order") AND the 2-paragraph response in a single LLM
         call. Paragraph 2 is the verbatim consent sentence.
       - Generator parses the response: "TITLE: <title>" line + body
       - The push-back's category is inherited from the primary (they're
         always rendered adjacent in the same category section)

Rendering:
  - Main Doc output shows primary immediately followed by push-back, both
    under the same category heading
  - The push-back's Heading 2 is its derived title, NOT the placeholder
  - No Needs Review entry is created for push-back rows

Token impact: +1 LLM call per push-back row (combined title + body).

Escalations where the Reply ITSELF carries the escalation language
(e.g., "please raise a ticket") are NOT push-back — they still route to
Needs Review → Escalation for human vetting (§7a).

7f. Multi-FAQ Row Extraction (one spreadsheet row → many customer FAQs)

Some spreadsheet rows encode a FAQ container that holds multiple distinct
customer questions as Conditions. Example pattern from the source data:

  Title:       Shipping FAQ                    (container label)
  Reply 1:     Standard shipping times…
  Condition 1: HOW LONG DOES THE SHIPPING TAKE?   (customer question)
  Reply 2:     Yes. We can ship internationally.
  Condition 2: CAN YOU SHIP INTERNATIONALLY?
  Guidance 2:  INTERNAL For other international orders… gather details and RTO.
  Reply 3:     Yes, some products have lead time.
  Condition 3: IS THERE A MANUFACTURING LEAD TIME?
  …

Detection:
  A row is MULTI-FAQ mode when ANY Condition X is present AND does NOT
  match the "blank or contains GENERAL" test used by §7 step 1.

  Otherwise the row is SINGLE-FAQ mode and §7 applies unchanged (row Title
  is the FAQ title, answer resolved via the 4-step priority).

Multi-FAQ emission (one item per non-empty slot):
  For every (Reply X, Condition X, Guidance X) slot that has any content:

    - Condition X is a specific customer question AND Reply X is non-empty
      → sub-FAQ with Condition X as the title, Reply X as the answer,
        Guidance X as the internal agent note.

    - Condition X is a specific customer question AND Reply X is EMPTY
      → Needs Review → Other with:
          title  = Condition X
          reason = "No customer-facing answer available"
          internalNote = Guidance X + row-level General guidance
          source = "Reply X"
      (Option 1: transparency — these show in the review file rather than
      being silently dropped.)

    - Condition X blank (or GENERAL) AND Reply X non-empty
      → sub-FAQ with the row Title as the title (a default / anchor answer
        inside a multi-FAQ container).

  In multi-FAQ mode the row-level Title is a container label, NOT a
  customer-facing FAQ title. Sub-FAQs inherit the row's Tags, Keywords,
  Status, and Category signals.

Per-sub-FAQ escalation / push-back detection:
  The "associated guidance" for escalation checks is the concatenation of
  per-slot Guidance X AND the row-level General guidance (either can
  carry the signal). All other routing rules (§7a, §7b, §7d, §7e) apply
  unchanged at the sub-FAQ level.

8. Processing UI

Show a visual progress bar with the following labeled stages (in order):

  1. Parsing Excel
  2. Extracting Approved Answers
  3. Generating Stress Test Scenarios
  4. Validating Policy Compliance
  5. Generating Doc-Style Output
  6. Uploading to Google Drive
  7. Sending Slack Notification

Progress bar must update visually at each stage.

❗ Must NOT expose to the user:
  scenario lists
  validation logs
  risk scores

These remain backend-only.

9. Output Format (STRICT)

Each FAQ must follow this exact structure:

  Question (plain text, no label)
  [blank line]
  Paragraph 1 of answer
  [blank line]
  Paragraph 2 of answer
  [blank line between FAQs]

Rules:
  No "Q:" / "A:"
  No numbering
  No markdown
  No labels
  No metadata
  Exactly two paragraphs per answer
  One blank line between FAQ entries

9a. Category Grouping (main Doc output)

The main Doc output MUST be grouped by category:

  - Each category appears as a Heading 1 (category name, no numbering),
    **center-aligned** so the reviewer can scan them easily
  - Within each category, FAQs appear in source-file order
  - Categories appear in the fixed order listed in Section 7c
  - Categories with zero FAQs are skipped (not rendered)

This applies to both FAQ_DocStyle_Output.docx and FAQ_DocStyle_Output.txt.
In TXT, category headings are visually centered using a top/bottom bar
(`━━━━━━━━━━━━━`) with padded spaces to approximate center alignment.

10. Tone Enforcement

Each answer must include ALL of the following components:

  1. Acknowledgment
  2. Empathy (when contextually applicable)
  3. Reassurance
  4. Policy-Safe Answer

Important clarification:
  If empathy is NOT contextually applicable (e.g. neutral informational FAQ),
  Acknowledgment + Reassurance are still REQUIRED.
  Empathy may be omitted only when context clearly does not warrant it.

Validation Rules:
  Do NOT add new promises
  Do NOT expand policy beyond the approved answer
  Do NOT invent timelines
  Do NOT remove required qualifiers

10a. Escalation Response Prompts (RTO / Escalation only)

Two prompts are used, selected by the Order-Related vs Pre-Sales check in §7b.

ESCALATION_PROMPT (Order-Related — customer has an existing order on file):
  Paragraph 1: Warm acknowledgment + empathy + reassurance that the team will
               look into this personally.
  Paragraph 2: Ask the customer to provide their email address (first) and
               their complete name so the team can follow up directly.
  Do NOT promise a specific timeline or resolution.

CONSENT_PROMPT (Pre-Sales — no existing order, personal info consent required):
  Paragraph 1: Warm acknowledgment + reassurance that the team will personally
               help with their inquiry.
  Paragraph 2: MUST contain this exact verbatim sentence (no paraphrasing):

    "In order to process your request, we will need to ask for your personal
    information such as your email address, and/or phone number. We will only
    use this information to handle your request and for no other purposes
    unless you give us your specific consent separately. Please type
    \"I Agree\" in the chat so we can proceed."

  No timelines, no commitments, no additional policy content.

11. Outputs

Filename convention (ALL generated files)

  Each file is prefixed with a sanitized Client Code so downloads from
  different runs don't collide:

    <CLIENT>_FAQ_Formatted.docx
    <CLIENT>_FAQ_Formatted.txt
    <CLIENT>_FAQ_Needs_Review.xlsx
    <CLIENT>_FAQ_Validation_Report.csv

  Sanitization rules for <CLIENT>:
    - Strip all characters except word chars, spaces, and hyphens
    - Trim, replace spaces with underscores, collapse repeats
    - Uppercase everything
    - Empty or missing Client Code → literal "CLIENT"

  Examples:
    Client Code "ABC"         → ABC_FAQ_Formatted.docx
    Client Code "rovi"        → ROVI_FAQ_Needs_Review.xlsx
    Client Code "My Client #1" → MY_CLIENT_1_FAQ_Formatted.docx
    Client Code "" (missing)   → CLIENT_FAQ_Formatted.docx

Primary Output
  <CLIENT>_FAQ_Formatted.docx
  <CLIENT>_FAQ_Formatted.txt

Both files MUST be structured as:

  Section A — PROCESSED FAQs
    Grouped by category (fixed order, §7c). Each category shown as centered
    Heading 1. Within a category, each FAQ: title + 2-paragraph response.

  Section B — NEEDS REVIEW
    Separator line, then FOUR sub-sections in this order:

      1. NEEDS REVIEW — RTO
         Grouped by category (centered H2). Each FAQ:
           Title | Reason · Status · Tags · Keywords
           Original Source (<column>): <actual text>
           Suggested Response: <2-paragraph generated response>

      2. NEEDS REVIEW — ESCALATION
         Same structure as RTO.

      3. NEEDS REVIEW — INTERNAL (SHAREABLE?)
         Same structure as RTO, PLUS:
           - If §7d agent-procedure gate refused, the Suggested Response slot
             is replaced with: "Agent procedure — manual review required."
           - Otherwise, show both Original Source AND Suggested Response so
             the reviewer can compare.

      4. NEEDS REVIEW — OTHER
         (Status-based exclusions + no-valid-answer cases)
         Each FAQ:
           Title | Reason · Status · Tags · Keywords
           Original Source (<column>): <Reply 1 fallback if present>
         No generated response — these rows are flagged but not rewritten.

Secondary Output
  <CLIENT>_FAQ_Needs_Review.xlsx
  Columns (in this order):
    FAQ Title
    Type                   (RTO | Escalation | Internal Review | Other)
    Category               (one of the fixed 20)
    Reason Flagged
    Status                 (from the Status column)
    Tags                   (from column M)
    Keywords               (from column I)
    Source Column          (e.g. "Reply 1", "General guidance")
    Original Source Text   (the actual text content)
    Agent Note             (General guidance text when it triggered the
                            escalation — otherwise blank)
    Generated Response     (blank for Other; "(Agent procedure …)" for
                            refused internal-review items)

  Row order: RTO → Escalation → Internal Review → Other.
  Within each type, rows are grouped by category in the fixed order.

Optional (Dev Only)
  <CLIENT>_FAQ_Validation_Report.csv
  Adds columns: Category, Type. Preview note reads "Agent procedure — no
  rewrite" for refused internal-review items.

12. Google Drive

Auto-upload all generated files.
User must provide a Client Code before processing begins.
Folder naming format:
  ClientCode_FAQ_Run_YYYY-MM-DD

If upload fails:
  Show error
  DO NOT send Slack notification

13. Slack Notification

Send ONLY after Drive upload is confirmed successful.

Message must include:
  File name processed
  Total FAQs detected
  Total successfully processed
  Total Needs Review (flagged)
  Google Drive folder link
  Direct link to Doc output file

14. Results Screen

Display after successful processing:

  "Processing Complete" status
  Download button — Doc file (.docx)
  Download button — Needs Review file (.xlsx)
  Open Drive Folder button
  Summary stats:
    Total FAQs
    Processed
    Flagged / Needs Review

15. Failure Handling

Invalid Excel Format:
  Show descriptive error
  Do not start processing

Drive Upload Fails:
  Show error message
  DO NOT send Slack notification

Slack Fails:
  Still show success/results page
  Display a Slack error notice alongside results

16. Configuration (Required Setup)

The following must be configured before the app can run:
  ANTHROPIC_API_KEY — Claude API key
  SLACK_WEBHOOK_URL — Slack incoming webhook URL
  GOOGLE_DRIVE_FOLDER_ID — Target parent folder in Google Drive
  GOOGLE_SERVICE_ACCOUNT_JSON — Path to Google service account credentials file

These should be stored in a .env file and never committed to source control.

17. Tech Stack (Recommended)

  Backend: Python (Flask or FastAPI)
  Frontend: HTML/CSS/JS (single-page, no framework required)
  Excel Parsing: openpyxl or pandas
  Claude Integration: Anthropic Python SDK
  Google Drive: Google API Python Client (service account auth)
  Slack: Incoming Webhook (HTTP POST)
  DOCX Generation: python-docx

18. Definition of Done

System is complete when:

✅ Upload works with .xlsx validation
✅ Client Code input collected before processing
✅ Columns auto-detected correctly
✅ Extraction logic works in correct priority order
✅ Status-based exclusion (Archived / Submitted / Suggested) routes to Needs Review (type=other)
✅ Internal content → type=internal-review; INTERNAL_REVIEW_PROMPT runs agent-procedure gate
✅ Agent-procedure refusal shown as "Agent procedure — manual review required." (no rewrite)
✅ Non-procedure internal content is sanitized into a Suggested Response for reviewer comparison
✅ RTO (Status column) routes to Needs Review, still generates a 2-paragraph response
✅ Escalation (keyword match in answer) routes to Needs Review, still generates a response
✅ Escalation detection scans BOTH Reply text AND General guidance column
✅ "Gather …details" phrase and standalone "RTO" word set forceConsent = true
✅ forceConsent overrides order-related detection → always uses CONSENT_PROMPT
✅ Order-related escalations (no force) use ESCALATION_PROMPT (email + name)
✅ Consent phrase appears verbatim (no paraphrasing) in Pre-Sales / forced cases
✅ When GG triggered the escalation, the GG text surfaces as "Agent Note" in review output
✅ Every FAQ is classified into one of the 20 fixed categories
✅ Classification is batched (up to 20 per OpenAI call) to save tokens
✅ Tags fast-path assigns category without an LLM call when Tags is clean
✅ Rewrites run in parallel (concurrency ≤ 5) to reduce wall-clock time
✅ Main Doc output is grouped by category (centered H1, fixed order, empty categories skipped)
✅ Needs Review is sectioned: RTO → Escalation → Internal Review → Other, each grouped by category
✅ Every Needs Review item shows: Title, Reason, Status, Tags, Keywords, Original Source text,
   and (when applicable) Suggested Response
✅ Archived/Submitted/Suggested/No-answer items show original text but get NO Suggested Response
✅ Push-back pattern emits TWO main-output FAQs (primary + customer-voiced follow-up) when Reply is clean and GG carries an escalation signal
✅ Push-back follow-up uses the consent phrase verbatim in paragraph 2; derived title is customer-voiced
✅ Push-back inherits the primary's category so both render adjacent in the same section
✅ Multi-FAQ rows emit one FAQ per non-empty Condition slot (title = Condition, answer = Reply)
✅ Multi-FAQ rows with an empty Reply but specific Condition route to Needs Review → Other with the Condition as title
✅ Per-sub-FAQ escalation detection uses Guidance X + row-level General guidance concatenation
✅ Output format strictly followed (2 paragraphs, no labels, no metadata)
✅ Tone rules enforced (acknowledgment + reassurance always present)
✅ All files generated correctly
✅ Drive upload works with correct folder naming
✅ Slack notification sent only after confirmed Drive upload
✅ Errors handled properly per failure type
✅ No internal data exposed in processing UI

19. Edge Cases

Missing Title column
Empty replies across all Reply columns
Multiple GENERAL condition matches (use first one)
Internal-only General guidance with no usable Reply
Mixed valid/invalid rows in same file
Large Excel files (100+ rows)
Client Code missing or blank (must block processing)
Slack/Drive partial failures
Reply X text exists but Condition X is not GENERAL and not blank
RTO status with an otherwise-valid answer (route to Needs Review, still generate response)
Escalation keyword appears in a pre-sales context (use consent phrase)
Escalation keyword appears in an order-tracking context (use email+name ask)
Classification batch returns a label not in the fixed list (default to OTHERS)
Category returned for an item has zero total members (still rendered if any item lands there)
Both RTO and Escalation triggers match on the same FAQ (RTO takes precedence)
Internal content that is an agent procedure (Shopify admin, Zendesk, etc. steps) → AGENT_PROCEDURE_NO_REWRITE, no Suggested Response
Internal content that is just policy wording → sanitized rewrite, Original Source + Suggested Response both shown
No-valid-answer row that has a non-GENERAL Reply 1 → show Reply 1 as Original Source in the review file
Status = RTO on a row where Condition blocks extraction → still "No valid answer found", type=other
Push-back row where LLM response omits the "TITLE:" line → fallback template: "If you need more specific information about <primary title>"
Push-back row where primary and push-back would naturally classify to different categories → push-back inherits primary's category (keeps them adjacent)
Multi-FAQ row (e.g., "Shipping FAQ" with 6 specific conditions) → 6 separate sub-FAQs with the Condition text as each title; row Title is a container and NOT rendered
Multi-FAQ row with mixed blank + specific conditions → blank-condition slots render under row Title, specific-condition slots render under Condition text
Multi-FAQ row where Condition is specific but Reply X is empty → Needs Review → Other entry with Condition as title, Guidance X as internalNote (Option 1 transparency)
Per-sub-FAQ Guidance X that contains "gather …details" or "rto" → push-back pattern applies for that specific sub-FAQ, even if siblings in the same row don't

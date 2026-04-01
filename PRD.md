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

Internal Content Detection

Check the General guidance column ONLY.
If General guidance begins with any of the following (case-insensitive):
  "INTERNAL"
  "NOT FOR CUSTOMER"
  or similar internal-only prefixes

→ MUST:
  exclude from Doc output
  add to Needs Review file with reason = "Internal content"

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

11. Outputs

Primary Output
  FAQ_DocStyle_Output.docx
  FAQ_DocStyle_Output.txt

Secondary Output
  FAQ_Needs_Review.xlsx
  Columns:
    FAQ Title
    Reason Flagged
    Original Extracted Answer Source

Optional (Dev Only)
  FAQ_Validation_Report.csv

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
✅ Internal content (General guidance column) detected and excluded
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

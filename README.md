# FAQ Stress Tester + Policy Regression Checker

## Overview
This tool processes FAQ Excel files and converts them into clean, policy-safe, customer-facing outputs.

It validates answers, removes internal content, enforces tone rules, and generates ready-to-use documentation.

---

## What It Does
- Upload FAQ `.xlsx` files
- Extract valid answers based on rules
- Remove internal / unsafe content
- Enforce tone (acknowledgment, empathy, reassurance)
- Generate clean Doc-style FAQ output
- Create "Needs Review" file for flagged items
- Upload results to Google Drive
- Send Slack notification

---

## How It Works
1. Upload Excel file
2. System parses FAQ rows
3. Applies extraction logic
4. Validates policy compliance
5. Formats output
6. Generates files
7. Uploads to Drive + sends Slack notification

---

## Input Requirements
Excel file must include:
- Title
- General guidance
- Reply columns (Reply 1–17)
- Condition columns (Condition 1–17)

---

## Outputs
- `FAQ_DocStyle_Output.docx`
- `FAQ_DocStyle_Output.txt`
- `FAQ_Needs_Review.xlsx`

---

## Tech Stack
- Frontend: HTML/CSS/JavaScript (single-page)
- Backend: Python (Flask or FastAPI)
- AI: Claude (Anthropic Python SDK)
- Excel Parsing: openpyxl / pandas
- DOCX Generation: python-docx
- Storage: Google Drive (service account)
- Notifications: Slack (incoming webhook)

---

## How to Run (Basic)
1. Install dependencies
2. Set environment variables
3. Run the app
4. Upload your FAQ file

---

## Notes
- This tool enforces strict policy-safe outputs
- Internal content is automatically excluded
- Some FAQs may be flagged for review

---

## Related Files
- [PRD.md](PRD.md) → Full product requirements
- [CLAUDE.md](CLAUDE.md) → AI behavior + coding rules
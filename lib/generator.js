import Anthropic from '@anthropic-ai/sdk';
import * as XLSX from 'xlsx';
import { Document, Paragraph, Packer } from 'docx';
import path from 'path';
import fs from 'fs';

const OUTPUTS_DIR = path.join(process.cwd(), 'outputs');

// System prompt for standard FAQs (PRD Sections 9 & 10)
const SYSTEM_PROMPT = `You are a customer support writer. Your job is to rewrite FAQ answers into clean, policy-safe, customer-facing responses.

STRICT RULES — follow exactly:
- Output exactly 2 paragraphs separated by a blank line
- Paragraph 1: Acknowledgment + Empathy (if contextually applicable) + Reassurance
- Paragraph 2: The policy-safe answer using only the provided source text
- No "Q:" or "A:" labels
- No numbering, markdown, bullet points, or headers
- No metadata or labels of any kind
- Do NOT add new promises
- Do NOT expand the policy beyond what is provided
- Do NOT invent timelines or commitments
- Do NOT remove qualifiers from the original answer
- If empathy is not applicable (neutral informational FAQ), still include acknowledgment and reassurance`;

// System prompt for escalation FAQs — collects email + name from the customer
const ESCALATION_PROMPT = `You are a customer support writer. This FAQ requires escalation — the support team needs to follow up with the customer directly.

STRICT RULES — follow exactly:
- Output exactly 2 paragraphs separated by a blank line
- Paragraph 1: Acknowledge the customer's concern warmly and empathetically. Reassure them that the team will look into this personally.
- Paragraph 2: Ask the customer to provide their email address (first) and their complete name so the team can follow up with them directly. Do NOT promise a specific timeline or resolution.
- No "Q:" or "A:" labels
- No numbering, markdown, bullet points, or headers
- No metadata or labels of any kind
- Do NOT invent timelines or commitments`;

/**
 * For each extracted FAQ, call Claude to generate a 2-paragraph policy-safe answer.
 * Then write all output files. Returns a dict of output file paths.
 */
export async function generateOutputs(sessionId, faqs, needsReview) {
  const sessionDir = path.join(OUTPUTS_DIR, sessionId);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Generate formatted answers via Claude (sequential — preserve order)
  const formattedFaqs = [];
  for (const faq of faqs) {
    const formattedAnswer = await callClaude(client, faq.title, faq.answer, faq.type);
    formattedFaqs.push({ title: faq.title, answer: formattedAnswer, source: faq.source, type: faq.type });
  }

  const outputFiles = {};
  outputFiles.docx = await writeDocx(sessionDir, formattedFaqs);
  outputFiles.txt = writeTxt(sessionDir, formattedFaqs);
  outputFiles.reviewXlsx = writeReviewXlsx(sessionDir, needsReview);
  outputFiles.validationCsv = writeValidationCsv(sessionDir, formattedFaqs, needsReview);

  return outputFiles;
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

async function callClaude(client, question, sourceAnswer, type = 'normal') {
  const isEscalation = type === 'escalation';
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: isEscalation ? ESCALATION_PROMPT : SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: isEscalation
        ? `Question: ${question}\n\nContext: ${sourceAnswer}\n\nWrite the 2-paragraph escalation response now, asking for email address first, then complete name.`
        : `Question: ${question}\n\nSource answer (use only this content — do not expand or invent):\n${sourceAnswer}\n\nWrite the 2-paragraph customer-facing response now.`,
    }],
  });
  return message.content[0].text.trim();
}

// ---------------------------------------------------------------------------
// Output file writers
// ---------------------------------------------------------------------------

async function writeDocx(sessionDir, formattedFaqs) {
  const children = [];
  for (let i = 0; i < formattedFaqs.length; i++) {
    const { title, answer } = formattedFaqs[i];
    children.push(new Paragraph({ text: title }));
    const paragraphs = answer.split('\n\n').map(p => p.trim()).filter(Boolean);
    for (const para of paragraphs) {
      children.push(new Paragraph({ text: para }));
    }
    if (i < formattedFaqs.length - 1) {
      children.push(new Paragraph({ text: '' }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  const filePath = path.join(sessionDir, 'FAQ_DocStyle_Output.docx');
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function writeTxt(sessionDir, formattedFaqs) {
  const lines = [];
  for (let i = 0; i < formattedFaqs.length; i++) {
    const { title, answer } = formattedFaqs[i];
    lines.push(title, '', answer);
    if (i < formattedFaqs.length - 1) lines.push('');
  }
  const filePath = path.join(sessionDir, 'FAQ_DocStyle_Output.txt');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

function writeReviewXlsx(sessionDir, needsReview) {
  const rows = needsReview.map(item => ({
    'FAQ Title': item.title,
    'Reason Flagged': item.reason,
    'Original Extracted Answer Source': item.source,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Needs Review');
  const filePath = path.join(sessionDir, 'FAQ_Needs_Review.xlsx');
  // Use XLSX.write + fs to avoid SheetJS path issues on Windows
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function writeValidationCsv(sessionDir, formattedFaqs, needsReview) {
  const rows = [
    ...formattedFaqs.map(faq => ({
      'FAQ Title': faq.title,
      'Status': 'Processed',
      'Source': faq.source,
      'Answer Preview': faq.answer.length > 120 ? faq.answer.slice(0, 120) + '...' : faq.answer,
    })),
    ...needsReview.map(item => ({
      'FAQ Title': item.title,
      'Status': 'Needs Review',
      'Source': item.source,
      'Answer Preview': `Flagged: ${item.reason}`,
    })),
  ];
  const ws = XLSX.utils.json_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(ws);
  const filePath = path.join(sessionDir, 'FAQ_Validation_Report.csv');
  fs.writeFileSync(filePath, csv, 'utf8');
  return filePath;
}

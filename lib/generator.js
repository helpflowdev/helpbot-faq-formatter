import OpenAI from 'openai';
import * as XLSX from 'xlsx';
import { Document, Paragraph, Packer, HeadingLevel, BorderStyle, TextRun, AlignmentType } from 'docx';
import path from 'path';
import fs from 'fs';

const OUTPUTS_DIR = path.join(process.cwd(), 'outputs');

// PRD §7c — fixed category list. Order here IS the rendering order.
const CATEGORIES = [
  'Company Details',
  'Ordering and Checkout',
  'Order Status',
  'Stock and Supply Inquiry',
  'Returns, Refunds, Exchanges, and Warranties',
  'Shipping Information',
  'Competitor Comparison',
  'Discounts and Promotions',
  'Rewards and Affiliate Program',
  'Product Information',
  'Product Recommendation',
  'Account and Subscription',
  'Wholesale',
  'Order Cancellation / Modification / Tracking',
  'Do you sell? Do you have?',
  'Services',
  'Installation / Guide',
  'Technical Queries',
  'Miscellaneous',
  'OTHERS',
];
const CATEGORY_SET = new Set(CATEGORIES);

// PRD §7b — if any keyword appears in title OR source answer, treat as order-related
const ORDER_KEYWORDS = [
  'my order', 'order number', 'order #', 'tracking number', 'tracking',
  'delivered', 'shipment status', 'where is my', 'cancel order',
  'modify order', 'change order', 'return', 'refund', 'exchange',
  'warranty', 'replace item', 'replacement',
];

// Parallelism cap for OpenAI rewrite calls (PRD §18)
const REWRITE_CONCURRENCY = 5;
// Items per classification call (PRD §7c — batch up to 20)
const CLASSIFY_BATCH_SIZE = 20;

// ---------------------------------------------------------------------------
// Prompts (PRD §9, §10, §10a)
// ---------------------------------------------------------------------------

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

const ESCALATION_PROMPT = `You are a customer support writer. This FAQ requires escalation and is tied to an existing customer order — the support team needs to follow up with the customer directly.

STRICT RULES — follow exactly:
- Output exactly 2 paragraphs separated by a blank line
- Paragraph 1: Acknowledge the customer's concern warmly and empathetically. Reassure them that the team will look into this personally.
- Paragraph 2: Ask the customer to provide their email address (first) and their complete name so the team can follow up with them directly. Do NOT promise a specific timeline or resolution.
- No "Q:" or "A:" labels
- No numbering, markdown, bullet points, or headers
- No metadata or labels of any kind
- Do NOT invent timelines or commitments`;

// The consent sentence must appear verbatim in paragraph 2 — no paraphrasing.
const CONSENT_SENTENCE = 'In order to process your request, we will need to ask for your personal information such as your email address, and/or phone number. We will only use this information to handle your request and for no other purposes unless you give us your specific consent separately. Please type "I Agree" in the chat so we can proceed.';

const CONSENT_PROMPT = `You are a customer support writer. This FAQ is a pre-sales question (no existing order yet) that requires escalation, so personal-information consent must be requested before collecting any details.

STRICT RULES — follow exactly:
- Output exactly 2 paragraphs separated by a blank line
- Paragraph 1: Warmly acknowledge the customer's inquiry and reassure them that the team will personally help. Do NOT ask for any personal details in this paragraph.
- Paragraph 2: MUST contain this exact sentence, word for word, as the entire paragraph (do not paraphrase, shorten, or add to it):

${CONSENT_SENTENCE}

- No "Q:" or "A:" labels
- No numbering, markdown, bullet points, or headers
- No metadata or labels of any kind
- Do NOT invent timelines or commitments
- Do NOT add any other content in paragraph 2 besides the sentence above`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Generate responses + write all output files.
 *
 *   faqs:        [{ title, answer, source, type: 'normal' }]
 *   needsReview: [{ title, reason, source, type: 'rto'|'escalation'|'other', answer? }]
 *
 * Returns { outputFiles, formattedFaqs, formattedNeedsReview }.
 */
export async function generateOutputs(sessionId, faqs, needsReview) {
  const sessionDir = path.join(OUTPUTS_DIR, sessionId);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 1. Classify every FAQ (main + needs-review) into one of the 20 categories.
  //    Tags fast-path first (free, no LLM call), then batch-classify the rest
  //    with title + Tags + Keywords as signals (PRD §7c).
  const allItems = [
    ...faqs.map((f, i) => ({
      bucket: 'faqs', index: i,
      title: f.title, answer: f.answer,
      keywords: f.keywords ?? '', tags: f.tags ?? '',
    })),
    ...needsReview.map((r, i) => ({
      bucket: 'needsReview', index: i,
      title: r.title, answer: r.answer ?? '',
      keywords: r.keywords ?? '', tags: r.tags ?? '',
    })),
  ];

  const categories = new Array(allItems.length);
  const leftover = [];
  for (let i = 0; i < allItems.length; i++) {
    const fastCat = matchTagsToCategory(allItems[i].tags);
    if (fastCat) {
      categories[i] = fastCat;
    } else {
      leftover.push({ ...allItems[i], _origIndex: i });
    }
  }
  if (leftover.length > 0) {
    const llmCats = await classifyAll(client, leftover);
    for (let j = 0; j < leftover.length; j++) {
      categories[leftover[j]._origIndex] = llmCats[j];
    }
  }

  for (let i = 0; i < allItems.length; i++) {
    const { bucket, index } = allItems[i];
    if (bucket === 'faqs') faqs[index].category = categories[i];
    else needsReview[index].category = categories[i];
  }

  // 2. Rewrite all FAQs with generated responses (main + rto/escalation) in parallel.
  const rewriteTargets = [
    ...faqs.map((f, i) => ({ bucket: 'faqs', index: i, item: f })),
    ...needsReview
      .map((r, i) => ({ bucket: 'needsReview', index: i, item: r }))
      .filter(t => t.item.type === 'rto' || t.item.type === 'escalation'),
  ];
  await runWithConcurrency(rewriteTargets, REWRITE_CONCURRENCY, async (t) => {
    const { item } = t;
    const answer = await callRewrite(client, item);
    item.formattedAnswer = answer;
  });

  // 3. Write the output files.
  const outputFiles = {};
  outputFiles.docx = await writeDocx(sessionDir, faqs, needsReview);
  outputFiles.txt = writeTxt(sessionDir, faqs, needsReview);
  outputFiles.reviewXlsx = writeReviewXlsx(sessionDir, needsReview);
  outputFiles.validationCsv = writeValidationCsv(sessionDir, faqs, needsReview);

  return { outputFiles, formattedFaqs: faqs, formattedNeedsReview: needsReview };
}

// ---------------------------------------------------------------------------
// Order-related vs pre-sales detection (PRD §7b)
// ---------------------------------------------------------------------------

function isOrderRelated(title, answer) {
  const haystack = `${title} ${answer ?? ''}`.toLowerCase();
  return ORDER_KEYWORDS.some(kw => haystack.includes(kw));
}

// ---------------------------------------------------------------------------
// Tags-based fast-path classifier (PRD §7c)
//
// If the Tags column contains a fixed category name (or a tag segment is a
// substring of exactly one category name), return that category directly and
// skip the LLM call. Saves tokens and improves accuracy for well-tagged rows.
// ---------------------------------------------------------------------------

function matchTagsToCategory(tags) {
  if (!tags) return null;
  const norm = String(tags).toLowerCase().trim();
  if (!norm) return null;

  // Direction 1 — a full category name appears in the tags string.
  //   e.g. Tags = "discounts and promotions" → "Discounts and Promotions"
  // Pick the longest match so "Returns, Refunds, Exchanges, and Warranties"
  // wins over "Returns" when both would match.
  let best = null;
  let bestLen = 0;
  for (const cat of CATEGORIES) {
    if (cat === 'OTHERS') continue;
    const ncat = cat.toLowerCase();
    if (norm.includes(ncat) && ncat.length > bestLen) {
      best = cat;
      bestLen = ncat.length;
    }
  }
  if (best) return best;

  // Direction 2 — a tag segment (comma/semicolon/pipe separated) is a
  // substring of exactly one category name. Requires segment length >= 5 to
  // avoid weak matches like "the" or "you".
  //   e.g. Tags = "shipping" → "Shipping Information"
  const parts = norm.split(/[,;|]/).map(s => s.trim()).filter(s => s.length >= 5);
  for (const part of parts) {
    const matches = CATEGORIES.filter(c => c !== 'OTHERS' && c.toLowerCase().includes(part));
    if (matches.length === 1) return matches[0];
  }

  return null;
}

// ---------------------------------------------------------------------------
// OpenAI — rewrite step
// ---------------------------------------------------------------------------

async function callRewrite(client, item) {
  let systemPrompt;
  let userPrompt;

  if (item.type === 'rto' || item.type === 'escalation') {
    const orderRelated = isOrderRelated(item.title, item.answer);
    if (orderRelated) {
      systemPrompt = ESCALATION_PROMPT;
      userPrompt = `Question: ${item.title}\n\nContext: ${item.answer}\n\nWrite the 2-paragraph escalation response now, asking for email address first, then complete name.`;
    } else {
      systemPrompt = CONSENT_PROMPT;
      userPrompt = `Question: ${item.title}\n\nContext: ${item.answer}\n\nWrite the 2-paragraph response now. Paragraph 2 must contain the consent sentence verbatim.`;
    }
  } else {
    systemPrompt = SYSTEM_PROMPT;
    userPrompt = `Question: ${item.title}\n\nSource answer (use only this content — do not expand or invent):\n${item.answer}\n\nWrite the 2-paragraph customer-facing response now.`;
  }

  const response = await client.chat.completions.create({
    model: 'gpt-5.4-nano',
    max_completion_tokens: 500,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
  return response.choices[0].message.content.trim();
}

// ---------------------------------------------------------------------------
// OpenAI — batched classifier (PRD §7c)
// ---------------------------------------------------------------------------

async function classifyAll(client, items) {
  const categories = new Array(items.length);
  for (let start = 0; start < items.length; start += CLASSIFY_BATCH_SIZE) {
    const chunk = items.slice(start, start + CLASSIFY_BATCH_SIZE);
    const result = await classifyBatch(client, chunk);
    for (let i = 0; i < chunk.length; i++) {
      categories[start + i] = CATEGORY_SET.has(result[i]) ? result[i] : 'OTHERS';
    }
  }
  return categories;
}

async function classifyBatch(client, chunk) {
  // Primary signal is the title. Tags and Keywords (from the spreadsheet) are
  // added when present — they come straight from the author and are strong
  // category hints. A short answer snippet is included only when the title is
  // ambiguous (< 5 words) to keep tokens low.
  const listText = chunk.map((it, i) => {
    const parts = [`Title: ${it.title}`];
    if (it.tags) parts.push(`Tags: ${it.tags}`);
    if (it.keywords) parts.push(`Keywords: ${it.keywords}`);

    const words = it.title.trim().split(/\s+/).filter(Boolean);
    const needsSnippet = words.length < 5 && it.answer;
    if (needsSnippet) {
      const snippet = String(it.answer).slice(0, 150).replace(/\s+/g, ' ').trim();
      parts.push(`Context: ${snippet}`);
    }
    return `${i + 1}. ${parts.join(' | ')}`;
  }).join('\n');

  const system = `You categorize customer-facing FAQ entries. You MUST pick exactly one category per entry from this fixed list:

${CATEGORIES.join(', ')}

Each entry may include Tags and Keywords fields — treat those as strong hints from the author. If nothing fits, return "OTHERS". Return ONLY a JSON array of strings with the same length as the input list, in order. No prose, no markdown.`;

  const user = `Categorize these ${chunk.length} entries. Return a JSON array like ["Company Details", "Shipping Information", ...].

${listText}`;

  const response = await client.chat.completions.create({
    model: 'gpt-5.4-nano',
    max_completion_tokens: 500,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const raw = response.choices[0].message.content.trim();
  const parsed = safeParseJsonArray(raw);
  if (Array.isArray(parsed) && parsed.length === chunk.length) {
    return parsed.map(s => String(s ?? '').trim());
  }
  // Fallback: pad with OTHERS so downstream stays consistent
  return new Array(chunk.length).fill('OTHERS');
}

function safeParseJsonArray(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Strip common wrappers (```json ... ```)
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Concurrency runner
// ---------------------------------------------------------------------------

async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function loop() {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  }
  const runners = Array(Math.min(limit, items.length)).fill(0).map(() => loop());
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

function groupByCategory(items) {
  const map = new Map();
  for (const item of items) {
    const cat = item.category || 'OTHERS';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(item);
  }
  // Emit categories in the fixed PRD order, skipping empty ones
  return CATEGORIES
    .filter(cat => map.has(cat))
    .map(cat => ({ category: cat, items: map.get(cat) }));
}

// ---------------------------------------------------------------------------
// Output: DOCX (PRD §11)
// ---------------------------------------------------------------------------

async function writeDocx(sessionDir, faqs, needsReview) {
  const children = [];

  // --- Section A: Processed FAQs grouped by category ---
  const mainGroups = groupByCategory(faqs);
  for (const { category, items } of mainGroups) {
    children.push(new Paragraph({ text: category, heading: HeadingLevel.HEADING_1 }));
    for (const faq of items) {
      children.push(new Paragraph({ text: faq.title, heading: HeadingLevel.HEADING_2 }));
      for (const para of splitParagraphs(faq.formattedAnswer)) {
        children.push(new Paragraph({ text: para }));
      }
      children.push(new Paragraph({ text: '' }));
    }
  }

  // --- Section B: Needs Review (RTO → Escalation → Other) ---
  const rto = needsReview.filter(r => r.type === 'rto');
  const escalation = needsReview.filter(r => r.type === 'escalation');
  const other = needsReview.filter(r => r.type === 'other');

  if (rto.length || escalation.length || other.length) {
    children.push(...reviewSeparator());

    if (rto.length) {
      children.push(reviewSectionHeading(`NEEDS REVIEW — RTO (${rto.length} items)`));
      pushReviewGroupsWithResponses(children, rto);
    }
    if (escalation.length) {
      children.push(reviewSectionHeading(`NEEDS REVIEW — ESCALATION (${escalation.length} items)`));
      pushReviewGroupsWithResponses(children, escalation);
    }
    if (other.length) {
      children.push(reviewSectionHeading(`NEEDS REVIEW — OTHER (${other.length} items)`));
      pushReviewGroupsOther(children, other);
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  const filePath = path.join(sessionDir, 'FAQ_DocStyle_Output.docx');
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function reviewSeparator() {
  return [
    new Paragraph({ text: '' }),
    new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } },
      text: '',
    }),
    new Paragraph({ text: '' }),
  ];
}

function reviewSectionHeading(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
  });
}

function pushReviewGroupsWithResponses(children, items) {
  for (const { category, items: groupItems } of groupByCategory(items)) {
    children.push(new Paragraph({ text: category, heading: HeadingLevel.HEADING_2 }));
    for (const item of groupItems) {
      children.push(new Paragraph({
        children: [new TextRun({ text: item.title, bold: true })],
      }));
      for (const para of splitParagraphs(item.formattedAnswer || '')) {
        children.push(new Paragraph({ text: para }));
      }
      children.push(new Paragraph({
        children: [
          new TextRun({ text: 'Reason: ', bold: true, color: '888888' }),
          new TextRun({ text: item.reason, color: '888888' }),
        ],
      }));
      children.push(new Paragraph({ text: '' }));
    }
  }
}

function pushReviewGroupsOther(children, items) {
  for (const { category, items: groupItems } of groupByCategory(items)) {
    children.push(new Paragraph({ text: category, heading: HeadingLevel.HEADING_2 }));
    for (const item of groupItems) {
      children.push(new Paragraph({
        children: [new TextRun({ text: item.title, bold: true })],
      }));
      children.push(new Paragraph({
        children: [
          new TextRun({ text: 'Reason: ', bold: true }),
          new TextRun({ text: item.reason }),
        ],
      }));
      children.push(new Paragraph({
        children: [
          new TextRun({ text: 'Source: ', bold: true }),
          new TextRun({ text: item.source, color: '888888' }),
        ],
      }));
      children.push(new Paragraph({ text: '' }));
    }
  }
}

function splitParagraphs(text) {
  return String(text || '').split('\n\n').map(p => p.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Output: TXT
// ---------------------------------------------------------------------------

function writeTxt(sessionDir, faqs, needsReview) {
  const lines = [];

  // Processed, grouped by category
  for (const { category, items } of groupByCategory(faqs)) {
    lines.push(`━━━ ${category} ━━━`, '');
    for (const faq of items) {
      lines.push(faq.title, '', faq.formattedAnswer, '');
    }
  }

  const rto = needsReview.filter(r => r.type === 'rto');
  const escalation = needsReview.filter(r => r.type === 'escalation');
  const other = needsReview.filter(r => r.type === 'other');

  if (rto.length || escalation.length || other.length) {
    lines.push('', '════════════════════════════════════════════════════════════');
    lines.push('NEEDS REVIEW');
    lines.push('════════════════════════════════════════════════════════════', '');

    if (rto.length) {
      lines.push(`--- RTO (${rto.length} items) ---`, '');
      writeReviewGroupsTxt(lines, rto, true);
    }
    if (escalation.length) {
      lines.push(`--- ESCALATION (${escalation.length} items) ---`, '');
      writeReviewGroupsTxt(lines, escalation, true);
    }
    if (other.length) {
      lines.push(`--- OTHER (${other.length} items) ---`, '');
      writeReviewGroupsTxt(lines, other, false);
    }
  }

  const filePath = path.join(sessionDir, 'FAQ_DocStyle_Output.txt');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

function writeReviewGroupsTxt(lines, items, withResponse) {
  for (const { category, items: groupItems } of groupByCategory(items)) {
    lines.push(`[${category}]`, '');
    for (const item of groupItems) {
      lines.push(item.title);
      if (withResponse && item.formattedAnswer) {
        lines.push('', item.formattedAnswer);
      }
      lines.push(`  Reason: ${item.reason}`);
      if (!withResponse) lines.push(`  Source: ${item.source}`);
      lines.push('');
    }
  }
}

// ---------------------------------------------------------------------------
// Output: Needs Review XLSX (PRD §11)
// ---------------------------------------------------------------------------

function writeReviewXlsx(sessionDir, needsReview) {
  const typeOrder = { rto: 0, escalation: 1, other: 2 };
  const catIndex = new Map(CATEGORIES.map((c, i) => [c, i]));

  const sorted = [...needsReview].sort((a, b) => {
    const typeDiff = (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
    if (typeDiff !== 0) return typeDiff;
    const catDiff = (catIndex.get(a.category) ?? 99) - (catIndex.get(b.category) ?? 99);
    return catDiff;
  });

  const typeLabel = { rto: 'RTO', escalation: 'Escalation', other: 'Other' };

  const rows = sorted.map(item => ({
    'FAQ Title': item.title,
    'Type': typeLabel[item.type] || 'Other',
    'Category': item.category || 'OTHERS',
    'Reason Flagged': item.reason,
    'Original Extracted Answer Source': item.source,
    'Generated Response': item.formattedAnswer || '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Needs Review');
  const filePath = path.join(sessionDir, 'FAQ_Needs_Review.xlsx');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// ---------------------------------------------------------------------------
// Output: Validation CSV (dev only)
// ---------------------------------------------------------------------------

function writeValidationCsv(sessionDir, faqs, needsReview) {
  const rows = [
    ...faqs.map(faq => ({
      'FAQ Title': faq.title,
      'Status': 'Processed',
      'Type': 'Normal',
      'Category': faq.category || 'OTHERS',
      'Source': faq.source,
      'Answer Preview': preview(faq.formattedAnswer),
    })),
    ...needsReview.map(item => ({
      'FAQ Title': item.title,
      'Status': 'Needs Review',
      'Type': ({ rto: 'RTO', escalation: 'Escalation', other: 'Other' })[item.type] || 'Other',
      'Category': item.category || 'OTHERS',
      'Source': item.source,
      'Answer Preview': item.formattedAnswer
        ? preview(item.formattedAnswer)
        : `Flagged: ${item.reason}`,
    })),
  ];
  const ws = XLSX.utils.json_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(ws);
  const filePath = path.join(sessionDir, 'FAQ_Validation_Report.csv');
  fs.writeFileSync(filePath, csv, 'utf8');
  return filePath;
}

function preview(text) {
  const s = String(text || '');
  return s.length > 120 ? s.slice(0, 120) + '...' : s;
}

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

const REWRITE_CONCURRENCY = 5;
const CLASSIFY_BATCH_SIZE = 20;

// Refusal token the internal-review prompt returns for agent procedures
const AGENT_PROCEDURE_TOKEN = 'AGENT_PROCEDURE_NO_REWRITE';

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

// Push-back prompt (PRD §7e) — produces BOTH a customer-voiced follow-up
// title AND the 2-paragraph consent response in a single LLM call.
const PUSHBACK_PROMPT = `You are writing a follow-up FAQ entry that appears in a customer chat AFTER a primary answer, for customers who "push back" wanting more specific information before they proceed.

Given:
- Original FAQ title (the primary topic)
- Primary answer (what the customer already saw)
- Internal push-back context (an agent note explaining when to escalate)

Produce the follow-up FAQ in this EXACT format (no deviations):

TITLE: <short customer-voiced title describing what the customer now wants>

<Paragraph 1 — warm acknowledgment + reassurance that the team will personally help with the specifics>

${CONSENT_SENTENCE}

STRICT RULES:
- TITLE line: a short phrase in the customer's voice, describing what they want to know (e.g., "If you need to know stock availability before placing your order", "For a specific quote on bulk pricing before ordering"). No "Q:" prefix. No quotes around the title. No markdown.
- Paragraph 1: 1–2 sentences. No PII request in this paragraph. No timelines or promises.
- Paragraph 2: MUST be the consent sentence above, word for word, as the entire paragraph. Do NOT paraphrase, shorten, or add to it.
- Output ONLY: "TITLE:" line, blank line, paragraph 1, blank line, paragraph 2. Nothing else. No headers, no markdown, no labels beyond TITLE:.`;

// Internal-review prompt — detection + rewrite bundled in one call (PRD §7d)
const INTERNAL_REVIEW_PROMPT = `You are reviewing FAQ source content that was flagged as internal — not originally intended for customers. Your job is a two-step decision:

STEP 1 — DETECT AGENT PROCEDURE
Decide whether the content is a step-by-step procedure instructing support AGENTS to operate internal tools. Signs of an agent procedure include any of:
- References to internal platforms or admin interfaces (Shopify admin, Zendesk, Gorgias, Intercom, Freshdesk, Kustomer, Helpscout, Notion, Google Drive admin, Gmail admin, backend, CRM, agent console, admin dashboard, internal portal, etc.)
- Instructions to log in, navigate, click, select, open a tab, copy fields, or change settings inside a tool
- Numbered or sequential agent workflow steps ("Step 1… Step 2…", "First… then…")
- Direct address to agents ("the agent should", "for support staff", "when processing", "handler must")

If ANY of those signs are present, reply with EXACTLY this single token and NOTHING else:

${AGENT_PROCEDURE_TOKEN}

STEP 2 — REWRITE (only if it is NOT an agent procedure)
If the content is internal policy or context that could be sanitized into a safe customer-facing response, rewrite it as exactly 2 paragraphs separated by a blank line:
- Paragraph 1: Acknowledgment + Empathy (if contextually applicable) + Reassurance
- Paragraph 2: The customer-facing answer. Strip ALL internal tool names, agent-directed language, internal identifiers, and internal-only phrasing. Keep only the substance of the policy.
- No "Q:" / "A:" labels, no numbering, no markdown, no headers, no labels of any kind
- Do NOT add new promises, timelines, or content not present in the source
- Do NOT mention any internal tool by name
- If you cannot cleanly sanitize the content, reply with ${AGENT_PROCEDURE_TOKEN} instead

Respond with EITHER the refusal token OR the 2-paragraph rewrite. Nothing else.`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Generate responses + write all output files.
 *
 * Shapes (see extractor.js for full detail):
 *   faqs:        [{ title, answer, source, type: 'normal', keywords, tags, status }]
 *   needsReview: [{ title, reason, source, type, keywords, tags, status, answer?, originalText? }]
 *
 * Returns { outputFiles, formattedFaqs, formattedNeedsReview }.
 */
export async function generateOutputs(sessionId, faqs, needsReview) {
  const sessionDir = path.join(OUTPUTS_DIR, sessionId);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 1. Classify every FAQ into one of the 20 categories.
  //    Tags fast-path first (free), then batch-classify leftovers with title + Tags + Keywords.
  const allItems = [
    ...faqs.map((f, i) => ({
      bucket: 'faqs', index: i,
      title: f.title, answer: f.answer,
      keywords: f.keywords ?? '', tags: f.tags ?? '',
    })),
    ...needsReview.map((r, i) => ({
      bucket: 'needsReview', index: i,
      title: r.title, answer: r.answer ?? r.originalText ?? '',
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

  // 2. Rewrite items that need a generated response (normal + pushback + rto + escalation + internal-review).
  const rewriteTargets = [
    ...faqs.map((f, i) => ({ bucket: 'faqs', index: i, item: f })),
    ...needsReview
      .map((r, i) => ({ bucket: 'needsReview', index: i, item: r }))
      .filter(t => ['rto', 'escalation', 'internal-review'].includes(t.item.type)),
  ];
  await runWithConcurrency(rewriteTargets, REWRITE_CONCURRENCY, async (t) => {
    const { item } = t;
    const result = await callRewrite(client, item);
    if (result.refused) {
      item.agentProcedure = true;
      item.formattedAnswer = null;
    } else if (result.derivedTitle) {
      // Push-back response carries both a title and the body
      item.derivedTitle = result.derivedTitle;
      item.formattedAnswer = result.text;
    } else {
      item.formattedAnswer = result.text;
    }
  });

  // 2a. Push-back items inherit their primary's category (they're always
  // emitted immediately after the primary in faqs[], so look at i-1).
  for (let i = 1; i < faqs.length; i++) {
    if (faqs[i].type === 'pushback' && faqs[i - 1]?.type === 'normal') {
      faqs[i].category = faqs[i - 1].category;
    }
  }

  // 3. Write the output files.
  const outputFiles = {};
  outputFiles.docx = await writeDocx(sessionDir, faqs, needsReview);
  outputFiles.txt = writeTxt(sessionDir, faqs, needsReview);
  outputFiles.reviewXlsx = writeReviewXlsx(sessionDir, needsReview);
  outputFiles.validationCsv = writeValidationCsv(sessionDir, faqs, needsReview);

  return { outputFiles, formattedFaqs: faqs, formattedNeedsReview: needsReview };
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

function isOrderRelated(title, answer) {
  const haystack = `${title} ${answer ?? ''}`.toLowerCase();
  return ORDER_KEYWORDS.some(kw => haystack.includes(kw));
}

function matchTagsToCategory(tags) {
  if (!tags) return null;
  const norm = String(tags).toLowerCase().trim();
  if (!norm) return null;

  // Longest full-category-name match wins (more specific).
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

  // Reverse: a tag segment (length >= 5) that uniquely appears in one category.
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
    // Option B (PRD §7b): `forceConsent` (set by extractor when the answer or
    // General guidance contains "gather …details" or "rto") ALWAYS uses the
    // consent phrase. Otherwise, order-related escalations use the direct
    // email+name ask — the customer's info is already on file.
    const useConsent = item.forceConsent || !isOrderRelated(item.title, item.answer);
    if (useConsent) {
      systemPrompt = CONSENT_PROMPT;
      userPrompt = `Question: ${item.title}\n\nContext: ${item.answer}\n\nWrite the 2-paragraph response now. Paragraph 2 must contain the consent sentence verbatim.`;
    } else {
      systemPrompt = ESCALATION_PROMPT;
      userPrompt = `Question: ${item.title}\n\nContext: ${item.answer}\n\nWrite the 2-paragraph escalation response now, asking for email address first, then complete name.`;
    }
  } else if (item.type === 'internal-review') {
    systemPrompt = INTERNAL_REVIEW_PROMPT;
    userPrompt = `Question: ${item.title}\n\nInternal source content:\n${item.answer}\n\nApply the two-step process now. Reply with EITHER ${AGENT_PROCEDURE_TOKEN} OR the 2-paragraph rewrite — nothing else.`;
  } else if (item.type === 'pushback') {
    systemPrompt = PUSHBACK_PROMPT;
    userPrompt = `Original FAQ title: ${item.primaryTitle}\n\nPrimary answer (what the customer already saw):\n${item.primaryAnswer || '(no primary answer)'}\n\nInternal push-back context:\n${item.answer || '(no context)'}\n\nWrite the follow-up entry now in the required TITLE + 2-paragraph format.`;
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

  const content = response.choices[0].message.content.trim();

  // Internal-review: detect agent-procedure refusal anywhere in the response.
  if (item.type === 'internal-review' && content.toUpperCase().includes(AGENT_PROCEDURE_TOKEN)) {
    return { refused: true };
  }

  // Push-back: parse "TITLE: …" first line, then body (2 paragraphs).
  if (item.type === 'pushback') {
    const parsed = parsePushbackResponse(content);
    if (parsed) return { derivedTitle: parsed.title, text: parsed.body };
    // Fallback: no parseable TITLE line — use a templated title and the whole content as body
    return {
      derivedTitle: `If you need more specific information about ${item.primaryTitle}`,
      text: content,
    };
  }

  return { text: content };
}

function parsePushbackResponse(content) {
  const match = content.match(/^\s*TITLE\s*:\s*(.+?)\s*$/im);
  if (!match) return null;
  const title = match[1].replace(/^["'“”]+|["'“”]+$/g, '').trim();
  // Strip the TITLE line and any leading blank lines from the body
  const body = content.replace(/^\s*TITLE\s*:\s*.+?\s*\n+/im, '').trim();
  if (!title || !body) return null;
  return { title, body };
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
  return new Array(chunk.length).fill('OTHERS');
}

function safeParseJsonArray(text) {
  try {
    return JSON.parse(text);
  } catch {
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
// Grouping helper
// ---------------------------------------------------------------------------

function groupByCategory(items) {
  const map = new Map();
  for (const item of items) {
    const cat = item.category || 'OTHERS';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(item);
  }
  return CATEGORIES
    .filter(cat => map.has(cat))
    .map(cat => ({ category: cat, items: map.get(cat) }));
}

// ---------------------------------------------------------------------------
// Output: DOCX (PRD §11)
// ---------------------------------------------------------------------------

async function writeDocx(sessionDir, faqs, needsReview) {
  const children = [];

  // --- Section A: Processed FAQs grouped by category (centered H1) ---
  const mainGroups = groupByCategory(faqs);
  for (const { category, items } of mainGroups) {
    children.push(categoryHeading1(category));
    for (const faq of items) {
      const title = faq.type === 'pushback' ? (faq.derivedTitle || faq.title) : faq.title;
      children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_2 }));
      for (const para of splitParagraphs(faq.formattedAnswer)) {
        children.push(new Paragraph({ text: para }));
      }
      children.push(new Paragraph({ text: '' }));
    }
  }

  // --- Section B: Needs Review (RTO → Escalation → Internal Review → Other) ---
  const rto = needsReview.filter(r => r.type === 'rto');
  const escalation = needsReview.filter(r => r.type === 'escalation');
  const internalReview = needsReview.filter(r => r.type === 'internal-review');
  const other = needsReview.filter(r => r.type === 'other');

  if (rto.length || escalation.length || internalReview.length || other.length) {
    children.push(...reviewSeparator());

    if (rto.length) {
      children.push(reviewSectionHeading(`NEEDS REVIEW — RTO (${rto.length} items)`));
      pushReviewGroups(children, rto, { showResponse: true });
    }
    if (escalation.length) {
      children.push(reviewSectionHeading(`NEEDS REVIEW — ESCALATION (${escalation.length} items)`));
      pushReviewGroups(children, escalation, { showResponse: true });
    }
    if (internalReview.length) {
      children.push(reviewSectionHeading(`NEEDS REVIEW — INTERNAL (SHAREABLE?) (${internalReview.length} items)`));
      pushReviewGroups(children, internalReview, { showResponse: true, agentProcedureAware: true });
    }
    if (other.length) {
      children.push(reviewSectionHeading(`NEEDS REVIEW — OTHER (${other.length} items)`));
      pushReviewGroups(children, other, { showResponse: false });
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  const filePath = path.join(sessionDir, 'FAQ_DocStyle_Output.docx');
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function categoryHeading1(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
  });
}

function categoryHeading2(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    alignment: AlignmentType.CENTER,
  });
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

function pushReviewGroups(children, items, opts) {
  const { showResponse, agentProcedureAware = false } = opts;
  for (const { category, items: groupItems } of groupByCategory(items)) {
    children.push(categoryHeading2(category));
    for (const item of groupItems) {
      // Title
      children.push(new Paragraph({
        children: [new TextRun({ text: item.title, bold: true })],
      }));

      // Meta line: Reason | Status | Tags | Keywords (non-empty only)
      const metaLine = buildMetaLine(item);
      if (metaLine) children.push(metaLine);

      // Original Source section
      const originalText = item.answer || item.originalText || '';
      if (originalText) {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: `Original Source (${item.source || 'source'}):`, bold: true, color: '444444' }),
          ],
        }));
        for (const para of splitParagraphs(originalText)) {
          children.push(new Paragraph({
            children: [new TextRun({ text: para, color: '444444' })],
          }));
        }
      } else {
        children.push(new Paragraph({
          children: [new TextRun({ text: '(no source text available in this row)', italics: true, color: '888888' })],
        }));
      }

      // Agent Note — General guidance text that triggered the escalation
      if (item.internalNote) {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: 'Agent Note (General guidance): ', bold: true, color: 'B15C00' }),
            new TextRun({ text: item.internalNote, color: '6B4500' }),
          ],
        }));
      }

      // Suggested Response (or agent-procedure notice)
      if (showResponse) {
        children.push(new Paragraph({ text: '' }));
        if (agentProcedureAware && item.agentProcedure) {
          children.push(new Paragraph({
            children: [
              new TextRun({ text: 'Agent procedure — manual review required. ', bold: true, color: 'AA3333' }),
              new TextRun({
                text: 'This content appears to describe internal tool usage for support agents and cannot be safely rewritten as customer-facing.',
                color: '666666',
              }),
            ],
          }));
        } else if (item.formattedAnswer) {
          children.push(new Paragraph({
            children: [new TextRun({ text: 'Suggested Response:', bold: true, color: '1A6B1A' })],
          }));
          for (const para of splitParagraphs(item.formattedAnswer)) {
            children.push(new Paragraph({ text: para }));
          }
        }
      }

      children.push(new Paragraph({ text: '' }));
    }
  }
}

function buildMetaLine(item) {
  const parts = [];
  const pushPart = (label, value) => {
    if (value && String(value).trim()) parts.push({ label, value: String(value).trim() });
  };
  pushPart('Reason', item.reason);
  pushPart('Status', item.status);
  pushPart('Tags', item.tags);
  pushPart('Keywords', item.keywords);
  if (parts.length === 0) return null;

  const runs = [];
  parts.forEach((p, i) => {
    if (i > 0) runs.push(new TextRun({ text: '   |   ', color: '999999' }));
    runs.push(new TextRun({ text: `${p.label}: `, bold: true, color: '666666' }));
    runs.push(new TextRun({ text: p.value, color: '666666' }));
  });
  return new Paragraph({ children: runs });
}

function splitParagraphs(text) {
  return String(text || '').split('\n\n').map(p => p.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Output: TXT
// ---------------------------------------------------------------------------

function writeTxt(sessionDir, faqs, needsReview) {
  const lines = [];

  // Processed, grouped by category. "Centered" in TXT means visual framing.
  for (const { category, items } of groupByCategory(faqs)) {
    const bar = '━'.repeat(Math.max(40, category.length + 8));
    lines.push(bar, centerText(category, bar.length), bar, '');
    for (const faq of items) {
      const title = faq.type === 'pushback' ? (faq.derivedTitle || faq.title) : faq.title;
      lines.push(title, '', faq.formattedAnswer, '');
    }
  }

  const rto = needsReview.filter(r => r.type === 'rto');
  const escalation = needsReview.filter(r => r.type === 'escalation');
  const internalReview = needsReview.filter(r => r.type === 'internal-review');
  const other = needsReview.filter(r => r.type === 'other');

  if (rto.length || escalation.length || internalReview.length || other.length) {
    lines.push('', '════════════════════════════════════════════════════════════');
    lines.push(centerText('NEEDS REVIEW', 60));
    lines.push('════════════════════════════════════════════════════════════', '');

    if (rto.length) {
      lines.push(`--- RTO (${rto.length} items) ---`, '');
      writeReviewGroupsTxt(lines, rto, { showResponse: true });
    }
    if (escalation.length) {
      lines.push(`--- ESCALATION (${escalation.length} items) ---`, '');
      writeReviewGroupsTxt(lines, escalation, { showResponse: true });
    }
    if (internalReview.length) {
      lines.push(`--- INTERNAL (SHAREABLE?) (${internalReview.length} items) ---`, '');
      writeReviewGroupsTxt(lines, internalReview, { showResponse: true, agentProcedureAware: true });
    }
    if (other.length) {
      lines.push(`--- OTHER (${other.length} items) ---`, '');
      writeReviewGroupsTxt(lines, other, { showResponse: false });
    }
  }

  const filePath = path.join(sessionDir, 'FAQ_DocStyle_Output.txt');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

function centerText(text, width) {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad) + text;
}

function writeReviewGroupsTxt(lines, items, opts) {
  const { showResponse, agentProcedureAware = false } = opts;
  for (const { category, items: groupItems } of groupByCategory(items)) {
    const catLine = `[ ${category} ]`;
    lines.push(centerText(catLine, 60), '');

    for (const item of groupItems) {
      lines.push(item.title);
      const meta = buildMetaLineTxt(item);
      if (meta) lines.push(`  ${meta}`);

      const originalText = item.answer || item.originalText || '';
      if (originalText) {
        lines.push('', `  Original Source (${item.source || 'source'}):`);
        for (const para of splitParagraphs(originalText)) lines.push(`    ${para}`);
      } else {
        lines.push('  (no source text available in this row)');
      }

      if (item.internalNote) {
        lines.push(`  Agent Note (General guidance): ${item.internalNote}`);
      }

      if (showResponse) {
        lines.push('');
        if (agentProcedureAware && item.agentProcedure) {
          lines.push('  Agent procedure — manual review required.');
          lines.push('  This content appears to describe internal tool usage for support agents and cannot be safely rewritten as customer-facing.');
        } else if (item.formattedAnswer) {
          lines.push('  Suggested Response:');
          for (const para of splitParagraphs(item.formattedAnswer)) lines.push(`    ${para}`);
        }
      }
      lines.push('');
    }
  }
}

function buildMetaLineTxt(item) {
  const parts = [];
  if (item.reason) parts.push(`Reason: ${item.reason}`);
  if (item.status) parts.push(`Status: ${item.status}`);
  if (item.tags) parts.push(`Tags: ${item.tags}`);
  if (item.keywords) parts.push(`Keywords: ${item.keywords}`);
  return parts.length ? parts.join('   |   ') : null;
}

// ---------------------------------------------------------------------------
// Output: Needs Review XLSX (PRD §11)
// ---------------------------------------------------------------------------

function writeReviewXlsx(sessionDir, needsReview) {
  const typeOrder = { rto: 0, escalation: 1, 'internal-review': 2, other: 3 };
  const typeLabel = {
    rto: 'RTO',
    escalation: 'Escalation',
    'internal-review': 'Internal Review',
    other: 'Other',
  };
  const catIndex = new Map(CATEGORIES.map((c, i) => [c, i]));

  const sorted = [...needsReview].sort((a, b) => {
    const t = (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
    if (t !== 0) return t;
    return (catIndex.get(a.category) ?? 99) - (catIndex.get(b.category) ?? 99);
  });

  const rows = sorted.map(item => {
    const originalText = item.answer || item.originalText || '';
    let generatedResponse = item.formattedAnswer || '';
    if (item.type === 'internal-review' && item.agentProcedure) {
      generatedResponse = '(Agent procedure — not rewritten; manual review required)';
    }
    return {
      'FAQ Title': item.title,
      'Type': typeLabel[item.type] || 'Other',
      'Category': item.category || 'OTHERS',
      'Reason Flagged': item.reason || '',
      'Status': item.status || '',
      'Tags': item.tags || '',
      'Keywords': item.keywords || '',
      'Source Column': item.source || '',
      'Original Source Text': originalText,
      'Agent Note': item.internalNote || '',
      'Generated Response': generatedResponse,
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows, {
    header: [
      'FAQ Title', 'Type', 'Category', 'Reason Flagged', 'Status',
      'Tags', 'Keywords', 'Source Column', 'Original Source Text',
      'Agent Note', 'Generated Response',
    ],
  });
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
  const typeLabel = {
    normal: 'Normal',
    pushback: 'Push-back',
    rto: 'RTO',
    escalation: 'Escalation',
    'internal-review': 'Internal Review',
    other: 'Other',
  };
  const rows = [
    ...faqs.map(faq => ({
      'FAQ Title': faq.type === 'pushback' ? (faq.derivedTitle || faq.title) : faq.title,
      'Status': 'Processed',
      'Type': typeLabel[faq.type] || 'Normal',
      'Category': faq.category || 'OTHERS',
      'Source': faq.source,
      'Answer Preview': preview(faq.formattedAnswer),
    })),
    ...needsReview.map(item => ({
      'FAQ Title': item.title,
      'Status': 'Needs Review',
      'Type': typeLabel[item.type] || 'Other',
      'Category': item.category || 'OTHERS',
      'Source': item.source,
      'Answer Preview': item.formattedAnswer
        ? preview(item.formattedAnswer)
        : (item.agentProcedure ? 'Agent procedure — no rewrite' : `Flagged: ${item.reason}`),
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

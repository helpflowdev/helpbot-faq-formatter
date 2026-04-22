import { loadSession } from './parser.js';

// Prefixes that mark General guidance as internal-only (case-insensitive).
// Any of these triggers the internal-review flow (PRD §7d).
const INTERNAL_MARKERS = [
  'internal',           // includes "INTERNAL", "INTERNAL ONLY"
  'not for customer',
  'do not share',
  'confidential',
];
const MAX_REPLY_INDEX = 17;

// Status values that mean: skip this FAQ entirely
const SKIP_STATUSES = ['archived', 'submitted', 'suggested'];

// Keywords in the answer OR General guidance that signal this FAQ needs escalation
const ESCALATION_KEYWORDS = [
  'escalat',            // matches escalate/escalation/etc.
  'raise a case',
  'raise a ticket',
  'create a case',
  'create a ticket',
  'follow up with you',
];

// Broader "gather [all|the|necessary|...] details/info" match. When this fires,
// OR the answer/GG contains the word "rto", we FORCE the CONSENT_PROMPT
// regardless of order-related detection (PRD §7b/§7d — Option B, GDPR-safe
// default for any situation that requires gathering new PII).
const GATHER_DETAILS_RE = /gather\s+(?:all\s+|the\s+|necessary\s+)*(?:details?|info(?:rmation)?)/i;
const RTO_WORD_RE = /\brto\b/i;

/**
 * Apply the 4-step extraction priority to every FAQ row.
 * Returns { faqs, needsReview }.
 *
 * Routing summary (PRD §7 / §7a / §7d):
 *   faqs[]                    — main output, type='normal', gets rewritten
 *   needsReview[] type='rto'  — has answer, gets rewritten (escalation prompt)
 *   needsReview[] type='escalation' — has answer, gets rewritten (consent/email prompt)
 *   needsReview[] type='internal-review' — has answer, goes through the
 *       agent-procedure gate; generator either rewrites or marks as refused
 *   needsReview[] type='other' — Archived/Submitted/Suggested/No-answer;
 *       NO generated response, but carries originalText so the reviewer can
 *       see the raw row content
 *
 * Every item also carries: keywords, tags, status, and where available
 * `answer` (source text) and/or `originalText` (raw Reply 1 when no answer
 * could be extracted).
 */
export function extractAnswers(sessionId) {
  const { rows, meta } = loadSession(sessionId);
  const { normalisedCols, titleCol } = meta;

  const faqs = [];
  const needsReview = [];

  for (const row of rows) {
    const title = String(row[titleCol] ?? '').trim();
    if (!title || title.toLowerCase() === 'nan') continue;

    const rawStatus = getCol(row, normalisedCols, 'status');
    const status = rawStatus.toLowerCase();
    const keywords = getCol(row, normalisedCols, 'keywords');
    const tags = getCol(row, normalisedCols, 'tags');

    // For "Other" items we want to surface the raw row content so the reviewer
    // knows what was in the spreadsheet. Use the first non-empty Reply X.
    const firstReplyText = getFirstReplyText(row, normalisedCols);

    // Status-based exclusion takes precedence over everything else
    if (SKIP_STATUSES.some(s => status.includes(s))) {
      needsReview.push({
        title,
        reason: `Status: ${rawStatus} — excluded from output`,
        source: 'Status column',
        type: 'other',
        keywords,
        tags,
        status: rawStatus,
        originalText: firstReplyText,
      });
      continue;
    }

    const result = extractRow(row, normalisedCols);

    // Internal-review: General guidance is marked internal (any supported
    // marker). Carry the full unredacted text as `answer` — generator.js will
    // run the agent-procedure gate and either rewrite it or mark it refused.
    if (result.internalText) {
      needsReview.push({
        title,
        reason: 'Internal content — review required',
        source: 'General guidance',
        type: 'internal-review',
        answer: result.internalText,
        keywords,
        tags,
        status: rawStatus,
      });
      continue;
    }

    if (!result.answer) {
      needsReview.push({
        title,
        reason: result.reason,
        source: result.source,
        type: 'other',
        keywords,
        tags,
        status: rawStatus,
        originalText: firstReplyText,
      });
      continue;
    }

    // Escalation detection — scan Reply AND General guidance separately so
    // we can distinguish three outcomes (PRD §7a/§7e):
    //   - Reply has escalation language → route to Needs Review (single-intent)
    //   - GG has escalation signal but Reply is clean → PUSH-BACK pattern:
    //       emit TWO main-output FAQs (primary + customer-voiced push-back)
    //   - Neither → normal FAQ
    const generalGuidance = getCol(row, normalisedCols, 'general guidance');

    const gatherInAnswer = GATHER_DETAILS_RE.test(result.answer);
    const rtoInAnswer = RTO_WORD_RE.test(result.answer);
    const otherEscInAnswer = ESCALATION_KEYWORDS.some(kw =>
      result.answer.toLowerCase().includes(kw)
    );
    const answerHasTrigger = gatherInAnswer || rtoInAnswer || otherEscInAnswer;

    const gatherInGG = GATHER_DETAILS_RE.test(generalGuidance);
    const rtoInGG = RTO_WORD_RE.test(generalGuidance);
    const otherEscInGG = ESCALATION_KEYWORDS.some(kw =>
      generalGuidance.toLowerCase().includes(kw)
    );
    const ggHasTrigger = gatherInGG || rtoInGG || otherEscInGG;

    // forceConsent (for Needs Review escalations): any "gather …details" /
    // "rto" signal in answer or GG forces CONSENT_PROMPT regardless of
    // order-related detection. GDPR-safe when collecting fresh PII.
    const forceConsent = gatherInAnswer || rtoInAnswer || gatherInGG || rtoInGG;

    const isRTO = status === 'rto';

    if (isRTO) {
      // Status=RTO takes precedence — always Needs Review
      const internalNote = (!answerHasTrigger && ggHasTrigger && generalGuidance)
        ? generalGuidance : '';
      needsReview.push({
        title,
        reason: 'RTO — requires review',
        source: result.source,
        type: 'rto',
        answer: result.answer,
        keywords,
        tags,
        status: rawStatus,
        forceConsent,
        internalNote,
      });
      continue;
    }

    if (answerHasTrigger) {
      // Reply itself directs to escalation (e.g., "please raise a ticket").
      // Keep as Needs Review — human should vet what the bot says to customers.
      const internalNote = (ggHasTrigger && generalGuidance) ? generalGuidance : '';
      needsReview.push({
        title,
        reason: 'Escalation — requires review',
        source: result.source,
        type: 'escalation',
        answer: result.answer,
        keywords,
        tags,
        status: rawStatus,
        forceConsent,
        internalNote,
      });
      continue;
    }

    if (ggHasTrigger) {
      // PUSH-BACK PATTERN (PRD §7e):
      // Reply is a clean customer answer; GG carries an escalation signal
      // ("if visitors really want to know…, gather details and RTO").
      // Emit TWO main-output FAQ entries:
      //   1) Primary — normal rewrite of Reply
      //   2) Push-back — customer-voiced follow-up title + consent phrase
      faqs.push({
        title,
        answer: result.answer,
        source: result.source,
        type: 'normal',
        keywords,
        tags,
        status: rawStatus,
      });
      faqs.push({
        title,                           // placeholder — generator derives customer-voiced title
        primaryTitle: title,
        primaryAnswer: result.answer,    // Reply 1 content, for LLM context
        answer: generalGuidance,         // the push-back / GG context
        source: 'General guidance',
        type: 'pushback',
        forceConsent: true,
        keywords,
        tags,
        status: rawStatus,
      });
      continue;
    }

    // Clean normal FAQ
    faqs.push({
      title,
      answer: result.answer,
      source: result.source,
      type: 'normal',
      keywords,
      tags,
      status: rawStatus,
    });
  }

  return { faqs, needsReview };
}

// ---------------------------------------------------------------------------
// Core extraction logic — strictly follows PRD Section 7 priority order
// ---------------------------------------------------------------------------

function extractRow(row, cols) {
  // Step 1: Reply 1 if Condition 1 is GENERAL or blank
  const reply1 = getCol(row, cols, 'reply 1');
  const condition1 = getCol(row, cols, 'condition 1');
  if (reply1 && isGeneralOrBlank(condition1)) {
    return { answer: reply1, source: 'Reply 1', reason: null };
  }

  // Step 2: First Reply X (1–17) where Condition X contains GENERAL
  for (let i = 1; i <= MAX_REPLY_INDEX; i++) {
    const reply = getCol(row, cols, `reply ${i}`);
    const condition = getCol(row, cols, `condition ${i}`);
    if (reply && containsGeneral(condition)) {
      return { answer: reply, source: `Reply ${i}`, reason: null };
    }
  }

  // Step 3: General guidance — if marked internal, return the text so the
  // caller can route to the internal-review flow (no longer silently excluded)
  const general = getCol(row, cols, 'general guidance');
  if (general) {
    if (isInternal(general)) {
      return { answer: null, source: 'General guidance', reason: 'Internal content', internalText: general };
    }
    return { answer: general, source: 'General guidance', reason: null };
  }

  // Step 4: Needs Review
  return { answer: null, source: 'None', reason: 'No valid answer found' };
}

function getFirstReplyText(row, cols) {
  for (let i = 1; i <= MAX_REPLY_INDEX; i++) {
    const reply = getCol(row, cols, `reply ${i}`);
    if (reply) return reply;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCol(row, cols, colName) {
  const actual = cols[colName];
  if (!actual) return '';
  const val = row[actual];
  if (val === null || val === undefined) return '';
  const str = String(val).trim();
  return str.toLowerCase() === 'nan' ? '' : str;
}

function isGeneralOrBlank(condition) {
  return !condition || condition.toLowerCase().includes('general');
}

function containsGeneral(condition) {
  return Boolean(condition) && condition.toLowerCase().includes('general');
}

function isInternal(text) {
  const lower = text.toLowerCase().trim();
  return INTERNAL_MARKERS.some(marker => lower.startsWith(marker));
}

import { loadSession } from './parser.js';

// Prefixes that mark General guidance as internal-only (case-insensitive)
const INTERNAL_MARKERS = ['internal', 'not for customer'];
const MAX_REPLY_INDEX = 17;

// Status values that mean: skip this FAQ entirely
const SKIP_STATUSES = ['archived', 'submitted', 'suggested'];

// Keywords in the answer that signal this FAQ needs escalation
const ESCALATION_KEYWORDS = [
  'gather details',
  'gather information',
  'escalat',
  'raise a case',
  'raise a ticket',
  'create a case',
  'create a ticket',
  'follow up with you',
];

/**
 * Apply the 4-step extraction priority to every FAQ row.
 * Returns { faqs, needsReview }.
 *
 * PRD §7/§7a: RTO (Status = RTO) and Escalation (keyword-in-answer) route to
 * needsReview — not the main output — but they still carry `answer` so a
 * 2-paragraph response is generated downstream.
 *
 * Every item also carries `keywords` and `tags` (from the spreadsheet's
 * Keywords and Tags columns) so the generator can use them as signals for
 * category classification (PRD §7c).
 *
 * faq shape:          { title, answer, source, type: 'normal', keywords, tags }
 * needsReview shape:  { title, reason, source, type, keywords, tags, answer? }
 *   type = 'rto' | 'escalation' | 'other'
 *   answer is present for rto/escalation so generator.js can rewrite it
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

    // Status-based exclusion takes precedence over everything else
    if (SKIP_STATUSES.some(s => status.includes(s))) {
      needsReview.push({
        title,
        reason: `Status: ${rawStatus} — excluded from output`,
        source: 'Status column',
        type: 'other',
        keywords,
        tags,
      });
      continue;
    }

    const result = extractRow(row, normalisedCols);

    if (!result.answer) {
      needsReview.push({
        title,
        reason: result.reason,
        source: result.source,
        type: 'other',
        keywords,
        tags,
      });
      continue;
    }

    // Route RTO / Escalation to needsReview (still gets a generated response).
    // RTO takes precedence over Escalation when both match.
    const isRTO = status === 'rto';
    const mentionsEscalation = ESCALATION_KEYWORDS.some(kw =>
      result.answer.toLowerCase().includes(kw)
    );

    if (isRTO) {
      needsReview.push({
        title,
        reason: 'RTO — requires review',
        source: result.source,
        type: 'rto',
        answer: result.answer,
        keywords,
        tags,
      });
    } else if (mentionsEscalation) {
      needsReview.push({
        title,
        reason: 'Escalation — requires review',
        source: result.source,
        type: 'escalation',
        answer: result.answer,
        keywords,
        tags,
      });
    } else {
      faqs.push({
        title,
        answer: result.answer,
        source: result.source,
        type: 'normal',
        keywords,
        tags,
      });
    }
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

  // Step 3: General guidance (not empty, not internal)
  const general = getCol(row, cols, 'general guidance');
  if (general) {
    if (isInternal(general)) {
      return { answer: null, source: 'General guidance', reason: 'Internal content' };
    }
    return { answer: general, source: 'General guidance', reason: null };
  }

  // Step 4: Needs Review
  return { answer: null, source: 'None', reason: 'No valid answer found' };
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

import { loadSession } from './parser.js';

// Prefixes that mark General guidance as internal-only (case-insensitive)
const INTERNAL_MARKERS = ['internal', 'not for customer'];
const MAX_REPLY_INDEX = 17;

// Status values that mean: skip this FAQ entirely
const SKIP_STATUSES = ['archived', 'submitted', 'suggested'];

// Keywords in the answer that signal this FAQ needs escalation (email + name collection)
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
 * faq shape:    { title, answer, source, type }
 *   type = 'normal' | 'escalation'
 *
 * needsReview shape: { title, reason, source }
 */
export function extractAnswers(sessionId) {
  const { rows, meta } = loadSession(sessionId);
  const { normalisedCols, titleCol } = meta;

  const faqs = [];
  const needsReview = [];

  for (const row of rows) {
    const title = String(row[titleCol] ?? '').trim();
    if (!title || title.toLowerCase() === 'nan') continue;

    // --- Status check: skip Archived / Submitted / Suggested before anything else ---
    const status = getCol(row, normalisedCols, 'status').toLowerCase();
    if (SKIP_STATUSES.some(s => status.includes(s))) {
      needsReview.push({
        title,
        reason: `Status: ${getCol(row, normalisedCols, 'status')} — excluded from output`,
        source: 'Status column',
      });
      continue;
    }

    const result = extractRow(row, normalisedCols);

    if (result.answer) {
      // Determine if this FAQ requires escalation (RTO status OR answer mentions escalation)
      const isRTO = status === 'rto';
      const answerMentionsEscalation = ESCALATION_KEYWORDS.some(kw =>
        result.answer.toLowerCase().includes(kw)
      );

      faqs.push({
        title,
        answer: result.answer,
        source: result.source,
        type: isRTO || answerMentionsEscalation ? 'escalation' : 'normal',
      });
    } else {
      needsReview.push({ title, reason: result.reason, source: result.source });
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

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

// Status values that mean: skip this FAQ row entirely
const SKIP_STATUSES = ['archived', 'submitted', 'suggested'];

// Escalation keywords checked in the answer OR the associated Guidance text.
// Used alongside the two regexes below to route to Needs Review / push-back.
const ESCALATION_KEYWORDS = [
  'escalat',            // escalate / escalation
  'raise a case',
  'raise a ticket',
  'create a case',
  'create a ticket',
  'follow up with you',
];

// Regexes for "force consent" triggers (PRD §7b) and multi-FAQ push-back.
const GATHER_DETAILS_RE = /gather\s+(?:all\s+|the\s+|necessary\s+)*(?:details?|info(?:rmation)?)/i;
const RTO_WORD_RE = /\brto\b/i;

/**
 * Apply extraction to every row of the session.
 *
 * Two structural modes per row (PRD §7, §7f):
 *
 *   SINGLE-FAQ mode — all Condition columns are blank or contain "GENERAL".
 *   Produces at most one FAQ per row using the 4-step priority
 *   (Reply 1 / first GENERAL Reply / General guidance / Needs Review).
 *   Row Title is the FAQ title.
 *
 *   MULTI-FAQ mode — at least one Condition column is a specific
 *   customer-facing question (non-blank, non-GENERAL). Row Title becomes a
 *   container label; each non-empty condition slot emits its OWN FAQ with
 *   Condition X as the title and Reply X as the answer. Per-slot escalation
 *   detection runs against Guidance X + the row-level General guidance.
 *
 * Every emitted item runs through the same downstream routing (normal,
 * push-back, escalation, rto, internal-review, other) and inherits row-level
 * Tags, Keywords, Status.
 */
export function extractAnswers(sessionId) {
  const { rows, meta } = loadSession(sessionId);
  const { normalisedCols, titleCol } = meta;

  const faqs = [];
  const needsReview = [];

  for (const row of rows) {
    processRow(row, normalisedCols, titleCol, faqs, needsReview);
  }

  return { faqs, needsReview };
}

// ---------------------------------------------------------------------------
// Row-level dispatch
// ---------------------------------------------------------------------------

function processRow(row, cols, titleCol, faqs, needsReview) {
  const rowTitle = String(row[titleCol] ?? '').trim();
  if (!rowTitle || rowTitle.toLowerCase() === 'nan') return;

  const rawStatus = getCol(row, cols, 'status');
  const status = rawStatus.toLowerCase();
  const keywords = getCol(row, cols, 'keywords');
  const tags = getCol(row, cols, 'tags');
  const rowGG = getCol(row, cols, 'general guidance');

  const rowMeta = { rowTitle, rawStatus, status, keywords, tags };

  // Status-based exclusion takes precedence (one entry per row regardless of mode)
  if (SKIP_STATUSES.some(s => status.includes(s))) {
    needsReview.push({
      title: rowTitle,
      reason: `Status: ${rawStatus} — excluded from output`,
      source: 'Status column',
      type: 'other',
      keywords,
      tags,
      status: rawStatus,
      originalText: getFirstReplyText(row, cols),
    });
    return;
  }

  const slots = collectSlots(row, cols);
  const isMulti = slots.some(s => s.condition && !isGeneralOrBlank(s.condition));

  if (isMulti) {
    routeMultiFaq(slots, rowGG, rowMeta, faqs, needsReview);
  } else {
    routeSingleFaq(slots, rowGG, rowMeta, faqs, needsReview);
  }
}

// ---------------------------------------------------------------------------
// Single-FAQ row — 4-step priority (unchanged semantics)
// ---------------------------------------------------------------------------

function routeSingleFaq(slots, rowGG, rowMeta, faqs, needsReview) {
  const { rowTitle, keywords, tags, rawStatus } = rowMeta;

  // Step 1: Reply 1 if Condition 1 is blank or GENERAL
  const slot1 = slots.find(s => s.i === 1);
  if (slot1 && slot1.reply && isGeneralOrBlank(slot1.condition)) {
    routeItem(rowTitle, slot1.reply, 'Reply 1', rowGG, rowMeta, faqs, needsReview);
    return;
  }

  // Step 2: first Reply X (1–17) with Condition X containing GENERAL
  for (const slot of slots) {
    if (slot.reply && containsGeneral(slot.condition)) {
      routeItem(rowTitle, slot.reply, `Reply ${slot.i}`, rowGG, rowMeta, faqs, needsReview);
      return;
    }
  }

  // Step 3: General guidance (if non-empty)
  if (rowGG) {
    if (isInternal(rowGG)) {
      needsReview.push({
        title: rowTitle,
        reason: 'Internal content — review required',
        source: 'General guidance',
        type: 'internal-review',
        answer: rowGG,
        keywords,
        tags,
        status: rawStatus,
      });
      return;
    }
    routeItem(rowTitle, rowGG, 'General guidance', '', rowMeta, faqs, needsReview);
    return;
  }

  // Step 4: Needs Review — no valid answer found
  needsReview.push({
    title: rowTitle,
    reason: 'No valid answer found',
    source: 'None',
    type: 'other',
    keywords,
    tags,
    status: rawStatus,
    originalText: '',
  });
}

// ---------------------------------------------------------------------------
// Multi-FAQ row — emit one FAQ per non-empty condition slot (PRD §7f)
// ---------------------------------------------------------------------------

function routeMultiFaq(slots, rowGG, rowMeta, faqs, needsReview) {
  const { rowTitle, keywords, tags, rawStatus } = rowMeta;

  for (const slot of slots) {
    // Skip fully empty slots (shouldn't land here but defensive)
    if (!slot.reply && !slot.condition && !slot.guidance) continue;

    // In multi-FAQ mode, a slot with no reply AND no condition isn't a FAQ.
    if (!slot.reply && !slot.condition) continue;

    const isSpecific = slot.condition && !isGeneralOrBlank(slot.condition);
    const title = isSpecific ? slot.condition : rowTitle;

    // Per-sub-FAQ escalation context: per-slot Guidance + row-level General guidance
    // (the row-level GG is a blanket instruction that applies to every sub-FAQ).
    const combinedGuidance = [slot.guidance, rowGG].filter(Boolean).join('\n');

    // Condition present but no customer-facing answer → Needs Review → Other
    // (Option 1 from the product decision — transparency over silent drop.)
    if (!slot.reply) {
      needsReview.push({
        title,
        reason: 'No customer-facing answer available',
        source: `Reply ${slot.i}`,
        type: 'other',
        keywords,
        tags,
        status: rawStatus,
        originalText: '',
        internalNote: combinedGuidance,
      });
      continue;
    }

    routeItem(title, slot.reply, `Reply ${slot.i}`, combinedGuidance, rowMeta, faqs, needsReview);
  }
}

// ---------------------------------------------------------------------------
// Shared routing: given a single (title, answer, source, guidance) tuple,
// decide type and push to faqs or needsReview. Same rules as the previous
// single-row extractor applied now at the sub-FAQ level.
// ---------------------------------------------------------------------------

function routeItem(title, answer, source, associatedGuidance, rowMeta, faqs, needsReview) {
  const { rawStatus, status, keywords, tags } = rowMeta;

  const isRTO = status === 'rto';

  const gatherInAnswer = GATHER_DETAILS_RE.test(answer);
  const rtoInAnswer = RTO_WORD_RE.test(answer);
  const otherEscInAnswer = ESCALATION_KEYWORDS.some(kw =>
    answer.toLowerCase().includes(kw)
  );
  const answerHasTrigger = gatherInAnswer || rtoInAnswer || otherEscInAnswer;

  const gatherInGG = GATHER_DETAILS_RE.test(associatedGuidance);
  const rtoInGG = RTO_WORD_RE.test(associatedGuidance);
  const otherEscInGG = ESCALATION_KEYWORDS.some(kw =>
    associatedGuidance.toLowerCase().includes(kw)
  );
  const ggHasTrigger = gatherInGG || rtoInGG || otherEscInGG;

  // PRD §7b — "gather …details" / "rto" forces CONSENT_PROMPT.
  const forceConsent = gatherInAnswer || rtoInAnswer || gatherInGG || rtoInGG;

  if (isRTO) {
    const internalNote = (!answerHasTrigger && ggHasTrigger && associatedGuidance)
      ? associatedGuidance : '';
    needsReview.push({
      title,
      reason: 'RTO — requires review',
      source,
      type: 'rto',
      answer,
      keywords,
      tags,
      status: rawStatus,
      forceConsent,
      internalNote,
    });
    return;
  }

  if (answerHasTrigger) {
    // Reply itself directs to escalation — human should vet the customer-facing text.
    const internalNote = (ggHasTrigger && associatedGuidance) ? associatedGuidance : '';
    needsReview.push({
      title,
      reason: 'Escalation — requires review',
      source,
      type: 'escalation',
      answer,
      keywords,
      tags,
      status: rawStatus,
      forceConsent,
      internalNote,
    });
    return;
  }

  if (ggHasTrigger) {
    // PUSH-BACK pattern (PRD §7e): clean Reply + escalation signal in Guidance.
    // Emit a primary normal FAQ plus a derived push-back follow-up.
    faqs.push({
      title,
      answer,
      source,
      type: 'normal',
      keywords,
      tags,
      status: rawStatus,
    });
    faqs.push({
      title,                           // placeholder — generator derives the real title
      primaryTitle: title,
      primaryAnswer: answer,           // Reply content, LLM context
      answer: associatedGuidance,      // push-back / GG context
      source: 'General guidance',
      type: 'pushback',
      forceConsent: true,
      keywords,
      tags,
      status: rawStatus,
    });
    return;
  }

  // Clean normal FAQ
  faqs.push({
    title,
    answer,
    source,
    type: 'normal',
    keywords,
    tags,
    status: rawStatus,
  });
}

// ---------------------------------------------------------------------------
// Slot collection + helpers
// ---------------------------------------------------------------------------

function collectSlots(row, cols) {
  const slots = [];
  for (let i = 1; i <= MAX_REPLY_INDEX; i++) {
    const reply = getCol(row, cols, `reply ${i}`);
    const condition = getCol(row, cols, `condition ${i}`);
    const guidance = getCol(row, cols, `guidance ${i}`);
    if (reply || condition || guidance) {
      slots.push({ i, reply, condition, guidance });
    }
  }
  return slots;
}

function getFirstReplyText(row, cols) {
  for (let i = 1; i <= MAX_REPLY_INDEX; i++) {
    const reply = getCol(row, cols, `reply ${i}`);
    if (reply) return reply;
  }
  return '';
}

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

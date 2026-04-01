import * as XLSX from 'xlsx';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

const OUTPUTS_DIR = path.join(process.cwd(), 'outputs');
const MAX_REPLY_INDEX = 17;

/**
 * Parse an uploaded .xlsx buffer.
 * Saves session data to outputs/<sessionId>/ for later pipeline stages.
 * Returns session stats for the UI.
 */
export function parseExcel(buffer, filename, clientCode) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    throw new Error('Could not read the file. Make sure it is a valid .xlsx file.');
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (rows.length === 0) {
    throw new Error('The Excel file appears to be empty.');
  }

  // Build a lowercase → original column name map
  const allColumns = Object.keys(rows[0]);
  const normalisedCols = {};
  for (const col of allColumns) {
    normalisedCols[col.trim().toLowerCase()] = col.trim();
  }

  // Title column is required
  if (!normalisedCols['title']) {
    throw new Error(
      'Required column "Title" was not found. Please check your Excel file and try again.'
    );
  }

  const titleCol = normalisedCols['title'];
  const faqRows = rows.filter(r => String(r[titleCol] ?? '').trim() !== '');
  const totalFaqs = faqRows.length;

  if (totalFaqs === 0) {
    throw new Error('No FAQ rows detected. The Title column appears to be empty.');
  }

  // Persist session
  const sessionId = uuidv4();
  const sessionDir = path.join(OUTPUTS_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const meta = { clientCode, filename, totalRows: rows.length, totalFaqs, titleCol, normalisedCols };
  fs.writeFileSync(path.join(sessionDir, 'data.json'), JSON.stringify(rows));
  fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));

  return { sessionId, filename, totalRows: rows.length, totalFaqs };
}

/** Load a previously saved session from disk. */
export function loadSession(sessionId) {
  const sessionDir = path.join(process.cwd(), 'outputs', sessionId);
  const rows = JSON.parse(fs.readFileSync(path.join(sessionDir, 'data.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, 'meta.json'), 'utf8'));
  return { rows, meta };
}

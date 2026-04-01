import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';
import { loadSession } from './parser.js';

const SCOPES = ['https://www.googleapis.com/auth/drive'];

const MIME_TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt':  'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv':  'text/csv',
};

/**
 * Upload all generated files to Google Drive.
 * Creates a subfolder: ClientCode_FAQ_Run_YYYY-MM-DD inside the configured parent.
 */
export async function uploadToDrive(sessionId, outputFiles) {
  try {
    const drive = getDriveClient();
    const { meta } = loadSession(sessionId);
    const parentFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    const today = new Date().toISOString().split('T')[0];
    const folderName = `${meta.clientCode}_FAQ_Run_${today}`;
    const folderId = await createFolder(drive, folderName, parentFolderId);
    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;

    let docUrl = null;
    for (const [key, filePath] of Object.entries(outputFiles)) {
      if (!filePath || !fs.existsSync(filePath)) continue;
      const fileId = await uploadFile(drive, filePath, folderId);
      if (key === 'docx') {
        docUrl = `https://drive.google.com/file/d/${fileId}/view`;
      }
    }

    return { success: true, folderUrl, docUrl };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Drive helpers
// ---------------------------------------------------------------------------

function getDriveClient() {
  // GOOGLE_SERVICE_ACCOUNT_JSON can be a raw JSON string (Railway/cloud) or a file path (local dev)
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
  const credentials = raw.startsWith('{') ? JSON.parse(raw) : JSON.parse(fs.readFileSync(raw, 'utf8'));
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  return google.drive({ version: 'v3', auth });
}

async function createFolder(drive, name, parentId) {
  const res = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  return res.data.id;
}

async function uploadFile(drive, filePath, folderId) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
  const res = await drive.files.create({
    requestBody: { name: path.basename(filePath), parents: [folderId] },
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: 'id',
  });
  return res.data.id;
}

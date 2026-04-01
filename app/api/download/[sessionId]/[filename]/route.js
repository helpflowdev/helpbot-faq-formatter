import path from 'path';
import fs from 'fs';

const OUTPUTS_DIR = path.join(process.cwd(), 'outputs');

export async function GET(request, { params }) {
  const { sessionId, filename } = params;

  // Prevent path traversal
  const safeSession = path.basename(sessionId);
  const safeName = path.basename(filename);
  const filePath = path.join(OUTPUTS_DIR, safeSession, safeName);

  if (!fs.existsSync(filePath)) {
    return new Response(JSON.stringify({ error: 'File not found.' }), { status: 404 });
  }

  const fileBuffer = fs.readFileSync(filePath);
  return new Response(fileBuffer, {
    headers: {
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Type': 'application/octet-stream',
    },
  });
}

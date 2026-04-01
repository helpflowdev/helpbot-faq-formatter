import { loadSession } from './parser.js';

/**
 * Send a Slack notification after a confirmed Drive upload.
 * Must only be called after driveResult.success is true.
 */
export async function sendSlackNotification(sessionId, faqs, needsReview, driveResult) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return { success: false, error: 'SLACK_WEBHOOK_URL not configured.' };
  }

  const { meta } = loadSession(sessionId);

  const message = buildMessage({
    filename: meta.filename,
    totalFaqs: meta.totalFaqs,
    processed: faqs.length,
    flagged: needsReview.length,
    folderUrl: driveResult.folderUrl || 'N/A',
    docUrl: driveResult.docUrl || 'N/A',
  });

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      return { success: false, error: `Slack returned ${res.status}: ${await res.text()}` };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function buildMessage({ filename, totalFaqs, processed, flagged, folderUrl, docUrl }) {
  return {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'FAQ Processing Complete' },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*File:*\n${filename}` },
          { type: 'mrkdwn', text: `*Total FAQs:*\n${totalFaqs}` },
          { type: 'mrkdwn', text: `*Processed:*\n${processed}` },
          { type: 'mrkdwn', text: `*Needs Review:*\n${flagged}` },
        ],
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Drive Folder:*\n<${folderUrl}|Open Folder>` },
          { type: 'mrkdwn', text: `*Doc Output:*\n<${docUrl}|Open Document>` },
        ],
      },
    ],
  };
}

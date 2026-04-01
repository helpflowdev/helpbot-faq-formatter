import { extractAnswers } from '@/lib/extractor';
import { generateOutputs } from '@/lib/generator';
import { uploadToDrive } from '@/lib/uploader';
import { sendSlackNotification } from '@/lib/notifier';

// Allow long-running pipeline (Claude API + Drive upload)
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const sessionId = request.nextUrl.searchParams.get('session_id');

  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Missing session_id.' }), { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(data) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        // Stage 1: Extract answers
        send({ stage: 'Extracting Approved Answers', step: 1 });
        const { faqs, needsReview } = extractAnswers(sessionId);

        // Stages 2–3: Internal only — not exposed in UI
        send({ stage: 'Generating Stress Test Scenarios', step: 2 });
        send({ stage: 'Validating Policy Compliance', step: 3 });

        // Stage 4: Generate output files via Claude
        send({ stage: 'Generating Doc-Style Output', step: 4 });
        const outputFiles = await generateOutputs(sessionId, faqs, needsReview);

        // Stage 5: Upload to Drive (skipped if GOOGLE_DRIVE_FOLDER_ID is not set)
        send({ stage: 'Uploading to Google Drive', step: 5 });
        const driveEnabled = Boolean(process.env.GOOGLE_DRIVE_FOLDER_ID);
        let driveResult = { success: false, folderUrl: null, docUrl: null };

        if (driveEnabled) {
          driveResult = await uploadToDrive(sessionId, outputFiles);
          if (!driveResult.success) {
            send({ error: `Drive upload failed: ${driveResult.error}` });
            controller.close();
            return;
          }
        }

        // Stage 6: Slack notification (skipped if SLACK_WEBHOOK_URL is not set, or Drive was skipped)
        send({ stage: 'Sending Slack Notification', step: 6 });
        let slackResult = { success: true };
        if (driveEnabled && process.env.SLACK_WEBHOOK_URL) {
          slackResult = await sendSlackNotification(sessionId, faqs, needsReview, driveResult);
        }

        // Done
        send({
          stage: 'complete',
          total: faqs.length + needsReview.length,
          processed: faqs.length,
          flagged: needsReview.length,
          driveFolderUrl: driveResult.folderUrl,
          docUrl: driveResult.docUrl,
          slackError: slackResult.success ? null : slackResult.error,
        });
      } catch (e) {
        send({ error: `Unexpected error: ${e.message}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',  // Disable Railway/nginx proxy buffering
    },
  });
}

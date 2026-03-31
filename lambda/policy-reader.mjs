/**
 * policy-reader.mjs
 *
 * Reads the mandatory training policy PDF from S3 and uses Bedrock (Claude)
 * to extract the compliance rules as structured JSON.
 *
 * The Lambda always reads the policy fresh each run so that uploading a new
 * PDF to S3 automatically updates behaviour on the next monthly run.
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-2' });
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'eu-west-2' });

const POLICY_BUCKET = process.env.POLICY_BUCKET;
const POLICY_KEY = process.env.POLICY_KEY || 'policy/mandatory-training-policy.pdf';
const BEDROCK_MODEL = process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-haiku-4-5-20251001';

/**
 * PolicyRules returned by parsePolicyPDF():
 * {
 *   newStarterGraceDays: 90,
 *   renewalMonths: 12,
 *   reminderDays: [60, 30],
 *   requiredCourses: ['Bribery Prevention', 'Data Protection', ...]
 * }
 */

// Fallback rules used when Bedrock is unavailable (access not yet enabled, etc.).
// These reflect policy/finova-mandatory-training-policy.md v1.0.
// Keep in sync with the policy document — these are used if AI parsing fails.
const FALLBACK_RULES = {
  newStarterGraceDays: 90,
  renewalMonths: 12,
  reminderDays: [60, 30],
  requiredCourses: [
    'Bribery Prevention',
    'Data Protection',
    'DSE (Display Screen Equipment)',
    'Fraud Prevention',
    'Information Security',
    'Responsible Use of Social Media',
  ],
};

export async function parsePolicyPDF() {
  console.log(`[policy] Reading policy from s3://${POLICY_BUCKET}/${POLICY_KEY}`);

  // Fetch policy file from S3 (supports PDF and plain text/markdown)
  const resp = await s3.send(new GetObjectCommand({ Bucket: POLICY_BUCKET, Key: POLICY_KEY }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  const fileBytes = Buffer.concat(chunks);
  console.log(`[policy] Policy file loaded (${fileBytes.length} bytes, key: ${POLICY_KEY})`);

  // Detect whether the file is plain text (markdown/txt) or binary (PDF).
  // Strategy: attempt UTF-8 decode; if it succeeds and contains readable text, treat as text.
  const ext = POLICY_KEY.split('.').pop().toLowerCase();
  const isText = ext === 'md' || ext === 'txt' || isLikelyText(fileBytes);
  const fileText = isText ? fileBytes.toString('utf8') : null;
  if (isText) console.log('[policy] Detected plain text/markdown — sending as text to Bedrock');

  const extractionPrompt = `You are reading a corporate mandatory training compliance policy document.
Extract the following information and return it as a JSON object with exactly these keys:
- "newStarterGraceDays": integer — the number of days new starters have to complete mandatory training after joining
- "renewalMonths": integer — how often employees must recertify (in months, e.g., 12 for annual)
- "reminderDays": array of integers — how many days before expiry reminder emails are sent (e.g., [60, 30])
- "requiredCourses": array of strings — the exact names of all mandatory courses listed in the policy

Return ONLY valid JSON, no prose, no markdown, no code fences. Example:
{"newStarterGraceDays":90,"renewalMonths":12,"reminderDays":[60,30],"requiredCourses":["Bribery Prevention","Data Protection"]}`;

  const messageContent = isText
    ? [{ text: `${fileText}\n\n---\n\n${extractionPrompt}` }]
    : [
        {
          document: {
            name: 'mandatory-training-policy',
            format: 'pdf',
            source: { bytes: fileBytes },
          },
        },
        { text: extractionPrompt },
      ];

  let rules;
  try {
    const result = await bedrock.send(new ConverseCommand({
      modelId: BEDROCK_MODEL,
      messages: [{ role: 'user', content: messageContent }],
      inferenceConfig: { maxTokens: 512, temperature: 0 },
    }));

    const raw = result.output?.message?.content?.find(b => b.text)?.text?.trim() || '';
    console.log('[policy] Bedrock response:', raw.slice(0, 400));

    try {
      rules = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`Could not parse Bedrock response: ${raw.slice(0, 200)}`);
      rules = JSON.parse(match[0]);
    }
  } catch (bedrockErr) {
    // Bedrock unavailable (model access not yet enabled, access denied, etc.)
    // Fall back to the hardcoded rules from policy v1.0 and continue the run.
    console.warn(`[policy] Bedrock unavailable (${bedrockErr.message.slice(0, 120)}) — using fallback rules from FALLBACK_RULES`);
    return FALLBACK_RULES;
  }

  // Validate required fields
  const { newStarterGraceDays, renewalMonths, reminderDays, requiredCourses } = rules;
  if (!Number.isInteger(newStarterGraceDays) || newStarterGraceDays < 1)
    throw new Error(`Invalid newStarterGraceDays: ${newStarterGraceDays}`);
  if (!Number.isInteger(renewalMonths) || renewalMonths < 1)
    throw new Error(`Invalid renewalMonths: ${renewalMonths}`);
  if (!Array.isArray(reminderDays) || reminderDays.length === 0)
    throw new Error(`Invalid reminderDays: ${JSON.stringify(reminderDays)}`);
  if (!Array.isArray(requiredCourses) || requiredCourses.length === 0)
    throw new Error(`requiredCourses list is empty`);

  console.log(`[policy] Rules extracted: grace=${newStarterGraceDays}d, renewal=${renewalMonths}mo, reminders=[${reminderDays.join(',')}]d, courses=${requiredCourses.length}`);
  return rules;
}

// Returns true if the buffer looks like UTF-8 text (not binary/PDF)
function isLikelyText(buf) {
  // PDFs start with %PDF
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return false;
  // Sample first 512 bytes — if they decode cleanly as UTF-8 text, treat as text
  try {
    const sample = buf.slice(0, 512).toString('utf8');
    return /^[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]*$/.test(sample);
  } catch {
    return false;
  }
}

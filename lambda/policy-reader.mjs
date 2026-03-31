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

export async function parsePolicyPDF() {
  console.log(`[policy] Reading policy from s3://${POLICY_BUCKET}/${POLICY_KEY}`);

  // Fetch PDF bytes from S3
  const resp = await s3.send(new GetObjectCommand({ Bucket: POLICY_BUCKET, Key: POLICY_KEY }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  const pdfBytes = Buffer.concat(chunks);
  console.log(`[policy] PDF loaded (${pdfBytes.length} bytes)`);

  // Ask Claude to extract the compliance rules
  const prompt = `You are reading a corporate mandatory training compliance policy document.
Extract the following information and return it as a JSON object with exactly these keys:
- "newStarterGraceDays": integer — the number of days new starters have to complete mandatory training after joining
- "renewalMonths": integer — how often employees must recertify (in months, e.g., 12 for annual)
- "reminderDays": array of integers — how many days before expiry reminder emails are sent (e.g., [60, 30])
- "requiredCourses": array of strings — the exact names of all mandatory courses listed in the policy

Return ONLY valid JSON, no prose, no markdown, no code fences. Example:
{"newStarterGraceDays":90,"renewalMonths":12,"reminderDays":[60,30],"requiredCourses":["Bribery Prevention","Data Protection"]}`;

  const result = await bedrock.send(new ConverseCommand({
    modelId: BEDROCK_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          {
            document: {
              name: 'mandatory-training-policy',
              format: 'pdf',
              source: { bytes: pdfBytes },
            },
          },
          { text: prompt },
        ],
      },
    ],
    inferenceConfig: { maxTokens: 512, temperature: 0 },
  }));

  const raw = result.output?.message?.content?.find(b => b.text)?.text?.trim() || '';
  console.log('[policy] Bedrock response:', raw.slice(0, 400));

  let rules;
  try {
    rules = JSON.parse(raw);
  } catch {
    // If Claude wrapped the JSON in markdown fences, strip them
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Could not parse policy rules from Bedrock response: ${raw.slice(0, 200)}`);
    rules = JSON.parse(match[0]);
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

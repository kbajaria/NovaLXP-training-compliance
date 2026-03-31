/**
 * NovaLXP Training Compliance — Lambda Handler
 *
 * Runs on the 1st of every month (EventBridge Scheduler, 09:00 Europe/London).
 *
 * Flow:
 *   1. Read + AI-parse the compliance policy PDF from S3 (Bedrock)
 *   2. Fetch active employees from BambooHR
 *   3. Fetch hire dates (TalentLMS S3 + Moodle proxy)
 *   4. Fetch historical TalentLMS completions (S3 snapshot)
 *   5. Fetch current NovaLXP completions (Moodle REST API)
 *   6. Build per-employee compliance status
 *   7. Load per-employee notification state from DynamoDB
 *   8. Send reminder emails via SES (new starter / upcoming / overdue)
 *   9. Update DynamoDB state
 *  10. Publish run summary to SNS
 *
 * Networking: Lambda runs outside VPC — all external endpoints (BambooHR,
 * Moodle, SES, S3, Bedrock, DynamoDB, Secrets Manager) are reachable directly.
 * This matches the established pattern across all NovaLXP Lambda functions.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

import { parsePolicyPDF } from './policy-reader.mjs';
import { reconcilePolicyCourses } from './course-map.mjs';
import {
  getActiveBambooHREmployees,
  getHireDates,
  getTalentLMSCompletions,
  getMoodleCompletions,
} from './data-fetcher.mjs';
import { buildComplianceRecords, STATUS } from './compliance-engine.mjs';
import { loadState, annotateWithSendDecision, recordEmailSent } from './state.mjs';
import { sendComplianceEmail } from './emailer.mjs';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-west-2' });
const sns = new SNSClient({ region: process.env.AWS_REGION || 'eu-west-2' });

const BAMBOOHR_SECRET = process.env.BAMBOOHR_SECRET_ID;
const MOODLE_SECRET   = process.env.MOODLE_SECRET_ID;
const SNS_TOPIC_ARN   = process.env.SNS_TOPIC_ARN;
const DRY_RUN         = process.env.DRY_RUN === 'true'; // set to true to skip actual email sends

export async function handler(event, context) {
  const asOf = event?.asOf ? new Date(event.asOf) : new Date();
  console.log(`[main] Compliance run starting — asOf: ${asOf.toISOString()}, dryRun: ${DRY_RUN}`);

  const runStats = {
    asOf: asOf.toISOString().slice(0, 10),
    dryRun: DRY_RUN,
    employees: 0,
    emailsSent: { NEW_STARTER: 0, DUE_60_DAYS: 0, DUE_30_DAYS: 0, OVERDUE: 0 },
    skipped: 0,
    errors: [],
    warnings: [],
  };

  try {
    // ── Step 1: Load secrets ────────────────────────────────────────────────
    console.log('[main] Loading secrets...');
    const [bambooSecrets, moodleSecrets] = await Promise.all([
      getSecret(BAMBOOHR_SECRET),
      getSecret(MOODLE_SECRET),
    ]);
    const bambooApiKey = bambooSecrets.BAMBOOHR_API_KEY;
    const moodleToken  = moodleSecrets.MOODLE_TOKEN;

    // ── Step 2: Parse policy PDF ────────────────────────────────────────────
    const policyRules = await parsePolicyPDF();
    const { mappedCourses, warnings: mapWarnings } = reconcilePolicyCourses(policyRules.requiredCourses);
    runStats.warnings.push(...mapWarnings);
    mapWarnings.forEach(w => console.warn('[main]', w));

    if (mappedCourses.length === 0) {
      throw new Error('No mappable courses found in policy document — aborting.');
    }
    console.log(`[main] Checking ${mappedCourses.length} required courses: ${mappedCourses.join(', ')}`);

    // ── Steps 3–6: Fetch all data concurrently ──────────────────────────────
    console.log('[main] Fetching employee data and completions...');
    const [
      activeEmployees,
      hireDates,
      tlmsCompletions,
      moodleData,
    ] = await Promise.all([
      getActiveBambooHREmployees(bambooApiKey),
      getHireDates(moodleToken),
      getTalentLMSCompletions(mappedCourses, policyRules.renewalMonths, asOf),
      getMoodleCompletions(mappedCourses, policyRules.renewalMonths, asOf, moodleToken),
    ]);

    runStats.employees = activeEmployees.length;

    // ── Step 7: Build compliance records ────────────────────────────────────
    const records = buildComplianceRecords(
      activeEmployees,
      hireDates,
      tlmsCompletions,
      moodleData,
      mappedCourses,
      policyRules,
      asOf
    );

    // ── Step 8: Load DynamoDB state ─────────────────────────────────────────
    const emails = records.map(r => r.email);
    const stateByEmail = await loadState(emails);
    const annotated = annotateWithSendDecision(records, stateByEmail, asOf);

    // ── Step 9: Send emails and update state ────────────────────────────────
    const toSend = annotated.filter(r => r.shouldSendEmail);
    console.log(`[main] ${toSend.length} employees need emails (of ${annotated.length} total)`);

    for (const rec of toSend) {
      try {
        if (!DRY_RUN) {
          await sendComplianceEmail(rec);
          await recordEmailSent(rec);
        } else {
          console.log(`[dry-run] Would send ${rec.emailType} to ${rec.email} (${rec.name})`);
        }
        runStats.emailsSent[rec.emailType] = (runStats.emailsSent[rec.emailType] || 0) + 1;
      } catch (e) {
        const msg = `Failed to send ${rec.emailType} to ${rec.email}: ${e.message}`;
        console.error('[main]', msg);
        runStats.errors.push(msg);
      }
    }

    runStats.skipped = annotated.filter(r => !r.shouldSendEmail && r.overallStatus !== STATUS.COMPLIANT).length;

    // ── Step 10: Summary ────────────────────────────────────────────────────
    const statusCounts = Object.values(STATUS).reduce((acc, s) => ({ ...acc, [s]: 0 }), {});
    for (const r of records) statusCounts[r.overallStatus]++;

    console.log('[main] Run complete:', JSON.stringify({ ...runStats, statusCounts }));

    await publishSummary(runStats, statusCounts);
    return { statusCode: 200, body: JSON.stringify(runStats) };

  } catch (err) {
    const msg = `Compliance run failed: ${err.message}`;
    console.error('[main] FATAL:', err);
    runStats.errors.push(msg);
    await publishSummary(runStats, {}, true);
    throw err; // let Lambda mark as failed
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getSecret(id) {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: id }));
  return JSON.parse(r.SecretString);
}

async function publishSummary(stats, statusCounts = {}, failed = false) {
  if (!SNS_TOPIC_ARN) return;

  const totalEmails = Object.values(stats.emailsSent).reduce((n, c) => n + c, 0);
  const status = failed ? 'FAILED' : (stats.errors.length > 0 ? 'COMPLETED WITH ERRORS' : 'SUCCESS');

  const lines = [
    `Compliance Run — ${stats.asOf} [${status}]${stats.dryRun ? ' [DRY RUN]' : ''}`,
    '',
    `Employees assessed: ${stats.employees}`,
    `Emails sent: ${totalEmails}`,
    `  • New starter notices:  ${stats.emailsSent.NEW_STARTER || 0}`,
    `  • 60-day reminders:     ${stats.emailsSent.DUE_60_DAYS || 0}`,
    `  • 30-day reminders:     ${stats.emailsSent.DUE_30_DAYS || 0}`,
    `  • Overdue notices:      ${stats.emailsSent.OVERDUE || 0}`,
    `  • Skipped (already notified): ${stats.skipped}`,
    '',
    'Compliance status:',
    `  • Fully compliant:  ${statusCounts.COMPLIANT || 0}`,
    `  • New starters:     ${statusCounts.NEW_STARTER || 0}`,
    `  • Due in 60 days:   ${statusCounts.DUE_60_DAYS || 0}`,
    `  • Due in 30 days:   ${statusCounts.DUE_30_DAYS || 0}`,
    `  • Overdue:          ${statusCounts.OVERDUE || 0}`,
  ];

  if (stats.warnings.length > 0) {
    lines.push('', 'Warnings:', ...stats.warnings.map(w => `  ! ${w}`));
  }
  if (stats.errors.length > 0) {
    lines.push('', 'Errors:', ...stats.errors.map(e => `  ✗ ${e}`));
  }

  await sns.send(new PublishCommand({
    TopicArn: SNS_TOPIC_ARN,
    Subject: `[NovaLXP Compliance] ${stats.asOf} — ${status}`,
    Message: lines.join('\n'),
  }));
}

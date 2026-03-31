/**
 * state.mjs
 *
 * DynamoDB state tracking for compliance reminder emails.
 *
 * Prevents the same reminder from being sent multiple times for the same
 * compliance cycle. State is keyed by employee email. Each item stores
 * which reminder types have been sent, and for which due-date cycle, so
 * that when an employee renews their training the counters reset.
 *
 * Table schema (single-table, PK only):
 *   pk (S) — employee email (lowercase)
 *   newStarterSent (BOOL) — whether the new-starter onboarding email was sent
 *   due60SentForCycle (S) — YYYY-MM of due date when 60-day reminder was sent
 *   due30SentForCycle (S) — YYYY-MM of due date when 30-day reminder was sent
 *   overdueLastSentMonth (S) — YYYY-MM when the overdue reminder was last sent
 *   updatedAt (S) — ISO timestamp of last write
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'eu-west-2' }));
const TABLE = process.env.STATE_TABLE;

/**
 * Batch-load state records for a list of employee emails.
 * Returns: Map<email, stateRecord>
 */
export async function loadState(emails) {
  if (!emails.length) return {};
  const result = {};

  // DynamoDB BatchGet handles up to 100 keys per request
  const chunks = chunkArray(emails, 100);
  for (const chunk of chunks) {
    const keys = chunk.map(email => ({ pk: email }));
    const resp = await ddb.send(new BatchGetCommand({
      RequestItems: { [TABLE]: { Keys: keys } },
    }));
    for (const item of (resp.Responses?.[TABLE] || [])) {
      result[item.pk] = item;
    }
  }

  return result;
}

/**
 * Determine whether each compliance record needs an email sent,
 * based on current state and today's month.
 *
 * @param {Array} records — compliance records from compliance-engine
 * @param {Object} stateByEmail — Map<email, stateRecord> from loadState()
 * @param {Date} asOf — reference date (today)
 * @returns {Array} records with `shouldSendEmail` and `emailType` added
 */
export function annotateWithSendDecision(records, stateByEmail, asOf) {
  const currentMonth = asOf.toISOString().slice(0, 7); // YYYY-MM

  return records.map(rec => {
    const state = stateByEmail[rec.email] || {};
    const { overallStatus, primaryDueDate, primaryOverdueDate } = rec;

    // The "cycle key" for renewal reminders is the YYYY-MM of the due date.
    // This resets naturally when an employee renews and gets a new due date.
    const dueCycle = primaryDueDate ? primaryDueDate.toISOString().slice(0, 7) : null;

    let shouldSendEmail = false;
    let emailType = null;

    switch (overallStatus) {
      case 'NEW_STARTER':
        if (!state.newStarterSent) {
          shouldSendEmail = true;
          emailType = 'NEW_STARTER';
        }
        break;

      case 'DUE_60_DAYS':
        if (state.due60SentForCycle !== dueCycle) {
          shouldSendEmail = true;
          emailType = 'DUE_60_DAYS';
        }
        break;

      case 'DUE_30_DAYS':
        if (state.due30SentForCycle !== dueCycle) {
          shouldSendEmail = true;
          emailType = 'DUE_30_DAYS';
        }
        break;

      case 'OVERDUE':
        // Resend overdue notice every month
        if (state.overdueLastSentMonth !== currentMonth) {
          shouldSendEmail = true;
          emailType = 'OVERDUE';
        }
        break;

      case 'COMPLIANT':
        // No email needed
        break;
    }

    return { ...rec, shouldSendEmail, emailType, _dueCycle: dueCycle, _currentMonth: currentMonth };
  });
}

/**
 * Persist updated state after emails are sent.
 * Call once per employee after a successful SES send.
 */
export async function recordEmailSent(rec) {
  const { email, emailType, _dueCycle, _currentMonth } = rec;
  const existing = {}; // we don't need to re-read; just merge what we know

  const updates = {
    pk: email,
    updatedAt: new Date().toISOString(),
  };

  switch (emailType) {
    case 'NEW_STARTER':
      updates.newStarterSent = true;
      break;
    case 'DUE_60_DAYS':
      updates.due60SentForCycle = _dueCycle;
      break;
    case 'DUE_30_DAYS':
      updates.due30SentForCycle = _dueCycle;
      break;
    case 'OVERDUE':
      updates.overdueLastSentMonth = _currentMonth;
      break;
  }

  await ddb.send(new PutCommand({ TableName: TABLE, Item: updates }));
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

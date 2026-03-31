/**
 * compliance-engine.mjs
 *
 * Determines each employee's compliance status and, for those with outstanding
 * or upcoming training, computes the exact due date.
 *
 * Status values (per employee):
 *   COMPLIANT       — all required courses completed and not due for renewal soon
 *   DUE_60_DAYS     — all current, but at least one course due for renewal in 31–60 days
 *   DUE_30_DAYS     — all current, but at least one course due for renewal in 0–30 days
 *   OVERDUE         — one or more courses expired or never completed (past grace period)
 *   NEW_STARTER     — within the new-starter grace period; training not yet required
 *
 * The employee's overall status is the most severe across all required courses.
 */

import { COURSE_MAP } from './course-map.mjs';

export const STATUS = {
  COMPLIANT: 'COMPLIANT',
  DUE_60: 'DUE_60_DAYS',
  DUE_30: 'DUE_30_DAYS',
  OVERDUE: 'OVERDUE',
  NEW_STARTER: 'NEW_STARTER',
};

const STATUS_SEVERITY = {
  [STATUS.COMPLIANT]: 0,
  [STATUS.DUE_60]: 1,
  [STATUS.DUE_30]: 2,
  [STATUS.OVERDUE]: 3,
  [STATUS.NEW_STARTER]: -1, // lower than COMPLIANT — new starters are exempt
};

/**
 * @param {Array} activeEmployees         — from BambooHR
 * @param {Object} hireDates              — email → YYYY-MM-DD
 * @param {Object} tlmsCompletions        — email → { courseKey → YYYY-MM-DD }
 * @param {Object} moodleCompletionData   — { completions: {...}, emailToMoodleId: {...} }
 * @param {string[]} requiredCourses      — course keys to check (from policy + map reconciliation)
 * @param {Object} policyRules            — { newStarterGraceDays, renewalMonths, reminderDays }
 * @param {Date} asOf                     — reference date (today)
 *
 * @returns {Array<EmployeeRecord>}
 */
export function buildComplianceRecords(
  activeEmployees,
  hireDates,
  tlmsCompletions,
  moodleCompletionData,
  requiredCourses,
  policyRules,
  asOf
) {
  const { newStarterGraceDays, renewalMonths, reminderDays } = policyRules;
  const { completions: moodleCompletions, emailToMoodleId } = moodleCompletionData;

  const sorted = [...reminderDays].sort((a, b) => b - a); // [60, 30] desc
  const maxReminderDays = sorted[0]; // 60

  const records = [];

  for (const emp of activeEmployees) {
    const email = emp.email;
    const hireDate = hireDates[email] || null;

    // Determine if employee is in new-starter grace period
    const graceEndDate = hireDate ? addDays(hireDate, newStarterGraceDays) : null;
    const inGrace = graceEndDate && graceEndDate > asOf;

    // Per-course compliance detail
    const courses = {};
    let overallStatus = STATUS.COMPLIANT;

    for (const courseKey of requiredCourses) {
      const tlmsDate = tlmsCompletions[email]?.[courseKey] || null;
      const moodleDate = moodleCompletions[email]?.[courseKey] || null;
      // Most recent completion wins
      const lastCompletion = [tlmsDate, moodleDate].filter(Boolean).sort().pop() || null;

      let courseStatus;
      let dueDate = null;
      let overdueDate = null;

      if (inGrace) {
        // New starter: not yet required; due by grace-end date
        courseStatus = STATUS.NEW_STARTER;
        dueDate = graceEndDate;
      } else if (!lastCompletion) {
        // No completion ever (or not within any meaningful window) — overdue
        courseStatus = STATUS.OVERDUE;
        // Due "immediately" — use grace-end as the date they should have completed by,
        // or if no hire date, fall back to asOf
        overdueDate = graceEndDate || asOf;
      } else {
        // Compute renewal due date
        const renewalDue = addMonths(lastCompletion, renewalMonths);
        const daysUntilDue = diffDays(asOf, renewalDue);

        if (daysUntilDue < 0) {
          courseStatus = STATUS.OVERDUE;
          overdueDate = renewalDue;
        } else if (daysUntilDue <= sorted[sorted.length - 1]) {
          // Within tightest reminder window (e.g., 30 days)
          courseStatus = STATUS.DUE_30;
          dueDate = renewalDue;
        } else if (daysUntilDue <= maxReminderDays) {
          // Within outer reminder window (e.g., 60 days)
          courseStatus = STATUS.DUE_60;
          dueDate = renewalDue;
        } else {
          courseStatus = STATUS.COMPLIANT;
        }
      }

      courses[courseKey] = {
        status: courseStatus,
        lastCompletion,
        dueDate,       // Date object — when training is/was due (null if COMPLIANT)
        overdueDate,   // Date object — when they became overdue (null if not OVERDUE)
        source: moodleDate && (!tlmsDate || moodleDate >= tlmsDate) ? 'NovaLXP' : (tlmsDate ? 'TalentLMS' : null),
      };

      // Escalate overall status
      if (STATUS_SEVERITY[courseStatus] > STATUS_SEVERITY[overallStatus]) {
        overallStatus = courseStatus;
      }
    }

    // For new starters who completed everything: mark compliant not new_starter
    if (overallStatus === STATUS.NEW_STARTER) {
      const allDone = requiredCourses.every(k => courses[k]?.lastCompletion);
      if (allDone) overallStatus = STATUS.COMPLIANT;
    }

    // Find the earliest dueDate / overdueDate across all outstanding courses
    const allDueDates = requiredCourses
      .map(k => courses[k]?.dueDate)
      .filter(Boolean);
    const allOverdueDates = requiredCourses
      .map(k => courses[k]?.overdueDate)
      .filter(Boolean);

    // The "action date" shown in the email: earliest due date (or overdue date)
    const primaryDueDate = allDueDates.length > 0
      ? new Date(Math.min(...allDueDates.map(d => d.getTime())))
      : null;
    const primaryOverdueDate = allOverdueDates.length > 0
      ? new Date(Math.min(...allOverdueDates.map(d => d.getTime())))
      : null;

    // Courses outstanding for each actionable status
    const outstandingCourses = requiredCourses.filter(k =>
      [STATUS.OVERDUE, STATUS.DUE_30, STATUS.DUE_60, STATUS.NEW_STARTER].includes(courses[k]?.status) &&
      !courses[k]?.lastCompletion
    );
    const upcomingCourses = requiredCourses.filter(k =>
      [STATUS.DUE_30, STATUS.DUE_60].includes(courses[k]?.status)
    );

    records.push({
      ...emp,
      hireDate,
      inGrace,
      graceEndDate,
      inMoodle: !!emailToMoodleId[email],
      overallStatus,
      courses,
      primaryDueDate,     // earliest "must complete by" date
      primaryOverdueDate, // earliest date they went out of compliance
      outstandingCourses, // course keys not yet completed at all
      upcomingCourses,    // course keys due for renewal soon
    });
  }

  // Summary
  const counts = Object.values(STATUS).reduce((acc, s) => ({ ...acc, [s]: 0 }), {});
  for (const r of records) counts[r.overallStatus]++;
  console.log('[engine] Compliance summary:', JSON.stringify(counts));

  return records;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function diffDays(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

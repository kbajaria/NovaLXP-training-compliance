/**
 * emailer.mjs
 *
 * Builds and sends compliance reminder emails via Amazon SES.
 *
 * Three email types:
 *   NEW_STARTER    — Welcome to Finova; you must complete training by <date>
 *   DUE_60_DAYS    — Your annual compliance training renewal is due in ~60 days
 *   DUE_30_DAYS    — Reminder: renewal due in ~30 days
 *   OVERDUE        — You are currently out of compliance; complete training immediately
 *
 * Emails are sent to the employee's work email. The FROM address must be a
 * verified SES identity in the finova.tech domain (or the sending domain must
 * have SES DKIM verification configured).
 */

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const ses = new SESClient({ region: process.env.AWS_REGION || 'eu-west-2' });

const FROM_EMAIL = process.env.SES_FROM_EMAIL || 'learning@finova.tech';
const NOVALXP_URL = process.env.MOODLE_BASE_URL || 'https://learn.novalxp.co.uk';

/**
 * Send a compliance reminder email for a single employee record.
 * @param {Object} rec — annotated compliance record (with emailType set)
 */
export async function sendComplianceEmail(rec) {
  const { emailType, email, name } = rec;

  const { subject, bodyHtml, bodyText } = buildEmail(rec);

  await ses.send(new SendEmailCommand({
    Source: `Finova Learning <${FROM_EMAIL}>`,
    Destination: { ToAddresses: [email] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: bodyHtml, Charset: 'UTF-8' },
        Text: { Data: bodyText, Charset: 'UTF-8' },
      },
    },
  }));

  console.log(`[email] Sent ${emailType} to ${email} (${name})`);
}

// ─── Email builders ───────────────────────────────────────────────────────────

function buildEmail(rec) {
  switch (rec.emailType) {
    case 'NEW_STARTER':    return newStarterEmail(rec);
    case 'DUE_60_DAYS':   return renewalReminderEmail(rec, 60);
    case 'DUE_30_DAYS':   return renewalReminderEmail(rec, 30);
    case 'OVERDUE':       return overdueEmail(rec);
    default: throw new Error(`Unknown emailType: ${rec.emailType}`);
  }
}

function newStarterEmail(rec) {
  const { name, graceEndDate, outstandingCourses } = rec;
  const firstName = name.split(' ')[0];
  const deadline = fmtDate(graceEndDate);
  const courseList = outstandingCourses.length > 0
    ? outstandingCourses
    : Object.keys(rec.courses); // all courses listed for new starters

  const subject = `Welcome to Finova — please complete your mandatory training by ${deadline}`;

  const bodyText = `
Dear ${firstName},

Welcome to Finova!

As part of your onboarding, you are required to complete the following mandatory compliance
training courses by ${deadline}:

${courseList.map(c => `  • ${c}`).join('\n')}

Please log in to NovaLXP — Finova's learning platform — to complete these courses:
${NOVALXP_URL}

Completing this training by the deadline is a condition of your employment at Finova and
is required under our Mandatory Training & Compliance Policy.

If you have any questions, please contact the HR team or your line manager.

Best regards,
Finova Learning & Development
`.trim();

  const bodyHtml = htmlWrapper(firstName, subject, `
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Welcome to Finova! As part of your onboarding, you are required to complete the following
      mandatory compliance training courses by <strong>${deadline}</strong>.
    </p>
    ${courseListHtml(courseList)}
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Please log in to <a href="${NOVALXP_URL}" style="color:#1a5276;">NovaLXP</a> — Finova's
      learning platform — to complete these courses. Completing this training by the deadline is
      a condition of your employment at Finova and is required under our
      <strong>Mandatory Training &amp; Compliance Policy</strong>.
    </p>
    ${ctaButton('Go to NovaLXP', NOVALXP_URL)}
    <p style="color:#888;font-size:12px;">
      If you have any questions, please contact the HR team or your line manager.
    </p>
  `);

  return { subject, bodyText, bodyHtml };
}

function renewalReminderEmail(rec, days) {
  const { name, primaryDueDate, upcomingCourses, courses } = rec;
  const firstName = name.split(' ')[0];
  const deadline = fmtDate(primaryDueDate);
  const urgency = days <= 30 ? 'REMINDER: ' : '';

  const subject = `${urgency}Your mandatory compliance training renewal is due by ${deadline}`;

  // Build a list of courses with their individual due dates
  const dueCourses = upcomingCourses.length > 0 ? upcomingCourses : Object.keys(courses);

  const bodyText = `
Dear ${firstName},

${days <= 30 ? 'IMPORTANT REMINDER: ' : ''}Your annual mandatory compliance training is due for renewal.

Please complete the following course(s) by ${deadline}:

${dueCourses.map(c => `  • ${c}  (due: ${fmtDate(courses[c]?.dueDate) || deadline})`).join('\n')}

Log in to NovaLXP to complete your training:
${NOVALXP_URL}

Staying up to date with compliance training is a requirement under Finova's Mandatory
Training & Compliance Policy. Employees who do not renew by the due date will be recorded
as non-compliant.

Best regards,
Finova Learning & Development
`.trim();

  const intro = days <= 30
    ? `This is an <strong>important reminder</strong> that your annual mandatory compliance training renewal is due by <strong>${deadline}</strong>.`
    : `Your annual mandatory compliance training is due for renewal by <strong>${deadline}</strong>.`;

  const bodyHtml = htmlWrapper(firstName, subject, `
    <p style="color:#555;font-size:14px;line-height:1.6;">${intro}</p>
    ${courseListWithDatesHtml(dueCourses, courses, deadline)}
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Please log in to <a href="${NOVALXP_URL}" style="color:#1a5276;">NovaLXP</a> to complete
      your training. Staying current with compliance training is a requirement under Finova's
      <strong>Mandatory Training &amp; Compliance Policy</strong>.
    </p>
    ${ctaButton('Renew Training Now', NOVALXP_URL)}
    <p style="color:#888;font-size:12px;">
      If you believe your training record is incorrect, please contact
      <a href="mailto:learning@finova.tech" style="color:#888;">learning@finova.tech</a>.
    </p>
  `);

  return { subject, bodyText, bodyHtml };
}

function overdueEmail(rec) {
  const { name, outstandingCourses, courses } = rec;
  const firstName = name.split(' ')[0];

  // For overdue courses, find earliest overdue date
  const overdueDates = outstandingCourses
    .map(k => courses[k]?.overdueDate)
    .filter(Boolean)
    .sort();
  const overdueDate = overdueDates.length > 0 ? fmtDate(overdueDates[0]) : 'the required date';

  const subject = 'ACTION REQUIRED: Your mandatory compliance training is overdue';

  const bodyText = `
Dear ${firstName},

IMPORTANT: Your mandatory compliance training is currently overdue.

The following course(s) require immediate completion:

${outstandingCourses.map(c => `  • ${c}`).join('\n')}

You were required to complete this training by ${overdueDate}. Non-compliance with Finova's
Mandatory Training & Compliance Policy may result in formal performance management action.

Please complete your outstanding training in NovaLXP immediately:
${NOVALXP_URL}

Once completed, your compliance status will be updated automatically.

If you need assistance, please contact your line manager or HR immediately.

Finova Learning & Development
`.trim();

  const bodyHtml = htmlWrapper(firstName, subject, `
    <div style="background:#fff0f0;border-left:4px solid #c0392b;padding:16px;margin-bottom:20px;border-radius:4px;">
      <p style="color:#c0392b;font-weight:700;margin:0;font-size:15px;">
        ACTION REQUIRED: Your mandatory compliance training is overdue.
      </p>
    </div>
    <p style="color:#555;font-size:14px;line-height:1.6;">
      You were required to complete this training by <strong>${overdueDate}</strong>.
      Non-compliance with Finova's <strong>Mandatory Training &amp; Compliance Policy</strong>
      may result in formal performance management action.
    </p>
    ${courseListHtml(outstandingCourses)}
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Please complete your outstanding training in NovaLXP <strong>immediately</strong>.
    </p>
    ${ctaButton('Complete Training Now', NOVALXP_URL, '#c0392b')}
    <p style="color:#888;font-size:12px;">
      If you need assistance, please contact your line manager or
      <a href="mailto:hr@finova.tech" style="color:#888;">HR</a> immediately.
    </p>
  `, true);

  return { subject, bodyText, bodyHtml };
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function htmlWrapper(firstName, subject, content, urgent = false) {
  const headerBg = urgent ? '#7b241c' : '#0f2d5e';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:30px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <!-- Header -->
      <tr>
        <td style="background:${headerBg};padding:28px 36px;">
          <p style="margin:0;color:rgba(255,255,255,0.7);font-size:11px;letter-spacing:2px;text-transform:uppercase;">Finova Learning &amp; Development</p>
          <p style="margin:8px 0 0;color:#ffffff;font-size:22px;font-weight:700;line-height:1.3;">${esc(subject)}</p>
        </td>
      </tr>
      <!-- Body -->
      <tr>
        <td style="padding:32px 36px;">
          <p style="margin:0 0 20px;color:#333;font-size:15px;">Dear ${esc(firstName)},</p>
          ${content}
        </td>
      </tr>
      <!-- Footer -->
      <tr>
        <td style="background:#f8f9fa;padding:20px 36px;border-top:1px solid #eee;">
          <p style="margin:0;color:#999;font-size:11px;line-height:1.6;">
            This is an automated message from the Finova compliance monitoring system.
            Please do not reply to this email. For assistance, contact
            <a href="mailto:learning@finova.tech" style="color:#999;">learning@finova.tech</a>.
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function courseListHtml(courses) {
  return `<table style="width:100%;margin:16px 0;border-collapse:collapse;">
    ${courses.map(c => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;color:#333;">
          <span style="color:#c0392b;margin-right:8px;">&#9679;</span>${esc(c)}
        </td>
      </tr>`).join('')}
  </table>`;
}

function courseListWithDatesHtml(courses, coursesMap, fallbackDate) {
  return `<table style="width:100%;margin:16px 0;border-collapse:collapse;">
    <tr style="background:#f8f9fa;">
      <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;border-bottom:2px solid #dee2e6;">Course</th>
      <th style="padding:8px 12px;text-align:right;font-size:12px;color:#666;border-bottom:2px solid #dee2e6;">Due by</th>
    </tr>
    ${courses.map(c => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;color:#333;">${esc(c)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;color:#c0392b;text-align:right;font-weight:700;white-space:nowrap;">
          ${fmtDate(coursesMap[c]?.dueDate) || fallbackDate}
        </td>
      </tr>`).join('')}
  </table>`;
}

function ctaButton(label, href, bg = '#1a5276') {
  return `<div style="text-align:center;margin:24px 0;">
    <a href="${href}" style="display:inline-block;background:${bg};color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:700;">${label}</a>
  </div>`;
}

function fmtDate(date) {
  if (!date) return null;
  return new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London',
  });
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

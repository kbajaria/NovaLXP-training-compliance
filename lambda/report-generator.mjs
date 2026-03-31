/**
 * report-generator.mjs
 *
 * Generates an HTML compliance report and saves it to S3.
 * Returns the S3 key of the saved report.
 *
 * The report is always generated on every run, regardless of DRY_RUN mode.
 * It mirrors the structure of the ad-hoc check-compliance.mjs report, adapted
 * for the Lambda context (no PDF rendering, HTML saved to S3).
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-2' });
const REPORT_BUCKET = process.env.REPORT_BUCKET;

const TOPIC_SHORT = {
  'Bribery Prevention': 'Bribery',
  'Data Protection': 'Data Prot.',
  'DSE (Display Screen Equipment)': 'DSE',
  'Fraud Prevention': 'Fraud Prev.',
  'Information Security': 'Info Sec.',
  'Responsible Use of Social Media': 'Social Media',
};

const STATUS_ORDER = {
  OVERDUE: 0,
  DUE_30_DAYS: 1,
  DUE_60_DAYS: 2,
  NEW_STARTER: 3,
  COMPLIANT: 4,
};

/**
 * Generate and save the compliance report.
 *
 * @param {Array} records — compliance records from compliance-engine
 * @param {string[]} requiredCourses — course keys that were checked
 * @param {Object} policyRules — { newStarterGraceDays, renewalMonths, reminderDays }
 * @param {Date} asOf — report date
 * @returns {{ s3Key: string, presignedUrl: string }} — S3 key and 7-day presigned URL
 */
export async function generateAndSaveReport(records, requiredCourses, policyRules, asOf) {
  const html = buildHTML(records, requiredCourses, policyRules, asOf);
  const isoDate = asOf.toISOString().slice(0, 10);
  const s3Key = `reports/compliance-${isoDate}.html`;

  await s3.send(new PutObjectCommand({
    Bucket: REPORT_BUCKET,
    Key: s3Key,
    Body: Buffer.from(html, 'utf8'),
    ContentType: 'text/html; charset=utf-8',
    Metadata: { 'report-date': isoDate, 'employee-count': String(records.length) },
  }));

  console.log(`[report] Saved to s3://${REPORT_BUCKET}/${s3Key}`);

  // Generate a 7-day presigned URL for direct browser access
  const presignedUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: REPORT_BUCKET, Key: s3Key }),
    { expiresIn: 7 * 24 * 3600 }
  );

  return { s3Key, presignedUrl };
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildHTML(records, requiredCourses, policyRules, asOf) {
  const dateStr = asOf.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const isoStr = asOf.toISOString().slice(0, 10);

  const lookbackDate = new Date(asOf);
  lookbackDate.setMonth(lookbackDate.getMonth() - policyRules.renewalMonths);
  const lookbackStr = lookbackDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  // Status helpers
  const statusLabel = r => ({
    COMPLIANT: 'Compliant',
    DUE_60_DAYS: 'Due in 60 days',
    DUE_30_DAYS: 'Due in 30 days',
    OVERDUE: 'Non-compliant',
    NEW_STARTER: 'New starter',
  })[r.overallStatus] || r.overallStatus;

  const statusPill = r => ({
    COMPLIANT: `<span class="pill pill-green">Compliant</span>`,
    DUE_60_DAYS: `<span class="pill pill-amber">Due ~60 days</span>`,
    DUE_30_DAYS: `<span class="pill pill-orange">Due ~30 days</span>`,
    OVERDUE: `<span class="pill pill-red">Non-compliant</span>`,
    NEW_STARTER: `<span class="pill pill-blue">New starter</span>`,
  })[r.overallStatus] || `<span class="pill">${r.overallStatus}</span>`;

  // Summary counts
  const counts = { COMPLIANT: 0, DUE_60_DAYS: 0, DUE_30_DAYS: 0, OVERDUE: 0, NEW_STARTER: 0 };
  for (const r of records) counts[r.overallStatus] = (counts[r.overallStatus] || 0) + 1;
  const assessed = records.length - counts.NEW_STARTER;
  const compliancePct = assessed > 0 ? Math.round((counts.COMPLIANT / assessed) * 100) : 0;

  // Gap counts per course (among non-new-starters)
  const gaps = {};
  for (const c of requiredCourses) {
    gaps[c] = records.filter(r => r.overallStatus !== 'NEW_STARTER' && !r.courses[c]?.lastCompletion).length;
  }

  // Sort rows: overdue first, then by due date, then compliant; within group by location then name
  const sorted = [...records].sort((a, b) =>
    (STATUS_ORDER[a.overallStatus] ?? 99) - (STATUS_ORDER[b.overallStatus] ?? 99) ||
    (a.location || '').localeCompare(b.location || '') ||
    a.name.localeCompare(b.name)
  );

  // Build table rows with location sub-headers
  const NCOLS = 5 + requiredCourses.length; // Name, Email, Dept, Location, Job, Status, courses
  const rows = [];
  let lastGroupKey = null;

  for (const emp of sorted) {
    const groupKey = `${emp.overallStatus}||${emp.location || ''}`;
    if (groupKey !== lastGroupKey) {
      const locLabel = emp.location || 'Unknown location';
      const bgColors = { OVERDUE: '#fff0f0', DUE_30_DAYS: '#fff8e6', DUE_60_DAYS: '#fffde7', NEW_STARTER: '#eef4ff', COMPLIANT: '#f0fff4' };
      const fgColors = { OVERDUE: '#7b241c', DUE_30_DAYS: '#7d5a00', DUE_60_DAYS: '#5d4e00', NEW_STARTER: '#1a5276', COMPLIANT: '#1e8449' };
      const bg = bgColors[emp.overallStatus] || '#f8f9fa';
      const fg = fgColors[emp.overallStatus] || '#333';
      rows.push(`<tr class="group-header" style="background:${bg}">
        <td colspan="${NCOLS}" style="padding:5px 8px;font-size:10px;font-weight:700;color:${fg};letter-spacing:0.3px">
          ${esc(statusLabel(emp))} — ${esc(locLabel)}
        </td>
      </tr>`);
      lastGroupKey = groupKey;
    }

    const courseCells = requiredCourses.map(c => {
      const cd = emp.courses[c];
      if (!cd) return `<td class="cell-na">n/a</td>`;
      if (cd.status === 'NEW_STARTER' && !cd.lastCompletion) {
        const due = cd.dueDate ? fmtDate(cd.dueDate) : '—';
        return `<td class="cell-grace" title="Grace period — due by ${due}">–</td>`;
      }
      if (cd.lastCompletion) {
        const d = fmtDateShort(new Date(cd.lastCompletion));
        const src = cd.source === 'NovaLXP' ? ' ●' : '';
        const cls = ['DUE_30_DAYS', 'DUE_60_DAYS'].includes(cd.status) ? 'cell-warn' : 'cell-ok';
        const dueTip = cd.dueDate ? ` | due: ${fmtDate(cd.dueDate)}` : '';
        return `<td class="${cls}" title="${cd.source}${dueTip}">${d}${src}</td>`;
      }
      return `<td class="cell-fail" title="Not completed — overdue">✗</td>`;
    }).join('');

    const rowCls = { OVERDUE: 'row-fail', DUE_30_DAYS: 'row-warn30', DUE_60_DAYS: 'row-warn60', NEW_STARTER: 'row-new', COMPLIANT: '' }[emp.overallStatus] || '';
    rows.push(`<tr class="${rowCls}">
      <td class="col-name">${esc(emp.name)}</td>
      <td class="col-email">${esc(emp.email)}</td>
      <td class="col-dept">${esc(emp.department)}</td>
      <td class="col-loc">${esc(emp.location)}</td>
      <td class="col-title">${esc(emp.jobTitle)}</td>
      <td style="padding:5px 6px">${statusPill(emp)}</td>
      ${courseCells}
    </tr>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Finova Compliance Report — ${isoStr}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11px; color: #1a1a2e; background: #fff; }
.cover { min-height: 220px; display: flex; flex-direction: column; justify-content: center; padding: 48px 64px;
  background: linear-gradient(135deg, #0f2d5e 0%, #1a4a8a 60%, #2d6abf 100%); color: white; }
.cover-label { font-size: 11px; text-transform: uppercase; letter-spacing: 3px; color: rgba(255,255,255,.6); margin-bottom: 12px; }
.cover-title { font-size: 36px; font-weight: 700; line-height: 1.15; margin-bottom: 8px; }
.cover-sub { font-size: 16px; color: rgba(255,255,255,.85); margin-bottom: 28px; }
.cover-divider { width: 50px; height: 3px; background: rgba(255,255,255,.4); margin: 24px 0; }
.cover-meta { font-size: 12px; color: rgba(255,255,255,.75); line-height: 2; }
.cover-meta strong { color: white; }
.section { padding: 36px 56px; }
.section-title { font-size: 16px; font-weight: 700; color: #0f2d5e; margin-bottom: 16px; padding-bottom: 7px; border-bottom: 2px solid #e0e8f7; }
.cards { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 28px; }
.card { flex: 1; min-width: 120px; background: #f4f7fd; border-radius: 10px; padding: 16px 18px; border-left: 4px solid #2d6abf; }
.card-value { font-size: 28px; font-weight: 800; color: #0f2d5e; }
.card-label { font-size: 10px; color: #666; margin-top: 4px; text-transform: uppercase; letter-spacing: .5px; }
.card.green { border-left-color: #27ae60; } .card.green .card-value { color: #1e8449; }
.card.red { border-left-color: #e74c3c; } .card.red .card-value { color: #c0392b; }
.card.amber { border-left-color: #f39c12; } .card.amber .card-value { color: #d68910; }
.card.blue { border-left-color: #2471a3; } .card.blue .card-value { color: #1a5276; }
.gap-table { width: 100%; border-collapse: collapse; margin-bottom: 28px; font-size: 12px; }
.gap-table th { background: #0f2d5e; color: white; padding: 9px 14px; text-align: left; }
.gap-table td { padding: 8px 14px; border-bottom: 1px solid #e8edf5; }
.gap-table tr:nth-child(even) td { background: #f8faff; }
.gap-bar { height: 8px; background: #e8edf5; border-radius: 4px; display: inline-block; width: 100px; vertical-align: middle; margin-left: 6px; }
.gap-bar-fill { height: 100%; background: #e74c3c; border-radius: 4px; }
.roster-table { width: 100%; border-collapse: collapse; font-size: 10px; }
.roster-table thead th { background: #0f2d5e; color: white; padding: 7px 6px; text-align: left; white-space: nowrap; }
.roster-table tbody td { padding: 5px 6px; border-bottom: 1px solid #eef1f7; vertical-align: middle; }
.roster-table tbody tr:hover td { background: #f8faff; }
.row-fail td { background: #fff5f5; } .row-fail:hover td { background: #fee; }
.row-warn30 td { background: #fff9f0; } .row-warn60 td { background: #fffef0; }
.row-new td { background: #f0f6ff; }
.col-name { font-weight: 600; min-width: 110px; }
.col-email { color: #666; font-size: 9px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-dept, .col-title { color: #888; font-size: 9px; max-width: 90px; }
.col-loc { color: #555; font-size: 9px; white-space: nowrap; }
.cell-ok { color: #1e8449; font-size: 9px; text-align: center; white-space: nowrap; }
.cell-warn { color: #b7770d; font-size: 9px; text-align: center; white-space: nowrap; }
.cell-fail { color: #c0392b; font-size: 13px; font-weight: 700; text-align: center; }
.cell-grace { color: #888; font-size: 11px; text-align: center; }
.cell-na { color: #ccc; text-align: center; }
.pill { padding: 2px 9px; border-radius: 20px; font-size: 9px; font-weight: 700; white-space: nowrap; }
.pill-green { background: #d4efdf; color: #1e8449; }
.pill-red { background: #fadbd8; color: #c0392b; }
.pill-amber { background: #fef9e7; color: #9a7d0a; border: 1px solid #f9e79f; }
.pill-orange { background: #fdf2e9; color: #a04000; border: 1px solid #f0b27a; }
.pill-blue { background: #dce8fb; color: #2471a3; }
.legend { font-size: 10px; color: #555; margin-bottom: 14px; display: flex; gap: 16px; flex-wrap: wrap; }
.group-header td { font-size: 10px !important; }
</style>
</head>
<body>

<div class="cover">
  <div class="cover-label">Finova — Confidential</div>
  <div class="cover-title">Compliance Training Status Report</div>
  <div class="cover-sub">Mandatory Annual Training · All Active UK/EU Employees</div>
  <div class="cover-divider"></div>
  <div class="cover-meta">
    <div><strong>Report date:</strong> ${dateStr}</div>
    <div><strong>Compliance window:</strong> ${lookbackStr} — ${dateStr}</div>
    <div><strong>Active employees (UK/EU):</strong> ${records.length} (${assessed} assessed, ${counts.NEW_STARTER} in grace period)</div>
    <div><strong>Compliance rate:</strong> ${counts.COMPLIANT} / ${assessed} assessed employees compliant (${compliancePct}%)</div>
    <div><strong>Grace period:</strong> ${policyRules.newStarterGraceDays} days from start date</div>
    <div><strong>Data sources:</strong> TalentLMS (S3 export) · NovaLXP REST API · BambooHR directory</div>
  </div>
</div>

<div class="section">
  <div class="section-title">Executive Summary</div>
  <div class="cards">
    <div class="card"><div class="card-value">${records.length}</div><div class="card-label">Active employees (UK/EU)</div></div>
    <div class="card green"><div class="card-value">${counts.COMPLIANT}</div><div class="card-label">Fully compliant</div></div>
    <div class="card red"><div class="card-value">${counts.OVERDUE}</div><div class="card-label">Non-compliant</div></div>
    <div class="card amber"><div class="card-value">${counts.DUE_30_DAYS + counts.DUE_60_DAYS}</div><div class="card-label">Due for renewal (60d)</div></div>
    <div class="card blue"><div class="card-value">${counts.NEW_STARTER}</div><div class="card-label">New starter (grace period)</div></div>
    <div class="card amber"><div class="card-value">${compliancePct}%</div><div class="card-label">Compliance rate (assessed)</div></div>
  </div>

  <div class="section-title">Gaps by Required Course</div>
  <table class="gap-table">
    <thead><tr><th>Required Course</th><th>Non-compliant employees</th><th>% of workforce</th></tr></thead>
    <tbody>
      ${requiredCourses.map(c => {
        const n = gaps[c] || 0;
        const pct = Math.round((n / records.length) * 100);
        return `<tr>
          <td>${esc(c)}</td>
          <td>${n} <span class="gap-bar"><span class="gap-bar-fill" style="width:${pct}%"></span></span></td>
          <td>${pct}%</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
</div>

<div class="section">
  <div class="section-title">Employee Compliance Roster</div>
  <div class="legend">
    <span>● = NovaLXP completion</span>
    <span><span style="color:#1e8449;font-weight:700">Date</span> = TalentLMS completion</span>
    <span><span style="color:#c0392b;font-weight:700">✗</span> = Not completed / overdue</span>
    <span><span style="color:#888">–</span> = New starter grace period</span>
  </div>
  <table class="roster-table">
    <thead>
      <tr>
        <th>Name</th><th>Email</th><th>Department</th><th>Location</th><th>Job Title</th><th>Status</th>
        ${requiredCourses.map(c => `<th title="${esc(c)}">${esc(TOPIC_SHORT[c] || c)}</th>`).join('')}
      </tr>
    </thead>
    <tbody>
      ${rows.join('\n')}
    </tbody>
  </table>
</div>

</body>
</html>`;
}

function fmtDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function fmtDateShort(date) {
  return new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

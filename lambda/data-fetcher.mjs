/**
 * data-fetcher.mjs
 *
 * Fetches all data needed by the compliance engine:
 *   1. Active Finova employees from BambooHR (UK/EU only)
 *   2. Employee hire dates (TalentLMS registration date proxy + Moodle first access)
 *   3. Historical TalentLMS completion records (from S3 one-time export)
 *   4. Current NovaLXP (Moodle) completion records via REST API
 *
 * All external HTTP calls are made from Lambda outside VPC — confirmed pattern
 * across all NovaLXP Lambda functions (feedback, bot, bamboohr-sync).
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { parseStringPromise } from 'xml2js';
import { COURSE_MAP, getAllTalentLMSIds } from './course-map.mjs';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-2' });

const TALENTLMS_S3_BUCKET = process.env.TALENTLMS_S3_BUCKET || 'novalxp-talentlms-export-070017892219';
const TALENTLMS_S3_PREFIX = process.env.TALENTLMS_S3_PREFIX || 'talentlms-export-2026-03-29';
const MOODLE_BASE_URL = process.env.MOODLE_BASE_URL || 'https://learn.novalxp.co.uk';

// Moodle bulk-provisioning epoch: users created before this timestamp are legacy
// and their timecreated should not be used as a hire-date proxy.
const MOODLE_BULK_PROVISIONING_EPOCH = 1770624000; // 2026-02-09T00:00:00Z Unix seconds

// Locations excluded from UK/EU compliance scope
const EXCLUDED_LOCATIONS = new Set(['Gurgaon', 'Chennai, Pune, Mumbai']);

// ─── BambooHR ─────────────────────────────────────────────────────────────────

/**
 * Fetch all active Finova employees (UK/EU) from the BambooHR directory API.
 * Returns: Array<{ bambooId, email, name, department, division, location, jobTitle }>
 */
export async function getActiveBambooHREmployees(apiKey) {
  console.log('[fetch] BambooHR: loading active employees...');

  const res = await fetch(
    'https://api.bamboohr.com/api/gateway.php/finova/v1/employees/directory',
    {
      headers: {
        Accept: 'application/xml',
        Authorization: 'Basic ' + Buffer.from(`${apiKey}:x`).toString('base64'),
      },
    }
  );
  if (!res.ok) throw new Error(`BambooHR directory failed: ${res.status} ${res.statusText}`);

  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const root = parsed?.directory || {};
  const nodes = root?.employees?.employee || [];
  const employees = Array.isArray(nodes) ? nodes : [nodes];

  const active = [];
  let excludedCount = 0;

  for (const emp of employees) {
    const bambooId = emp?.$?.id;
    if (!bambooId) continue;

    const fields = Array.isArray(emp.field) ? emp.field : emp.field ? [emp.field] : [];
    const rec = {};
    for (const f of fields) {
      const id = f?.$?.id;
      if (id) rec[id] = (typeof f === 'string' ? f : (f?._ ?? '')).trim();
    }

    const email = (rec.workEmail || rec.email || '').toLowerCase().trim();
    if (!email || !email.includes('@')) continue;

    const location = rec.location || '';
    if (EXCLUDED_LOCATIONS.has(location)) {
      excludedCount++;
      continue;
    }

    active.push({
      bambooId,
      email,
      name: [rec.firstName, rec.lastName].filter(Boolean).join(' ') || rec.displayName || email,
      department: rec.department || '',
      division: rec.division || '',
      location,
      jobTitle: rec.jobTitle || '',
    });
  }

  console.log(`[fetch] BambooHR: ${active.length} active UK/EU employees (${excludedCount} India-based excluded)`);
  return active;
}

/**
 * Fetch hire dates for employees as a proxy using:
 *   1. TalentLMS registration dates (for employees who were in TalentLMS)
 *   2. Moodle first-access dates (for employees added after TalentLMS was retired,
 *      excluding the bulk-provisioning batch from Feb 2026)
 *
 * Returns: Map<email, YYYY-MM-DD>
 *
 * Note: A direct BambooHR hire date feed would be more reliable. This proxy is
 * a best-effort workaround — the BambooHR directory API key does not expose
 * hireDate. If a full-access BambooHR token becomes available, fetch it from
 * /api/gateway.php/finova/v1/employees/{id}?fields=hireDate instead.
 */
export async function getHireDates(moodleToken) {
  console.log('[fetch] Loading employee hire dates (TalentLMS + Moodle proxy)...');

  const hireDates = {}; // email → YYYY-MM-DD

  // Source 1: TalentLMS registration dates
  try {
    const tlmsUsers = await readS3Json(`${TALENTLMS_S3_PREFIX}/users.json`);
    for (const u of tlmsUsers) {
      const email = (u.email || u.login || '').toLowerCase().trim();
      const reg = (u.registration || '').slice(0, 10);
      if (email && reg) hireDates[email] = reg;
    }
    console.log(`[fetch] TalentLMS registration dates: ${Object.keys(hireDates).length}`);
  } catch (e) {
    console.warn(`[fetch] Warning: could not load TalentLMS users.json: ${e.message}`);
  }

  // Source 2: Moodle timecreated (for employees NOT in TalentLMS, added post-retirement)
  try {
    const resp = await moodlePost(moodleToken, 'core_user_get_users', {
      'criteria[0][key]': 'suspended',
      'criteria[0][value]': '0',
    });
    for (const u of resp.users || []) {
      const email = (u.email || '').toLowerCase().trim();
      if (!email || hireDates[email]) continue; // already have TalentLMS date
      // Use firstaccess (first login) rather than timecreated; exclude bulk-provisioning batch
      const firstAccess = u.firstaccess || 0;
      if (firstAccess > MOODLE_BULK_PROVISIONING_EPOCH) {
        hireDates[email] = new Date(firstAccess * 1000).toISOString().slice(0, 10);
      }
    }
    console.log(`[fetch] Hire dates after Moodle supplement: ${Object.keys(hireDates).length}`);
  } catch (e) {
    console.warn(`[fetch] Warning: could not load Moodle user dates: ${e.message}`);
  }

  return hireDates;
}

// ─── TalentLMS (historical, from S3) ─────────────────────────────────────────

/**
 * Load completion records from the TalentLMS S3 export.
 * Since TalentLMS was retired, this snapshot is the definitive historical record.
 *
 * Returns: Map<email, Map<courseKey, ISO date string>>
 *   (most recent completion per email per course within the trailing renewalMonths window)
 */
export async function getTalentLMSCompletions(requiredCourses, renewalMonths, asOf) {
  console.log('[fetch] TalentLMS: loading historical completions from S3...');

  const cutoff = subtractMonths(asOf, renewalMonths);
  const allIds = getAllTalentLMSIds();

  let records;
  try {
    records = await readS3Json(`${TALENTLMS_S3_PREFIX}/compliance-completions.json`);
  } catch (e) {
    console.warn(`[fetch] Warning: could not load TalentLMS completions: ${e.message}`);
    return {};
  }

  const lookup = {}; // email → { courseKey → ISO date }
  for (const r of records) {
    const email = (r.user_email || '').toLowerCase().trim();
    const courseId = Number(r.id);
    const completedAt = (r.completion_date || '').slice(0, 10);
    if (!email || !courseId || !completedAt) continue;
    if (completedAt < cutoff) continue; // outside renewal window
    if (!allIds.has(courseId)) continue;

    for (const [key, def] of Object.entries(COURSE_MAP)) {
      if (!requiredCourses.includes(key)) continue;
      if (def.talentlms.includes(courseId)) {
        if (!lookup[email]) lookup[email] = {};
        if (!lookup[email][key] || completedAt > lookup[email][key]) {
          lookup[email][key] = completedAt;
        }
      }
    }
  }

  const users = Object.keys(lookup).length;
  const hits = Object.values(lookup).reduce((n, m) => n + Object.keys(m).length, 0);
  console.log(`[fetch] TalentLMS: ${hits} relevant completions for ${users} users`);
  return lookup;
}

// ─── NovaLXP / Moodle ─────────────────────────────────────────────────────────

/**
 * Fetch all Moodle users and their completion status for each required course.
 *
 * Returns: {
 *   completions: Map<email, Map<courseKey, ISO date string>>,
 *   emailToMoodleId: Map<email, moodleUserId>
 * }
 */
export async function getMoodleCompletions(requiredCourses, renewalMonths, asOf, moodleToken) {
  console.log('[fetch] NovaLXP: loading Moodle users...');

  const cutoff = subtractMonths(asOf, renewalMonths);

  const usersResp = await moodlePost(moodleToken, 'core_user_get_users', {
    'criteria[0][key]': 'suspended',
    'criteria[0][value]': '0',
  });
  const allUsers = usersResp.users || [];
  console.log(`[fetch] NovaLXP: ${allUsers.length} active users`);

  const emailToMoodleId = {};
  for (const u of allUsers) {
    if (u.email) emailToMoodleId[u.email.toLowerCase()] = u.id;
  }

  const completions = {}; // email → { courseKey → ISO date }

  // Build list of (email, moodleId, courseKey, moodleCourseId) tasks
  const tasks = [];
  for (const [email, moodleId] of Object.entries(emailToMoodleId)) {
    for (const courseKey of requiredCourses) {
      const def = COURSE_MAP[courseKey];
      if (!def) continue;
      tasks.push({ email, moodleId, courseKey, moodleCourseId: def.moodle });
    }
  }

  // Process in batches of 15 concurrent requests
  const BATCH = 15;
  let checked = 0;
  for (let i = 0; i < tasks.length; i += BATCH) {
    const batch = tasks.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async ({ email, moodleId, courseKey, moodleCourseId }) => {
      try {
        const resp = await moodlePost(moodleToken, 'core_completion_get_course_completion_status', {
          courseid: moodleCourseId,
          userid: moodleId,
        });
        if (!resp?.completionstatus?.completed) return;

        const criteria = resp.completionstatus.completions || [];
        const ts = resp.completionstatus.timecompleted
          || criteria.reduce((max, c) => Math.max(max, c.timecompleted || 0), 0)
          || 0;

        const completedDate = ts
          ? new Date(ts * 1000).toISOString().slice(0, 10)
          : asOf.toISOString().slice(0, 10);

        if (completedDate >= cutoff) {
          if (!completions[email]) completions[email] = {};
          if (!completions[email][courseKey] || completedDate > completions[email][courseKey]) {
            completions[email][courseKey] = completedDate;
          }
        }
      } catch {
        // Ignore per-user/course failures — they'll be treated as incomplete
      }
    }));
    checked += batch.length;
    if (checked % 100 === 0 || checked === tasks.length) {
      process.stdout.write(`\r[fetch] NovaLXP: checked ${checked}/${tasks.length} user/course pairs...`);
    }
  }
  console.log(''); // newline after progress

  const users = Object.keys(completions).length;
  console.log(`[fetch] NovaLXP: ${users} users with recent completions`);
  return { completions, emailToMoodleId };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readS3Json(key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: TALENTLMS_S3_BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function moodlePost(token, fn, params = {}) {
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: 'json' });
  for (const [k, v] of Object.entries(params)) body.set(k, v);
  const r = await fetch(`${MOODLE_BASE_URL}/webservice/rest/server.php`, { method: 'POST', body });
  return r.json();
}

/** Subtract N months from a Date, returning YYYY-MM-DD string */
function subtractMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

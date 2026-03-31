/**
 * course-map.mjs
 *
 * Maps the human-readable course names (as they appear in the policy document)
 * to their LMS identifiers in TalentLMS and NovaLXP (Moodle).
 *
 * When the policy document changes (e.g., a new course is added or renamed),
 * update this file to add/update the corresponding LMS IDs and redeploy.
 *
 * TalentLMS IDs: course IDs from the historical export (multiple IDs per topic
 *   because courses were versioned over time — any version counts).
 * Moodle IDs: course ID in NovaLXP.
 */

export const COURSE_MAP = {
  'Bribery Prevention': {
    talentlms: [1570, 1603, 1661, 1662],
    moodle: 105,
  },
  'Data Protection': {
    talentlms: [1571, 1604, 1663, 1664],
    moodle: 106,
  },
  'DSE (Display Screen Equipment)': {
    // Policy may call this "Display Screen Equipment" — normalised below
    talentlms: [1569, 1602, 1665],
    moodle: 107,
  },
  'Fraud Prevention': {
    talentlms: [1572, 1601, 1666, 1667],
    moodle: 108,
  },
  'Information Security': {
    talentlms: [1573, 1599, 1668, 1669],
    moodle: 109,
  },
  'Responsible Use of Social Media': {
    talentlms: [1574, 1600, 1670],
    moodle: 110,
  },
};

// Aliases: normalise policy course names that differ slightly from map keys
const ALIASES = {
  'Display Screen Equipment': 'DSE (Display Screen Equipment)',
  'DSE': 'DSE (Display Screen Equipment)',
  'Data Protection & GDPR': 'Data Protection',
  'GDPR / Data Protection': 'Data Protection',
  'Social Media': 'Responsible Use of Social Media',
  'Social Media Policy': 'Responsible Use of Social Media',
  'Anti-Bribery': 'Bribery Prevention',
  'Anti-Fraud': 'Fraud Prevention',
  'Cyber Security': 'Information Security',
};

/**
 * Given the list of required course names extracted from the policy PDF,
 * returns the subset that have known LMS mappings plus warnings for unknowns.
 *
 * @param {string[]} policyCourseNames - Course names extracted by Bedrock
 * @returns {{ mappedCourses: string[], warnings: string[] }}
 */
export function reconcilePolicyCourses(policyCourseNames) {
  const knownKeys = new Set(Object.keys(COURSE_MAP));
  const mappedCourses = [];
  const warnings = [];

  for (const name of policyCourseNames) {
    const canonical = ALIASES[name] || name;
    if (knownKeys.has(canonical)) {
      mappedCourses.push(canonical);
    } else {
      warnings.push(`Policy course "${name}" has no LMS mapping — it will be skipped. Update course-map.mjs to add it.`);
    }
  }

  // Warn about courses in the map that the policy does NOT require
  for (const key of knownKeys) {
    const inPolicy = policyCourseNames.some(n => (ALIASES[n] || n) === key);
    if (!inPolicy) {
      warnings.push(`LMS course "${key}" is in course-map.mjs but NOT listed in the current policy. It will not be checked.`);
    }
  }

  return { mappedCourses, warnings };
}

/** Return all TalentLMS IDs across all mapped courses */
export function getAllTalentLMSIds() {
  return new Set(Object.values(COURSE_MAP).flatMap(c => c.talentlms));
}

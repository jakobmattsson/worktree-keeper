'use strict';

function requiredChecks(cwd) {
  const { projectConfig } = require('./project-config');
  const checks = projectConfig(cwd).git.releaseRequiredChecks;
  if (!checks?.length) throw new Error('Configure git.releaseRequiredChecks with the CI jobs required for releases.');
  return checks;
}

// A missing classic protection is expected for ruleset-only repositories. All
// other API failures, including permission failures, must propagate.
function verifyProtection({ api, slug, branch, checks }) {
  const base = `repos/${slug}`;
  let protection;
  try {
    protection = api(`${base}/branches/${encodeURIComponent(branch)}/protection`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const rules = [];
  for (let page = 1; ; page += 1) {
    const batch = api(`${base}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('GitHub returned invalid branch rules.');
    rules.push(...batch);
    if (batch.length < 100) break;
  }
  const strictChecks = new Set();
  const classic = protection?.required_status_checks;
  if (classic?.strict === true && protection.enforce_admins?.enabled === true) {
    for (const check of classic.checks || []) strictChecks.add(check.context);
    for (const context of classic.contexts || []) strictChecks.add(context);
  }
  // Ruleset bypass actors are not included in the effective-rules response.
  // Read every contributing ruleset and require that it has no bypass actors.
  const checkedRulesets = new Set();
  for (const rule of rules.filter(rule => rule.type === 'required_status_checks')) {
    if (rule.parameters?.strict_required_status_checks_policy !== true) continue;
    if (!Number.isInteger(rule.ruleset_id)) throw new Error('GitHub did not identify the status-check ruleset.');
    if (!checkedRulesets.has(rule.ruleset_id)) {
      const ruleset = api(`${base}/rulesets/${rule.ruleset_id}`);
      if (ruleset.enforcement !== 'active' || !Array.isArray(ruleset.bypass_actors)) {
        throw new Error('Cannot verify active ruleset bypass settings; grant write access to the ruleset so GitHub exposes bypass actors, then rerun.');
      }
      if (ruleset.bypass_actors.length) throw new Error('Strict release rulesets must not allow bypass actors.');
      checkedRulesets.add(rule.ruleset_id);
    }
    for (const check of rule.parameters.required_status_checks || []) strictChecks.add(check.context);
  }
  const missing = checks.filter(check => !strictChecks.has(check));
  if (!checks.length || missing.length) {
    throw new Error(`Branch ${branch} must require strict status checks without bypass for: ${missing.join(', ') || '(no checks configured)'}. Enable strict checks and enforce them for administrators, or use an active ruleset without bypass actors; then rerun.`);
  }
}

function githubApi(exec, cwd, host) {
  return endpoint => {
    const response = exec('gh', ['api', '--hostname', host, '--method', 'GET', endpoint], { cwd });
    if (response.status !== 0) {
      const error = new Error(`Cannot verify GitHub release policy (${endpoint}): ${response.stderr?.trim() || 'API request failed'}. Grant the token Administration read, Contents read, Pull requests read and Actions read permissions, then rerun.`);
      error.status = Number(/HTTP (\d{3})/u.exec(response.stderr || '')?.[1]);
      throw error;
    }
    return JSON.parse(response.stdout);
  };
}

module.exports = { githubApi, requiredChecks, verifyProtection };

#!/usr/bin/env node

const fs = require('node:fs');
const { checkpointInstructions } = require('./checkpoint-instructions');
const { projectConfig } = require('./project-config');
const { isPrimaryWorktree, logScriptInvocation } = require('./log-script-invocation');

function buildResponse(event) {
  if (event?.hook_event_name !== 'SessionStart' || typeof event.cwd !== 'string') {
    return {};
  }
  if (isPrimaryWorktree(event.cwd)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: checkpointInstructions(projectConfig(event.cwd)),
    },
  };
}

function main() {
  logScriptInvocation();
  const input = fs.readFileSync(0, 'utf8').trim();
  process.stdout.write(`${JSON.stringify(buildResponse(input === '' ? null : JSON.parse(input)))}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      systemMessage: `Codex checkpoint instructions failed: ${error.message}`,
    })}\n`);
  }
}

module.exports = { buildResponse };

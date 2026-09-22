#!/usr/bin/env node

const fs = require('node:fs');
const { ROOT, environmentFingerprint, receiptPath, snapshot } = require('./receipt-state');
const { projectConfig } = require('./project-config');
function successMessage(root = ROOT()) {
  return `Tests already passed for this change set. In order to rerun tests anyway, use: ${projectConfig(root).tests.rerunCommand}`;
}

function matchesReceipt(receipt, root = ROOT()) {
  const { receiptMaxAgeMinutes } = projectConfig(root).tests;
  if (!receipt || receipt.version !== 1 || !Number.isFinite(receipt.passedAt) ||
      Date.now() < receipt.passedAt || Date.now() - receipt.passedAt > receiptMaxAgeMinutes * 60_000 ||
      receipt.environment !== environmentFingerprint()) return false;
  const current = snapshot(root, receipt.baseCommit);
  return JSON.stringify(current.changedFiles) === JSON.stringify(receipt.changedFiles);
}

function checkReceipt(root = ROOT()) {
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath(root), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
  return matchesReceipt(receipt, root);
}

if (require.main === module) {
  if (process.argv.length !== 2) {
    console.error('Usage: node scripts/check-test-receipt.js');
    process.exitCode = 2;
  } else {
    try {
      if (!checkReceipt()) process.exitCode = 1;
      else console.log(successMessage());
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { checkReceipt, matchesReceipt, successMessage };

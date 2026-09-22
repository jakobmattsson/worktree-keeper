#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, receiptPath, snapshot } = require('./receipt-state');

function recordReceipt(root = ROOT()) {
  const receipt = { version: 1, passedAt: Date.now(), ...snapshot(root) };
  const destination = receiptPath(root);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`);
  fs.renameSync(temporary, destination);
  return receipt;
}

if (require.main === module) {
  if (process.argv.length !== 2) {
    console.error('Usage: node scripts/record-test-receipt.js');
    process.exitCode = 2;
  } else {
    try {
      recordReceipt();
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { recordReceipt };

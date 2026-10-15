#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lockfile = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const expectedTag = `v${manifest.version}`;
if (process.env.RELEASE_TAG !== expectedTag) {
  throw new Error(`Release tag must be ${expectedTag}, got ${process.env.RELEASE_TAG}`);
}
if (lockfile.version !== manifest.version || lockfile.packages[''].version !== manifest.version) {
  throw new Error('package-lock.json version must match package.json');
}

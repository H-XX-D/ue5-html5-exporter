import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createActivityReleaseReceipt } from '../web/public/scripts/activity-release.mjs';
import {
  MAX_RELEASE_RECEIPT_BYTES,
  RELEASE_VERIFICATION_SCHEMA,
  readActivityReleaseReceipt,
  validateActivityReleaseReceipt,
  verifyActivityReleaseReceipt,
  writeActivityReleaseVerification,
} from '../web/public/scripts/activity-release-receipt.mjs';

const MANIFEST_IDENTITY = `sha256:${'a'.repeat(64)}`;
const ASSET_PACK_IDENTITY = `sha256:${'b'.repeat(64)}`;

function productionReceipt() {
  return createActivityReleaseReceipt({
    ok: true,
    applied: true,
    promoted: true,
    deploymentUrl: 'https://immutable-build.example',
    productionUrl: 'https://game.example',
    exporterVersion: '0.3.55',
    manifestSchema: 'ue5-html5-export/v7',
    manifestIdentity: MANIFEST_IDENTITY,
    assetPackIdentity: ASSET_PACK_IDENTITY,
    discordUrlMappings: {
      '/': 'game.example',
      '/supabase': 'project.supabase.co',
    },
  }, { environment: 'production', migrated: false, now: '2026-08-23T17:00:00.000Z' });
}

function matchingHosted() {
  return {
    errors: [],
    warnings: [],
    checks: ['hosted release passed'],
    manifestIdentity: MANIFEST_IDENTITY,
    assetPackIdentity: ASSET_PACK_IDENTITY,
    manifestSchema: 'ue5-html5-export/v7',
    exporterVersion: '0.3.55',
  };
}

test('release receipt verifier probes immutable and stable URLs and writes privacy-safe evidence', async () => {
  const receipt = productionReceipt();
  const urls = [];
  const result = await verifyActivityReleaseReceipt(receipt, {
    async verifyDeployment(url) { urls.push(url); return matchingHosted(); },
    now: '2026-08-23T17:05:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(urls, ['https://immutable-build.example', 'https://game.example']);
  assert.equal(result.verification.schema, RELEASE_VERIFICATION_SCHEMA);
  assert.equal(result.verification.status, 'passed');
  assert.equal(result.verification.identities.manifest, MANIFEST_IDENTITY);
  assert.deepEqual(result.verification.privacy, {
    containsSecrets: false,
    containsPlayerData: false,
    containsBillingData: false,
  });

  const root = mkdtempSync(join(tmpdir(), 'ue5-release-verification-'));
  try {
    const path = writeActivityReleaseVerification(root, result.verification);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(written.publicUrl, 'https://game.example');
    assert.doesNotMatch(JSON.stringify(written), /client.?secret|bot.?token|private.?key|email/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release receipt verifier checks a Preview URL once', async () => {
  const receipt = createActivityReleaseReceipt({
    ok: true,
    applied: true,
    promoted: false,
    deploymentUrl: 'https://preview.example',
    exporterVersion: '0.3.55',
    manifestSchema: 'ue5-html5-export/v7',
    manifestIdentity: MANIFEST_IDENTITY,
    assetPackIdentity: ASSET_PACK_IDENTITY,
    discordUrlMappings: { '/': 'preview.example' },
  }, { environment: 'preview', migrated: false, now: '2026-08-23T17:00:00.000Z' });
  let calls = 0;
  const result = await verifyActivityReleaseReceipt(receipt, {
    async verifyDeployment() { calls += 1; return matchingHosted(); },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

test('release receipt verifier rejects unknown fields, privacy claims, and inconsistent mappings', () => {
  const extra = { ...productionReceipt(), clientSecret: 'must-not-be-accepted' };
  assert.equal(validateActivityReleaseReceipt(extra).ok, false);

  const privacy = productionReceipt();
  privacy.privacy.containsPlayerData = true;
  assert.ok(validateActivityReleaseReceipt(privacy).errors.some((error) => error.includes('containsPlayerData')));

  const mapping = productionReceipt();
  mapping.discordUrlMappings['/'] = 'other.example';
  assert.ok(validateActivityReleaseReceipt(mapping).errors.some((error) => error.includes('root Discord mapping')));

  const promoted = productionReceipt();
  promoted.verification.stableProductionPassed = false;
  assert.ok(validateActivityReleaseReceipt(promoted).errors.some((error) => error.includes('stable public URL')));

  for (const unsafeUrl of ['https://localhost', 'https://127.0.0.1', 'https://game.example:8443']) {
    const unsafe = productionReceipt();
    unsafe.deploymentUrl = unsafeUrl;
    assert.ok(validateActivityReleaseReceipt(unsafe).errors.some((error) => error.includes('public, origin-only HTTPS hostname')));
  }
});

test('release receipt verifier fails closed when either hosted identity changes', async () => {
  const receipt = productionReceipt();
  let calls = 0;
  const result = await verifyActivityReleaseReceipt(receipt, {
    async verifyDeployment() {
      calls += 1;
      return calls === 1 ? matchingHosted() : { ...matchingHosted(), manifestIdentity: `sha256:${'c'.repeat(64)}` };
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('manifest identity does not match')));
  assert.equal(result.checks.some((check) => check.includes('https://game.example')), false);
});

test('release receipt reader rejects missing, invalid, and oversized files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ue5-release-receipt-'));
  try {
    assert.throws(() => readActivityReleaseReceipt(join(root, 'missing.json')), /was not found/);
    const invalid = join(root, 'invalid.json');
    writeFileSync(invalid, '{');
    assert.throws(() => readActivityReleaseReceipt(invalid), /not valid JSON/);
    const oversized = join(root, 'oversized.json');
    writeFileSync(oversized, 'x'.repeat(MAX_RELEASE_RECEIPT_BYTES + 1));
    assert.throws(() => readActivityReleaseReceipt(oversized), /between 1 and/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

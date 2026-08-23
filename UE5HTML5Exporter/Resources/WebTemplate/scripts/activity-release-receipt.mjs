#!/usr/bin/env node

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  RELEASE_RECEIPT_FILENAME,
  RELEASE_RECEIPT_SCHEMA,
  verifyPublicDeployment,
} from './activity-release.mjs';

export const RELEASE_VERIFICATION_SCHEMA = 'ue5-discord-activity-release-verification/v1';
export const RELEASE_VERIFICATION_FILENAME = 'activity-release-verification.json';
export const MAX_RELEASE_RECEIPT_BYTES = 64 * 1024;

const RECEIPT_KEYS = [
  'schema',
  'status',
  'createdAtUtc',
  'environment',
  'promoted',
  'deploymentUrl',
  'publicUrl',
  'exporter',
  'identities',
  'discordUrlMappings',
  'verification',
  'privacy',
];
const EXPORTER_KEYS = ['version', 'manifestSchema'];
const IDENTITY_KEYS = ['manifest', 'assetPack'];
const VERIFICATION_KEYS = [
  'localExportPassed',
  'servicePreflightPassed',
  'publicDeploymentPassed',
  'stableProductionPassed',
  'supabaseMigrationApplied',
];
const PRIVACY_KEYS = ['containsSecrets', 'containsPlayerData', 'containsBillingData'];
const ALLOWED_MAPPING_KEYS = new Set(['/', '/supabase']);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MANIFEST_SCHEMA_PATTERN = /^ue5-html5-export\/v[1-9]\d*$/;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label, errors) {
  if (!plainObject(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    errors.push(`${label} must contain exactly: ${wanted.join(', ')}.`);
    return false;
  }
  return true;
}

function verifiedHttpsUrl(value, label, errors) {
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${label} must be a valid HTTPS URL.`);
    return null;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const unsafeHostname = isIP(hostname) !== 0
    || !hostname.includes('.')
    || hostname === 'localhost'
    || ['.localhost', '.local', '.internal', '.lan', '.home'].some((suffix) => hostname.endsWith(suffix));
  if (url.protocol !== 'https:'
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
      || (url.pathname && url.pathname !== '/')
      || unsafeHostname) {
    errors.push(`${label} must be a public, origin-only HTTPS hostname without credentials, port, query, or fragment.`);
    return null;
  }
  return url;
}

function exactUtc(value) {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function validateActivityReleaseReceipt(receipt) {
  const errors = [];
  if (!exactKeys(receipt, RECEIPT_KEYS, 'Release receipt', errors)) return { ok: false, errors };

  if (receipt.schema !== RELEASE_RECEIPT_SCHEMA) {
    errors.push(`Release receipt schema must be ${RELEASE_RECEIPT_SCHEMA}.`);
  }
  if (!['verified-preview', 'verified-production', 'promoted-production-stable-url-unverified'].includes(receipt.status)) {
    errors.push('Release receipt status is not supported.');
  }
  if (!exactUtc(receipt.createdAtUtc)) errors.push('Release receipt createdAtUtc must be an exact UTC timestamp.');
  if (!['preview', 'production'].includes(receipt.environment)) errors.push('Release receipt environment must be preview or production.');
  if (typeof receipt.promoted !== 'boolean') errors.push('Release receipt promoted must be a boolean.');

  const deploymentUrl = verifiedHttpsUrl(receipt.deploymentUrl, 'Release receipt deploymentUrl', errors);
  const publicUrl = verifiedHttpsUrl(receipt.publicUrl, 'Release receipt publicUrl', errors);

  if (exactKeys(receipt.exporter, EXPORTER_KEYS, 'Release receipt exporter', errors)) {
    if (!VERSION_PATTERN.test(receipt.exporter.version || '')) errors.push('Release receipt exporter.version must be a semantic version.');
    if (!MANIFEST_SCHEMA_PATTERN.test(receipt.exporter.manifestSchema || '')) errors.push('Release receipt exporter.manifestSchema is invalid.');
  }
  if (exactKeys(receipt.identities, IDENTITY_KEYS, 'Release receipt identities', errors)) {
    if (!HASH_PATTERN.test(receipt.identities.manifest || '')) errors.push('Release receipt manifest identity must be a lowercase SHA-256 identity.');
    if (!HASH_PATTERN.test(receipt.identities.assetPack || '')) errors.push('Release receipt asset-pack identity must be a lowercase SHA-256 identity.');
  }

  if (!plainObject(receipt.discordUrlMappings)) {
    errors.push('Release receipt discordUrlMappings must be an object.');
  } else {
    const mappingKeys = Object.keys(receipt.discordUrlMappings);
    if (!mappingKeys.includes('/') || mappingKeys.some((key) => !ALLOWED_MAPPING_KEYS.has(key))) {
      errors.push('Release receipt discordUrlMappings must contain / and may contain only /supabase in addition.');
    }
    for (const [prefix, host] of Object.entries(receipt.discordUrlMappings)) {
      if (typeof host !== 'string' || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) {
        errors.push(`Release receipt Discord mapping ${prefix} must be a hostname without a scheme or path.`);
      }
    }
    if (publicUrl && receipt.discordUrlMappings['/'] !== publicUrl.host) {
      errors.push('Release receipt root Discord mapping must match publicUrl.');
    }
  }

  if (exactKeys(receipt.verification, VERIFICATION_KEYS, 'Release receipt verification', errors)) {
    for (const key of VERIFICATION_KEYS) {
      if (typeof receipt.verification[key] !== 'boolean') errors.push(`Release receipt verification.${key} must be a boolean.`);
    }
    for (const key of ['localExportPassed', 'servicePreflightPassed', 'publicDeploymentPassed']) {
      if (receipt.verification[key] !== true) errors.push(`Release receipt verification.${key} must be true.`);
    }
  }
  if (exactKeys(receipt.privacy, PRIVACY_KEYS, 'Release receipt privacy', errors)) {
    for (const key of PRIVACY_KEYS) {
      if (receipt.privacy[key] !== false) errors.push(`Release receipt privacy.${key} must be false.`);
    }
  }

  if (receipt.status === 'verified-preview') {
    if (receipt.environment !== 'preview' || receipt.promoted !== false) errors.push('A verified Preview receipt must be preview and not promoted.');
    if (receipt.verification?.stableProductionPassed !== false) errors.push('A verified Preview receipt cannot claim stable Production verification.');
    if (deploymentUrl && publicUrl && deploymentUrl.href !== publicUrl.href) errors.push('A verified Preview receipt publicUrl must equal deploymentUrl.');
  }
  if (receipt.status === 'verified-production') {
    if (receipt.environment !== 'production' || receipt.promoted !== true) errors.push('A verified Production receipt must be production and promoted.');
    if (receipt.verification?.stableProductionPassed !== true) errors.push('A verified Production receipt must prove its stable public URL.');
    if (deploymentUrl && publicUrl && deploymentUrl.href === publicUrl.href) errors.push('A verified Production receipt must identify a stable public URL separately from its immutable deployment URL.');
  }
  if (receipt.status === 'promoted-production-stable-url-unverified') {
    if (receipt.environment !== 'production' || receipt.promoted !== true) errors.push('A promoted receipt must be production and promoted.');
    if (receipt.verification?.stableProductionPassed !== false) errors.push('An unverified stable-URL receipt cannot claim stable Production verification.');
    if (deploymentUrl && publicUrl && deploymentUrl.href !== publicUrl.href) errors.push('An unverified stable-URL receipt must use deploymentUrl as its publicUrl fallback.');
  }

  return { ok: errors.length === 0, errors, deploymentUrl, publicUrl };
}

export function readActivityReleaseReceipt(path) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Release receipt was not found: ${resolved}`);
  const size = statSync(resolved).size;
  if (size <= 0 || size > MAX_RELEASE_RECEIPT_BYTES) {
    throw new Error(`Release receipt must be between 1 and ${MAX_RELEASE_RECEIPT_BYTES} bytes.`);
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`Release receipt is not valid JSON: ${error.message || error}`);
  }
  return { path: resolved, receipt };
}

export async function verifyActivityReleaseReceipt(receipt, {
  verifyDeployment = verifyPublicDeployment,
  now = new Date(),
} = {}) {
  const contract = validateActivityReleaseReceipt(receipt);
  if (!contract.ok) return { ok: false, errors: contract.errors, checks: [] };

  const checks = ['Release receipt contract and privacy boundary are valid.'];
  const errors = [];
  const urls = [...new Set([receipt.deploymentUrl, receipt.publicUrl])];
  for (const url of urls) {
    const hosted = await verifyDeployment(url);
    const urlErrors = (hosted.errors || []).map((error) => `${url}: ${error}`);
    if ((hosted.manifestIdentity || null) !== receipt.identities.manifest) {
      urlErrors.push(`${url}: hosted manifest identity does not match the release receipt.`);
    }
    if ((hosted.assetPackIdentity || null) !== receipt.identities.assetPack) {
      urlErrors.push(`${url}: hosted asset-pack identity does not match the release receipt.`);
    }
    if ((hosted.exporterVersion || null) !== receipt.exporter.version) {
      urlErrors.push(`${url}: hosted exporter version does not match the release receipt.`);
    }
    if ((hosted.manifestSchema || null) !== receipt.exporter.manifestSchema) {
      urlErrors.push(`${url}: hosted manifest schema does not match the release receipt.`);
    }
    errors.push(...urlErrors);
    if (!urlErrors.length) checks.push(`Hosted release identity matches at ${url}.`);
  }
  if (errors.length) return { ok: false, errors, checks };

  const verifiedAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(verifiedAt.getTime())) return { ok: false, errors: ['Release verification time is invalid.'], checks };
  return {
    ok: true,
    errors: [],
    checks,
    verification: {
      schema: RELEASE_VERIFICATION_SCHEMA,
      status: 'passed',
      verifiedAtUtc: verifiedAt.toISOString(),
      receiptCreatedAtUtc: receipt.createdAtUtc,
      environment: receipt.environment,
      promoted: receipt.promoted,
      deploymentUrl: receipt.deploymentUrl,
      publicUrl: receipt.publicUrl,
      exporter: { ...receipt.exporter },
      identities: { ...receipt.identities },
      discordUrlMappings: { ...receipt.discordUrlMappings },
      checks: {
        receiptContractPassed: true,
        immutableDeploymentPassed: true,
        publicUrlPassed: true,
        identitiesMatched: true,
        privacyPassed: true,
      },
      privacy: {
        containsSecrets: false,
        containsPlayerData: false,
        containsBillingData: false,
      },
    },
  };
}

export function writeActivityReleaseVerification(directory, verification) {
  const path = join(resolve(directory), RELEASE_VERIFICATION_FILENAME);
  writeFileSync(path, `${JSON.stringify(verification, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function run() {
  const receiptPath = process.argv[2] || resolve(process.cwd(), RELEASE_RECEIPT_FILENAME);
  const loaded = readActivityReleaseReceipt(receiptPath);
  const result = await verifyActivityReleaseReceipt(loaded.receipt);
  if (!result.ok) {
    console.error(`Discord Activity release verification failed (${result.errors.length} error${result.errors.length === 1 ? '' : 's'}):`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  const output = writeActivityReleaseVerification(dirname(loaded.path), result.verification);
  console.log('Discord Activity release verification passed.');
  for (const check of result.checks) console.log(`- ${check}`);
  console.log(`Playable URL: ${result.verification.publicUrl}`);
  console.log(`Secret-free verification: ${output}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await run();
}

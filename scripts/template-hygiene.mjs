#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TEMPLATE = join(REPOSITORY_ROOT, 'UE5HTML5Exporter', 'Resources', 'WebTemplate');
const NUMBERED_DUPLICATE = / \d+(?=\.[^.]+$|$)/;

export function findNumberedDuplicates(directory, { skipNames = [] } = {}) {
  const root = resolve(directory);
  const skipped = new Set(skipNames);
  const matches = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (NUMBERED_DUPLICATE.test(entry.name)) matches.push(path);
    }
  };
  visit(root);
  return matches;
}

export function duplicateBasePath(path) {
  const name = basename(path);
  return join(dirname(path), name.replace(NUMBERED_DUPLICATE, ''));
}

export function cleanGeneratedTemplateDuplicates(directory = DEFAULT_TEMPLATE) {
  const removed = [];
  for (const duplicate of findNumberedDuplicates(directory)) {
    const base = duplicateBasePath(duplicate);
    if (!existsSync(base) || !statSync(base).isFile()) {
      throw new Error(`Numbered generated file has no canonical counterpart: ${duplicate}`);
    }
    if (!readFileSync(duplicate).equals(readFileSync(base))) {
      throw new Error(`Numbered generated file differs from its canonical counterpart: ${duplicate}`);
    }
    rmSync(duplicate);
    removed.push(duplicate);
  }
  return removed;
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  try {
    if (!process.argv.includes('--clean')) throw new Error('Pass --clean to remove only byte-identical generated duplicates.');
    const directoryArgument = process.argv.find((argument, index) => index > 1 && argument !== '--clean');
    const directory = resolve(directoryArgument || DEFAULT_TEMPLATE);
    const removed = cleanGeneratedTemplateDuplicates(directory);
    console.log(removed.length
      ? `Removed ${removed.length} byte-identical generated duplicate file(s).`
      : 'Generated template contains no numbered duplicate files.');
  } catch (error) {
    console.error(`Template hygiene failed: ${error.message}`);
    process.exit(1);
  }
}

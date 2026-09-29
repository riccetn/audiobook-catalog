// Guards the data files: the demo data is always checked, your own data too when it is present,
// and personal data must never be tracked by git (this repository is public).
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const C = require('../importers.js');
const { formatBooks, formatSeriesInfo, loadBooks, loadSeriesInfo } = require('../catalog.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(root, 'data');
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function canonical(folder) {
  return formatBooks(loadBooks(path.join(folder, 'books.json'))) === read(path.join(folder, 'books.json'))
    && formatSeriesInfo(loadSeriesInfo(path.join(folder, 'series-info.json'))) === read(path.join(folder, 'series-info.json'));
}

test('demo data validates without errors or warnings', () => {
  const folder = path.join(DATA, 'sample');
  assert.deepEqual(C.validate(loadBooks(path.join(folder, 'books.json')), loadSeriesInfo(path.join(folder, 'series-info.json'))),
    { errors: [], warnings: [] });
});

test('demo data is in canonical layout', () => {
  assert.ok(canonical(path.join(DATA, 'sample')), 'regenerate the demo files in canonical layout');
});

test('demo data has what the smoke test needs', () => {
  const books = loadBooks(path.join(DATA, 'sample', 'books.json'));
  assert.ok(books.some(b => !b.s), 'needs standalone books');
  assert.ok(books.some(b => b.s), 'needs series');
});

const ownData = fs.existsSync(path.join(DATA, 'books.json'));
const noOwnData = !ownData && 'no personal data/books.json (fine: it is git-ignored)';

test('your own data validates without errors', { skip: noOwnData }, () => {
  assert.deepEqual(C.validate(loadBooks(path.join(DATA, 'books.json')), loadSeriesInfo(path.join(DATA, 'series-info.json'))).errors, []);
});

test('your own data is in canonical layout', { skip: noOwnData }, () => {
  assert.ok(canonical(DATA), 'run `make format`');
});

const PRIVATE = ['data/books.json', 'data/series-info.json', 'data/excluded.txt', 'data/raw/*'];

test('.gitignore covers every personal file', () => {
  const lines = new Set(read(path.join(root, '.gitignore')).split('\n').map(l => l.trim()));
  for (const pattern of PRIVATE) assert.ok(lines.has(pattern), `.gitignore must list ${pattern}`);
});

const git = spawnSync('git', ['ls-files', 'data'], { cwd: root, encoding: 'utf8' });

test('only the demo data is tracked', { skip: git.status !== 0 && 'not inside a git checkout' }, () => {
  const allowed = new Set(['data/sample/books.json', 'data/sample/series-info.json', 'data/raw/.gitkeep']);
  for (const file of git.stdout.split('\n').filter(Boolean)) assert.ok(allowed.has(file), `${file} must not be tracked`);
});

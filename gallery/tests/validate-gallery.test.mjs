import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DEFAULT_CAPS,
  GalleryValidationError,
  validateGallery,
} from '../scripts/validate-gallery.mjs';

const GALLERY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schr-gallery-test-'));
  fs.cpSync(GALLERY_ROOT, root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function readManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
}

function writeManifest(root, manifest) {
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function expectFailure(root, pattern) {
  assert.throws(
    () => validateGallery(root),
    (error) => error instanceof GalleryValidationError && pattern.test(error.message),
  );
}

test('accepts the published baseline catalog', () => {
  const result = validateGallery(GALLERY_ROOT);
  assert.equal(result.itemCount, 20);
});

test('rejects duplicate ids', (t) => {
  const root = fixture(t);
  const manifest = readManifest(root);
  manifest.items.push({ ...manifest.items[0] });
  writeManifest(root, manifest);
  expectFailure(root, /duplicate Gallery id: draw-cube-cube/);
});

test('rejects an id prefix that disagrees with kind', (t) => {
  const root = fixture(t);
  const manifest = readManifest(root);
  manifest.items[0].kind = 'recording';
  writeManifest(root, manifest);
  expectFailure(root, /id prefix does not match kind recording/);
});

test('rejects missing payloads', (t) => {
  const root = fixture(t);
  const manifest = readManifest(root);
  fs.rmSync(path.join(root, manifest.items[0].file));
  expectFailure(root, /payload is missing/);
});

test('rejects mismatched byte counts', (t) => {
  const root = fixture(t);
  const manifest = readManifest(root);
  manifest.items[0].bytes += 1;
  writeManifest(root, manifest);
  expectFailure(root, /bytes mismatch/);
});

test('rejects undecodable PNG thumbnails', (t) => {
  const root = fixture(t);
  const manifest = readManifest(root);
  fs.writeFileSync(path.join(root, manifest.items[0].thumbnail), 'not a png');
  expectFailure(root, /not a decodable PNG under cap/);
});

test('rejects oversized payloads before JSON parsing', (t) => {
  const root = fixture(t);
  const manifest = readManifest(root);
  const item = manifest.items[0];
  fs.writeFileSync(path.join(root, item.file), Buffer.alloc(DEFAULT_CAPS.maxPayloadBytes + 1, 0x20));
  item.bytes = DEFAULT_CAPS.maxPayloadBytes + 1;
  writeManifest(root, manifest);
  expectFailure(root, /exceeds payload cap/);
});

test('rejects recordings over the event-count cap', (t) => {
  const root = fixture(t);
  const manifest = readManifest(root);
  const item = manifest.items.find((candidate) => candidate.kind === 'recording');
  const payloadPath = path.join(root, item.file);
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  payload.events = Array.from(
    { length: DEFAULT_CAPS.maxRecordingEvents + 1 },
    () => ({ type: 'UNDO', delay: 0 }),
  );
  const text = JSON.stringify(payload);
  fs.writeFileSync(payloadPath, text);
  item.bytes = Buffer.byteLength(text);
  writeManifest(root, manifest);
  expectFailure(root, /exceeds recording event cap/);
});

test('rejects entitlement fields outside the universal-access contract', (t) => {
  const root = fixture(t);
  const manifest = readManifest(root);
  manifest.items[0].requiresPro = false;
  writeManifest(root, manifest);
  expectFailure(root, /unexpected: requiresPro/);
});

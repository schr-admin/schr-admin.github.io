import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

export const DEFAULT_CAPS = Object.freeze({
  maxManifestBytes: 256_000,
  maxItems: 1_000,
  maxPayloadBytes: 1_000_000,
  maxThumbnailBytes: 512_000,
  maxThumbnailDimension: 1_024,
  maxRecordingEvents: 10_000,
  maxSnapshotElements: 100_000,
});

const DOCUMENT_KEYS = ['items', 'updated', 'version'];
const ITEM_KEYS = [
  'author',
  'bytes',
  'displayName',
  'file',
  'id',
  'kind',
  'origin',
  'publishedAt',
  'tags',
  'thumbnail',
];
const AUTHOR_KEYS = ['name', 'url'];
const ID_PATTERN = /^(draw|rec)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class GalleryValidationError extends Error {
  constructor(errors) {
    super(`Gallery validation failed:\n- ${errors.join('\n- ')}`);
    this.name = 'GalleryValidationError';
    this.errors = errors;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const allowed = new Set(expected);
  return actual.every((key) => allowed.has(key));
}

function isValidDate(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isValidDateTime(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function validateItemShape(item, index, errors, caps) {
  const label = `items[${index}]`;
  if (!isObject(item)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  if (!hasExactKeys(item, ITEM_KEYS)) {
    const unexpected = Object.keys(item).filter((key) => !ITEM_KEYS.includes(key));
    const missing = ITEM_KEYS.filter((key) => !(key in item));
    errors.push(`${label} has invalid fields (unexpected: ${unexpected.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`);
  }
  if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) {
    errors.push(`${label}.id is not a canonical draw-/rec- id`);
  }
  if (item.kind !== 'drawing' && item.kind !== 'recording') {
    errors.push(`${label}.kind must be drawing or recording`);
  } else if (typeof item.id === 'string') {
    const expectedPrefix = item.kind === 'drawing' ? 'draw-' : 'rec-';
    if (!item.id.startsWith(expectedPrefix)) {
      errors.push(`${label}.id prefix does not match kind ${item.kind}`);
    }
  }
  if (typeof item.displayName !== 'string' || item.displayName.length < 1 || item.displayName.length > 100) {
    errors.push(`${label}.displayName must contain 1-100 characters`);
  }
  if (!Number.isInteger(item.bytes) || item.bytes < 1) {
    errors.push(`${label}.bytes must be a positive integer`);
  } else if (item.bytes > caps.maxPayloadBytes) {
    errors.push(`${label}.bytes exceeds payload cap ${caps.maxPayloadBytes}`);
  }
  if (!Array.isArray(item.tags) || item.tags.length > 20
    || item.tags.some((tag) => typeof tag !== 'string' || tag.length > 40 || !TAG_PATTERN.test(tag))
    || new Set(item.tags).size !== item.tags.length) {
    errors.push(`${label}.tags must be unique canonical slugs (maximum 20)`);
  }
  if (item.origin !== 'official' && item.origin !== 'community') {
    errors.push(`${label}.origin must be official or community`);
  }
  if (!isObject(item.author) || !hasExactKeys(item.author, AUTHOR_KEYS)
    || typeof item.author.name !== 'string' || item.author.name.length < 1 || item.author.name.length > 100
    || ('url' in item.author && !isHttpUrl(item.author.url))) {
    errors.push(`${label}.author is invalid`);
  }
  if (!isValidDate(item.publishedAt)) {
    errors.push(`${label}.publishedAt must be YYYY-MM-DD`);
  }

  if (typeof item.id === 'string' && (item.kind === 'drawing' || item.kind === 'recording')) {
    const expectedFile = `items/${item.id}${item.kind === 'recording' ? '.rec' : ''}.schr`;
    const expectedThumbnail = `items/${item.id}.png`;
    if (item.file !== expectedFile) errors.push(`${label}.file must be ${expectedFile}`);
    if (item.thumbnail !== expectedThumbnail) errors.push(`${label}.thumbnail must be ${expectedThumbnail}`);
  }
  return true;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function decodePng(buffer, caps = DEFAULT_CAPS) {
  if (!Buffer.isBuffer(buffer) || buffer.length > caps.maxThumbnailBytes) {
    throw new Error(`PNG exceeds thumbnail cap ${caps.maxThumbnailBytes}`);
  }
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('invalid PNG signature');
  }

  let offset = 8;
  let ihdr = null;
  let paletteFound = false;
  let ended = false;
  const idat = [];

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error('truncated PNG chunk');
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (crcOffset + 4 > buffer.length) throw new Error('truncated PNG chunk data');

    const typeBuffer = buffer.subarray(typeStart, dataStart);
    const type = typeBuffer.toString('ascii');
    const data = buffer.subarray(dataStart, dataEnd);
    const expectedCrc = buffer.readUInt32BE(crcOffset);
    const actualCrc = crc32(Buffer.concat([typeBuffer, data]));
    if (actualCrc !== expectedCrc) throw new Error(`invalid ${type} chunk checksum`);

    if (type === 'IHDR') {
      if (ihdr || length !== 13) throw new Error('invalid IHDR chunk');
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      paletteFound = true;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error('invalid IEND chunk');
      ended = true;
      offset = crcOffset + 4;
      break;
    }
    offset = crcOffset + 4;
  }

  if (!ihdr || !ended || idat.length === 0 || offset !== buffer.length) {
    throw new Error('incomplete PNG structure');
  }
  if (ihdr.width < 1 || ihdr.height < 1
    || ihdr.width > caps.maxThumbnailDimension || ihdr.height > caps.maxThumbnailDimension) {
    throw new Error(`PNG dimensions exceed ${caps.maxThumbnailDimension}`);
  }
  if (ihdr.compression !== 0 || ihdr.filter !== 0 || ihdr.interlace !== 0) {
    throw new Error('unsupported PNG encoding');
  }

  const channelsByColorType = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
  const channels = channelsByColorType.get(ihdr.colorType);
  const allowedDepths = new Map([
    [0, new Set([1, 2, 4, 8, 16])],
    [2, new Set([8, 16])],
    [3, new Set([1, 2, 4, 8])],
    [4, new Set([8, 16])],
    [6, new Set([8, 16])],
  ]);
  if (!channels || !allowedDepths.get(ihdr.colorType)?.has(ihdr.bitDepth)) {
    throw new Error('unsupported PNG color format');
  }
  if (ihdr.colorType === 3 && !paletteFound) throw new Error('indexed PNG has no palette');

  const decoded = inflateSync(Buffer.concat(idat), {
    maxOutputLength: (Math.ceil(ihdr.width * channels * ihdr.bitDepth / 8) + 1) * ihdr.height,
  });
  const rowBytes = Math.ceil(ihdr.width * channels * ihdr.bitDepth / 8);
  if (decoded.length !== (rowBytes + 1) * ihdr.height) throw new Error('invalid decoded PNG size');
  for (let row = 0; row < ihdr.height; row += 1) {
    if (decoded[row * (rowBytes + 1)] > 4) throw new Error('invalid PNG row filter');
  }
  return { width: ihdr.width, height: ihdr.height };
}

function validateSchr(buffer, kind, label, errors, caps) {
  if (buffer.length > caps.maxPayloadBytes) {
    errors.push(`${label} exceeds payload cap ${caps.maxPayloadBytes}`);
    return;
  }

  let document;
  try {
    document = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return;
  }
  if (!isObject(document) || !isObject(document.header)) {
    errors.push(`${label} has no valid document header`);
    return;
  }

  if (kind === 'drawing') {
    if (document.header.contentType !== 'snapshot'
      || !Array.isArray(document.cubes) || !Array.isArray(document.lines)) {
      errors.push(`${label} is not a snapshot document`);
      return;
    }
    if (document.cubes.length + document.lines.length > caps.maxSnapshotElements) {
      errors.push(`${label} exceeds snapshot element cap ${caps.maxSnapshotElements}`);
    }
    return;
  }

  if (document.header.contentType !== 'streaming'
    || !Array.isArray(document.events) || !Array.isArray(document.palette)) {
    errors.push(`${label} is not a recording document`);
    return;
  }
  if (document.events.length > caps.maxRecordingEvents) {
    errors.push(`${label} exceeds recording event cap ${caps.maxRecordingEvents}`);
    return;
  }
  for (const [index, event] of document.events.entries()) {
    if (!isObject(event) || typeof event.type !== 'string'
      || ('delay' in event && (!Number.isFinite(event.delay) || event.delay < 0))) {
      errors.push(`${label} has invalid event at index ${index}`);
      break;
    }
  }
}

export function validateGallery(rootDirectory, options = {}) {
  const caps = Object.freeze({ ...DEFAULT_CAPS, ...options });
  const errors = [];
  const manifestPath = path.resolve(rootDirectory, 'manifest.json');

  let manifestBuffer;
  try {
    manifestBuffer = fs.readFileSync(manifestPath);
  } catch (error) {
    throw new GalleryValidationError([`manifest.json cannot be read: ${error.message}`]);
  }
  if (manifestBuffer.length > caps.maxManifestBytes) {
    throw new GalleryValidationError([`manifest.json exceeds cap ${caps.maxManifestBytes}`]);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8'));
  } catch (error) {
    throw new GalleryValidationError([`manifest.json is not valid JSON: ${error.message}`]);
  }

  if (!isObject(manifest) || !hasExactKeys(manifest, DOCUMENT_KEYS)) {
    errors.push('manifest must contain only version, updated, and items');
  }
  if (manifest?.version !== 1) errors.push('manifest.version must be 1');
  if (!isValidDateTime(manifest?.updated)) errors.push('manifest.updated must be an ISO UTC date-time');
  if (!Array.isArray(manifest?.items)) {
    errors.push('manifest.items must be an array');
  } else if (manifest.items.length > caps.maxItems) {
    errors.push(`manifest.items exceeds cap ${caps.maxItems}`);
  }

  const ids = new Set();
  const expectedItemFiles = new Set();
  for (const [index, item] of (Array.isArray(manifest?.items) ? manifest.items : []).entries()) {
    const shapeUsable = validateItemShape(item, index, errors, caps);
    if (!shapeUsable || typeof item.id !== 'string') continue;
    if (ids.has(item.id)) errors.push(`duplicate Gallery id: ${item.id}`);
    ids.add(item.id);

    if (typeof item.file !== 'string' || typeof item.thumbnail !== 'string') continue;
    expectedItemFiles.add(item.file);
    expectedItemFiles.add(item.thumbnail);

    const payloadPath = path.resolve(rootDirectory, item.file);
    const thumbnailPath = path.resolve(rootDirectory, item.thumbnail);
    const itemsRoot = `${path.resolve(rootDirectory, 'items')}${path.sep}`;
    if (!payloadPath.startsWith(itemsRoot) || !thumbnailPath.startsWith(itemsRoot)) {
      errors.push(`${item.id} asset path escapes items/`);
      continue;
    }

    let payload;
    try {
      payload = fs.readFileSync(payloadPath);
    } catch {
      errors.push(`${item.id} payload is missing: ${item.file}`);
    }
    if (payload) {
      if (payload.length !== item.bytes) {
        errors.push(`${item.id} bytes mismatch: manifest ${item.bytes}, actual ${payload.length}`);
      }
      validateSchr(payload, item.kind, item.file, errors, caps);
    }

    let thumbnail;
    try {
      thumbnail = fs.readFileSync(thumbnailPath);
    } catch {
      errors.push(`${item.id} thumbnail is missing: ${item.thumbnail}`);
    }
    if (thumbnail) {
      try {
        decodePng(thumbnail, caps);
      } catch (error) {
        errors.push(`${item.thumbnail} is not a decodable PNG under cap: ${error.message}`);
      }
    }
  }

  const itemsDirectory = path.resolve(rootDirectory, 'items');
  if (fs.existsSync(itemsDirectory)) {
    for (const filename of fs.readdirSync(itemsDirectory)) {
      const relative = `items/${filename}`;
      if (!expectedItemFiles.has(relative)) errors.push(`unlisted Gallery asset: ${relative}`);
    }
  }

  if (errors.length > 0) throw new GalleryValidationError(errors);
  return { itemCount: manifest.items.length, manifest };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const root = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const result = validateGallery(root);
    console.log(`Gallery valid: ${result.itemCount} items`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

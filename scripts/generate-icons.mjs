/**
 * Draws the toolbar icons from the same mark the interface header uses.
 *
 * Without a declared icon Chrome falls back to the first letter of the localized extension name,
 * which reads as a different glyph in every locale. The mark is a geometric "T" so it carries no
 * language, and it is generated here rather than checked in as a binary blob nobody can diff.
 *
 * Run: node scripts/generate-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;
const BACKGROUND = [255, 56, 92];
const FOREGROUND = [255, 255, 255];
const outputDirectory = new URL('../public/icons/', import.meta.url);

// Proportions of the square, so every size keeps the same silhouette.
const CORNER_RADIUS = 0.22;
const BAR_WIDTH = 0.56;
const BAR_HEIGHT = 0.15;
const BAR_TOP = 0.26;
const STEM_WIDTH = 0.17;
const STEM_BOTTOM = 0.76;

function isInsideRoundedSquare(x, y, size) {
  const radius = size * CORNER_RADIUS;
  const nearestX = Math.min(Math.max(x, radius), size - radius);
  const nearestY = Math.min(Math.max(y, radius), size - radius);
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function isInsideLetter(x, y, size) {
  const barLeft = size * (0.5 - BAR_WIDTH / 2);
  const barRight = size * (0.5 + BAR_WIDTH / 2);
  const barTop = size * BAR_TOP;
  const barBottom = barTop + size * BAR_HEIGHT;
  if (x >= barLeft && x <= barRight && y >= barTop && y <= barBottom) return true;

  const stemLeft = size * (0.5 - STEM_WIDTH / 2);
  const stemRight = size * (0.5 + STEM_WIDTH / 2);
  return x >= stemLeft && x <= stemRight && y >= barTop && y <= size * STEM_BOTTOM;
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inside = 0;
      let letter = 0;
      for (let sampleY = 0; sampleY < SUPERSAMPLE; sampleY += 1) {
        for (let sampleX = 0; sampleX < SUPERSAMPLE; sampleX += 1) {
          const sx = x + (sampleX + 0.5) * step;
          const sy = y + (sampleY + 0.5) * step;
          if (!isInsideRoundedSquare(sx, sy, size)) continue;
          inside += 1;
          if (isInsideLetter(sx, sy, size)) letter += 1;
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const coverage = inside / samples;
      const letterRatio = inside === 0 ? 0 : letter / inside;
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(
          BACKGROUND[channel] * (1 - letterRatio) + FOREGROUND[channel] * letterRatio,
        );
      }
      pixels[offset + 3] = Math.round(coverage * 255);
    }
  }
  return pixels;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, checksum]);
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolor with alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // no per-row filter
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(outputDirectory, { recursive: true });
for (const size of SIZES) {
  const file = new URL(`icon-${size}.png`, outputDirectory);
  await writeFile(file, encodePng(renderIcon(size), size));
  console.log(`wrote public/icons/icon-${size}.png`);
}

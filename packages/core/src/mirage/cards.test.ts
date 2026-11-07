// SPDX-License-Identifier: MIT
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeSchema, type CardItem } from '@wordedits/shared';
import { describe, expect, it } from 'vitest';
import { cardImageFile, cardImagesFor, jpegOrientation, jpegSize } from './cards.js';

/** A JPEG's start with an APP1 Exif segment whose IFD0 holds `entries` (tag, type, value), in `order` byte order. */
function jpegWith(entries: [number, number, number][], o: { order?: 'II' | 'MM'; app0?: boolean } = {}): Buffer {
  const le = o.order === 'II';
  const u16 = (n: number) => { const b = Buffer.alloc(2); if (le) b.writeUInt16LE(n); else b.writeUInt16BE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); if (le) b.writeUInt32LE(n); else b.writeUInt32BE(n); return b; };
  const ifd = Buffer.concat([u16(entries.length), ...entries.map(([tag, type, v]) => Buffer.concat([u16(tag), u16(type), u32(1), u16(v), u16(0)])), u32(0)]);
  const tiff = Buffer.concat([Buffer.from(le ? 'II' : 'MM', 'latin1'), u16(42), u32(8), ifd]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  const app0 = o.app0 ? Buffer.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([0xff, 0xe1]), len, payload, Buffer.from([0xff, 0xda, 0, 2])]);
}

describe('jpegOrientation', () => {
  it('reads EXIF orientation (tag 0x0112) in either byte order, after a JFIF segment, among other tags', () => {
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8]) expect(jpegOrientation(jpegWith([[0x0112, 3, v]]))).toBe(v);
    expect(jpegOrientation(jpegWith([[0x0112, 3, 6]], { order: 'II' }))).toBe(6);
    expect(jpegOrientation(jpegWith([[0x010f, 3, 9], [0x0112, 3, 8]], { app0: true }))).toBe(8);
  });

  it('is 1 (as stored) without the tag, with a value outside 1–8, or for bytes that are not a JPEG with EXIF', () => {
    expect(jpegOrientation(jpegWith([[0x010f, 3, 6]]))).toBe(1);
    expect(jpegOrientation(jpegWith([[0x0112, 3, 9]]))).toBe(1);
    expect(jpegOrientation(jpegWith([[0x0112, 3, 0]]))).toBe(1);
    expect(jpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xda]))).toBe(1);
    expect(jpegOrientation(Buffer.from('not a jpeg'))).toBe(1);
    // Cut short anywhere: no throw.
    const full = jpegWith([[0x0112, 3, 6]]);
    for (let n = 0; n < full.length; n++) expect(() => jpegOrientation(full.subarray(0, n))).not.toThrow();
    // An IFD said to be past the segment, or one whose entries run past it before the tag.
    const far = Buffer.from(full);
    far.writeUInt32BE(0x7fff, 2 + 2 + 2 + 6 + 4);
    expect(jpegOrientation(far)).toBe(1);
    const lying = jpegWith([[0x010f, 3, 1]]);
    lying.writeUInt16BE(500, 2 + 2 + 2 + 6 + 8);
    expect(jpegOrientation(lying)).toBe(1);
  });
});

/** A segment: marker, then its 2-byte length (which counts itself) and `payload`. */
const segment = (marker: number, payload: Buffer) => {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
};
/** A JPEG's headers: `before` segments, then a frame header (SOF `sof`) for `w` × `h`, then the start of the image data. */
const jpegOf = (w: number, h: number, before: Buffer[] = [], sof = 0xc0) => {
  const frame = Buffer.from([8, 0, 0, 0, 0, 3]);
  frame.writeUInt16BE(h, 1);
  frame.writeUInt16BE(w, 3);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...before, segment(0xc4, Buffer.alloc(20)), segment(sof, frame), Buffer.from([0xff, 0xda, 0, 2])]);
};
/** A PNG's signature and IHDR chunk for `w` × `h` (enough for its header to be read). */
const pngOf = (w: number, h: number) => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
};
const reader = (b: Buffer) => (at: number, n: number) => b.subarray(at, at + n);

describe('jpegSize', () => {
  it('reads the size from the frame header, past other segments, for baseline and progressive JPEGs', () => {
    expect(jpegSize(reader(jpegOf(6000, 4000)))).toEqual([6000, 4000]);
    expect(jpegSize(reader(jpegOf(4032, 3024, [segment(0xe0, Buffer.alloc(14)), segment(0xe1, Buffer.alloc(3000))], 0xc2)))).toEqual([4032, 3024]);
  });

  it('is null with no frame header before the image data, for bytes that are not a JPEG, or cut short anywhere', () => {
    expect(jpegSize(reader(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])))).toBeNull();
    expect(jpegSize(reader(Buffer.from('not a jpeg')))).toBeNull();
    const full = jpegOf(800, 600, [segment(0xe0, Buffer.alloc(14))]);
    // The frame header is 10 bytes before the image data, and its first 9 hold the size.
    for (let n = 0; n <= full.length - 6; n++) expect(jpegSize(reader(full.subarray(0, n)))).toBeNull();
  });
});

describe('cardImagesFor', () => {
  const ep = (image: string) => EpisodeSchema.parse({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items: [{ id: 'p', beat: 'title', card: { style: 'image', image, sec: 1 } }] });
  const project = mkdtempSync(join(tmpdir(), 'we-card-images-'));
  mkdirSync(join(project, 'photos', 'trip'), { recursive: true });

  it('reads the size of a PNG and of a JPEG from their headers, a JPEG whose frame header is far into the file too', () => {
    writeFileSync(join(project, 'photos', 'big.png'), pngOf(6000, 4000));
    writeFileSync(join(project, 'photos', 'small.jpg'), jpegOf(640, 480));
    // ICC profiles and thumbnails before the frame header: past the first 128 KB read for the EXIF.
    writeFileSync(join(project, 'photos', 'far.jpg'), jpegOf(5712, 4284, [segment(0xe1, Buffer.alloc(60_000)), segment(0xe2, Buffer.alloc(65_000)), segment(0xe2, Buffer.alloc(65_000))]));
    expect(cardImagesFor(project, ep('photos/big.png')).get('p')).toMatchObject({ format: 'png', width: 6000, height: 4000 });
    expect(cardImagesFor(project, ep('photos/small.jpg')).get('p')).toMatchObject({ format: 'jpeg', orientation: 1, width: 640, height: 480 });
    expect(cardImagesFor(project, ep('photos/far.jpg')).get('p')).toMatchObject({ format: 'jpeg', width: 5712, height: 4284 });
    // No frame header: still a JPEG (FFmpeg has the last word), of unknown size.
    writeFileSync(join(project, 'photos', 'odd.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]));
    expect(cardImagesFor(project, ep('photos/odd.jpg')).get('p')).toMatchObject({ format: 'jpeg', width: 0, height: 0 });
  });

  it('takes a backslash as a folder separator, so a path written on Windows is found everywhere', () => {
    writeFileSync(join(project, 'photos', 'trip', 'pic.jpg'), jpegOf(800, 600));
    const e = ep('photos\\trip\\pic.jpg');
    expect(cardImageFile(project, e.items[0] as CardItem)).toBe(join(project, 'photos', 'trip', 'pic.jpg'));
    expect(cardImagesFor(project, e).get('p')).toMatchObject({ path: join(project, 'photos', 'trip', 'pic.jpg'), format: 'jpeg', width: 800, height: 600 });
  });
});

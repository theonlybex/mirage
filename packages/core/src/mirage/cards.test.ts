// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { jpegOrientation } from './cards.js';

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

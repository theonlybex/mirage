// SPDX-License-Identifier: MIT
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isCard, type CardItem, type Episode } from '@wordedits/shared';
import { MirageError } from './errors.js';

/** What a card shows, in a few words: its text (the first line), else its picture's file name. */
export function cardLabel(item: CardItem): string {
  const text = item.card.text.trim().split('\n')[0]!.trim();
  return text || (item.card.image ?? '').split(/[\\/]/).pop()!;
}

const CARD_IMAGE_HINT = "Put the picture in the project folder, or change the card's image.";

/** The first bytes of a PNG (its signature) and of a JPEG (start of image, then a marker). */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

/** How much of a JPEG is read for its EXIF: the APP1 segment is at most 64 KB and comes near the start. */
const HEAD_BYTES = 128 * 1024;

/**
 * A JPEG's EXIF orientation (TIFF tag 0x0112 in IFD0 of its APP1 "Exif" segment), 1–8: how the stored picture is turned
 * or mirrored from upright (phones store photos as the sensor saw them and set this). 1 (as stored) when there is no
 * such tag, or anything about it doesn't add up.
 */
export function jpegOrientation(b: Buffer): number {
  try {
    if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
    let pos = 2;
    while (pos + 4 <= b.length) {
      if (b[pos] !== 0xff) return 1;
      const marker = b[pos + 1]!;
      if (marker === 0xff) {
        pos += 1; // fill byte
        continue;
      }
      // Start of scan or end of image: the headers are over. Restart and TEM markers have no length.
      if (marker === 0xda || marker === 0xd9) return 1;
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        pos += 2;
        continue;
      }
      const len = b.readUInt16BE(pos + 2);
      const end = pos + 2 + len;
      if (marker === 0xe1 && len >= 8 && b.toString('latin1', pos + 4, pos + 10) === 'Exif\0\0') {
        const t = pos + 10;
        const order = b.toString('latin1', t, t + 2);
        if (order !== 'II' && order !== 'MM') return 1;
        const le = order === 'II';
        const u16 = (at: number) => {
          if (at + 2 > end) throw new RangeError('past the segment');
          return le ? b.readUInt16LE(at) : b.readUInt16BE(at);
        };
        const u32 = (at: number) => {
          if (at + 4 > end) throw new RangeError('past the segment');
          return le ? b.readUInt32LE(at) : b.readUInt32BE(at);
        };
        if (u16(t + 2) !== 42) return 1;
        const ifd = t + u32(t + 4);
        const count = u16(ifd);
        for (let i = 0; i < count; i++) {
          const entry = ifd + 2 + i * 12;
          if (u16(entry) !== 0x0112) continue;
          // A SHORT, held in the first two bytes of the value field.
          const v = u16(entry + 2) === 3 ? u16(entry + 8) : 0;
          return v >= 1 && v <= 8 ? v : 1;
        }
        return 1;
      }
      pos = end;
    }
    return 1;
  } catch {
    return 1;
  }
}

/**
 * What the file is by its first bytes, whatever its name ends in: a PNG, a JPEG (with its EXIF orientation), or neither
 * (also when it can't be read).
 */
function imageFormat(file: string): { format: 'png' | 'jpeg'; orientation: number } | null {
  const head = Buffer.alloc(HEAD_BYTES);
  let n = 0;
  try {
    const fd = openSync(file, 'r');
    try {
      n = readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    // There but unreadable (no permission, a file the system holds): it can't be drawn either.
    return null;
  }
  const starts = (sig: number[]) => n >= sig.length && sig.every((b, i) => head[i] === b);
  if (starts(PNG)) return { format: 'png', orientation: 1 };
  if (starts(JPEG)) return { format: 'jpeg', orientation: jpegOrientation(head.subarray(0, n)) };
  return null;
}

/** Where an image card's picture is on disk (the schema keeps `image` a plain path inside the project). */
export const cardImageFile = (project: string, item: CardItem): string => resolve(project, item.card.image!);

/** An image card's picture: its file, what it is (FFmpeg reads it as that, whatever its name says) and how it is turned. */
export interface CardImage {
  path: string;
  format: 'png' | 'jpeg';
  /** EXIF orientation 1–8 (default 1, as stored): the render turns the picture upright from it. */
  orientation?: number;
}

/**
 * The picture of each image card, by item id. Throws for the first whose picture is missing (or a folder), or isn't a
 * PNG or JPEG by its content (or can't be read).
 */
export function cardImagesFor(project: string, ep: Episode): Map<string, CardImage> {
  const out = new Map<string, CardImage>();
  for (const item of ep.items) {
    if (!isCard(item) || item.card.style !== 'image') continue;
    const file = cardImageFile(project, item);
    const isFile = (() => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })();
    if (!isFile) throw new MirageError('BAD_ITEM', `item ${item.id}: card image ${item.card.image} is missing`, CARD_IMAGE_HINT);
    const image = imageFormat(file);
    if (!image) throw new MirageError('BAD_ITEM', `item ${item.id}: card image ${item.card.image} isn't a PNG or JPEG`, CARD_IMAGE_HINT);
    out.set(item.id, { path: file, ...image });
  }
  return out;
}

/** Throws for the first image card whose picture is missing, or isn't a PNG or JPEG (by its content). */
export function checkCardImages(project: string, ep: Episode): void {
  cardImagesFor(project, ep);
}

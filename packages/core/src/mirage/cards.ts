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

/** What the file is by its first bytes, whatever its name ends in: a PNG, a JPEG, or neither (also when it can't be read). */
function imageFormat(file: string): 'png' | 'jpeg' | null {
  const head = Buffer.alloc(PNG.length);
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
  return starts(PNG) ? 'png' : starts(JPEG) ? 'jpeg' : null;
}

/** Where an image card's picture is on disk (the schema keeps `image` a plain path inside the project). */
export const cardImageFile = (project: string, item: CardItem): string => resolve(project, item.card.image!);

/** An image card's picture: its file, and what it is (FFmpeg reads it as that, whatever its name says). */
export interface CardImage {
  path: string;
  format: 'png' | 'jpeg';
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
    const format = imageFormat(file);
    if (!format) throw new MirageError('BAD_ITEM', `item ${item.id}: card image ${item.card.image} isn't a PNG or JPEG`, CARD_IMAGE_HINT);
    out.set(item.id, { path: file, format });
  }
  return out;
}

/** Throws for the first image card whose picture is missing, or isn't a PNG or JPEG (by its content). */
export function checkCardImages(project: string, ep: Episode): void {
  cardImagesFor(project, ep);
}

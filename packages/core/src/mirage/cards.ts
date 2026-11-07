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

/** True when the file starts like a PNG or a JPEG: told by its content, whatever its name ends in. */
function pngOrJpeg(file: string): boolean {
  const head = Buffer.alloc(PNG.length);
  const fd = openSync(file, 'r');
  try {
    const n = readSync(fd, head, 0, head.length, 0);
    const starts = (sig: number[]) => n >= sig.length && sig.every((b, i) => head[i] === b);
    return starts(PNG) || starts(JPEG);
  } finally {
    closeSync(fd);
  }
}

/** Where an image card's picture is on disk (the schema keeps `image` a plain path inside the project). */
export const cardImageFile = (project: string, item: CardItem): string => resolve(project, item.card.image!);

/** Throws for the first image card whose picture is missing, or isn't a PNG or JPEG (by its content). */
export function checkCardImages(project: string, ep: Episode): void {
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
    if (!pngOrJpeg(file)) throw new MirageError('BAD_ITEM', `item ${item.id}: card image ${item.card.image} isn't a PNG or JPEG`, CARD_IMAGE_HINT);
  }
}

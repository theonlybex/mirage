// SPDX-License-Identifier: AGPL-3.0-or-later
// A small streaming reader for multipart/form-data with short text fields and at most one file, which goes straight to
// disk (never whole into memory). Enough for the page's own uploads; not a general-purpose parser.
import { createWriteStream, type WriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { HttpError } from './http-error.js';

export type MultipartFile = { name: string; path: string; size: number };
export type MultipartResult = { fields: Record<string, string>; file: MultipartFile | null };

type Options = {
  /** The most bytes the file may have (413 past it). */
  fileLimit: number;
  /** Where the file is written, decided from the fields before it and its name. Throw to refuse it. */
  open: (fields: Record<string, string>, filename: string) => Promise<string>;
};

const FIELD_LIMIT = 1024;
const HEADERS_LIMIT = 8 * 1024;
const PREAMBLE_LIMIT = 1024;
const HEADERS_END = Buffer.from('\r\n\r\n');

const bad = (message = 'The upload is not valid form data.') => new HttpError(400, message);

/** The boundary of a `multipart/form-data; boundary=…` content type, or null when it is not one. */
export function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType)) return null;
  const m = /;\s*boundary=(?:"([^"]{1,70})"|([^;\s"]{1,70}))/i.exec(contentType);
  return m ? (m[1] ?? m[2]!) : null;
}

/** `name` and `filename` from a part's Content-Disposition (quoted forms only, with \" escapes). */
function disposition(headers: string): { name: string; filename: string | null } {
  const line = headers.split('\r\n').find((l) => /^content-disposition\s*:/i.test(l));
  if (!line || !/:\s*form-data\s*(;|$)/i.test(line)) throw bad();
  const param = (key: string) => {
    const m = new RegExp(`;\\s*${key}="((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(line);
    // Browsers write " CR LF in names as %22 %0D %0A (the HTML form encoding); others may use backslash escapes.
    return m ? m[1]!.replace(/\\(.)/g, '$1').replace(/%22/g, '"').replace(/%0D/gi, '\r').replace(/%0A/gi, '\n') : null;
  };
  const name = param('name');
  if (name === null) throw bad();
  return { name, filename: param('filename') };
}

/**
 * Reads a multipart body from `body`: text fields up to 1 KB each, and one file part streamed to the path `o.open` gives.
 * A cut-off body, a second file or a file past `o.fileLimit` throws (and removes what was written).
 */
export async function readMultipart(body: AsyncIterable<Buffer | Uint8Array>, boundary: string, o: Options): Promise<MultipartResult> {
  const dash = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const fields: Record<string, string> = {};
  let file: MultipartFile | null = null;
  let state: 'preamble' | 'after-boundary' | 'headers' | 'body' | 'done' = 'preamble';
  let seen = 0;
  let buf = Buffer.alloc(0);
  let part: { name: string; chunks: Buffer[]; size: number } | null = null;
  let out: WriteStream | null = null;
  let failed: Error | null = null;

  const write = async (data: Buffer) => {
    if (!data.length) return;
    if (out && file) {
      file.size += data.length;
      if (file.size > o.fileLimit) throw new HttpError(413, 'That is too large.');
      if (failed) throw failed;
      if (!out.write(data)) await Promise.race([once(out, 'drain'), once(out, 'error')]);
      if (failed) throw failed;
    } else if (part) {
      part.size += data.length;
      if (part.size > FIELD_LIMIT) throw bad(`The field “${part.name}” is too long.`);
      part.chunks.push(Buffer.from(data));
    }
  };
  const endPart = async () => {
    if (out) {
      out.end();
      await finished(out);
      out = null;
    } else if (part) {
      fields[part.name] = Buffer.concat(part.chunks).toString('utf8');
    }
    part = null;
  };

  /** Moves through what is buffered as far as it can; false when it needs more bytes. */
  const step = async (): Promise<boolean> => {
    switch (state) {
      case 'preamble': {
        const i = buf.indexOf(dash);
        if (i < 0) {
          seen += Math.max(0, buf.length - dash.length);
          if (seen > PREAMBLE_LIMIT) throw bad();
          buf = buf.subarray(Math.max(0, buf.length - dash.length));
          return false;
        }
        buf = buf.subarray(i + dash.length);
        state = 'after-boundary';
        return true;
      }
      case 'after-boundary': {
        if (buf.length < 2) return false;
        const two = buf.subarray(0, 2).toString('latin1');
        buf = buf.subarray(2);
        if (two === '--') state = 'done';
        else if (two === '\r\n') state = 'headers';
        else throw bad();
        return true;
      }
      case 'headers': {
        const i = buf.indexOf(HEADERS_END);
        if (i < 0) {
          if (buf.length > HEADERS_LIMIT) throw bad();
          return false;
        }
        const { name, filename } = disposition(buf.subarray(0, i).toString('utf8'));
        buf = buf.subarray(i + HEADERS_END.length);
        part = { name, chunks: [], size: 0 };
        if (filename !== null) {
          if (file) throw bad('Send one file at a time.');
          const path = await o.open({ ...fields }, filename);
          file = { name: filename, path, size: 0 };
          out = createWriteStream(path, { flags: 'wx' });
          out.on('error', (e) => (failed = e));
        }
        state = 'body';
        return true;
      }
      case 'body': {
        const i = buf.indexOf(delimiter);
        if (i < 0) {
          // Keep enough of the end to find a delimiter that straddles two chunks.
          const safe = buf.length - (delimiter.length - 1);
          if (safe > 0) {
            await write(buf.subarray(0, safe));
            buf = buf.subarray(safe);
          }
          return false;
        }
        await write(buf.subarray(0, i));
        buf = buf.subarray(i + delimiter.length);
        await endPart();
        state = 'after-boundary';
        return true;
      }
      case 'done':
        buf = Buffer.alloc(0);
        return false;
    }
  };

  try {
    for await (const chunk of body) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      while (await step());
    }
    // (`state` moves inside step(), which the compiler does not follow.)
    if ((state as string) !== 'done') throw bad('The upload was cut off.');
    return { fields, file };
  } catch (e) {
    const open = out as WriteStream | null;
    if (open) {
      open.destroy();
      await finished(open).catch(() => {});
    }
    if (file) await rm((file as MultipartFile).path, { force: true });
    throw e;
  }
}

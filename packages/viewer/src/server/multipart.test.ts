// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { multipartBoundary, readMultipart } from './multipart.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mirage-multipart-'));
});

/** What a browser's FormData encodes to, cut into chunks of `size` bytes. */
async function encode(form: FormData, size: number): Promise<{ chunks: Buffer[]; boundary: string }> {
  const req = new Request('http://x/', { method: 'POST', body: form });
  const boundary = multipartBoundary(req.headers.get('content-type') ?? '')!;
  const all = Buffer.from(await req.arrayBuffer());
  const chunks: Buffer[] = [];
  for (let i = 0; i < all.length; i += size) chunks.push(all.subarray(i, i + size));
  return { chunks, boundary };
}
async function* stream(chunks: Buffer[]) {
  for (const c of chunks) yield c;
}
const open = async (_f: Record<string, string>, _name: string) => join(dir, 'upload');

// Bytes full of things that look like a boundary.
const BYTES = Buffer.concat([Buffer.from('\r\n--\r\n----\r\n'), Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7919) % 256)), Buffer.from('\r\n-')]);

describe('multipartBoundary', () => {
  it('reads the boundary of form data only', () => {
    expect(multipartBoundary('multipart/form-data; boundary=abc')).toBe('abc');
    expect(multipartBoundary('multipart/form-data; boundary="a b"')).toBe('a b');
    expect(multipartBoundary('application/json')).toBeNull();
    expect(multipartBoundary(undefined)).toBeNull();
  });
});

describe('readMultipart', () => {
  it('keeps the fields and streams the file to disk, whatever the chunk size', async () => {
    for (const size of [1, 7, 69, 4096, 1 << 20]) {
      const form = new FormData();
      form.append('video', '3');
      form.append('file', new Blob([BYTES]), 'my "take".m4a');
      const { chunks, boundary } = await encode(form, size);
      const seen: unknown[] = [];
      const r = await readMultipart(stream(chunks), boundary, {
        fileLimit: 1 << 20,
        open: async (fields, name) => {
          seen.push({ fields, name });
          return join(dir, `upload-${size}`);
        },
      });
      expect(seen).toEqual([{ fields: { video: '3' }, name: 'my "take".m4a' }]);
      expect(r.fields).toEqual({ video: '3' });
      expect(r.file).toEqual({ name: 'my "take".m4a', path: join(dir, `upload-${size}`), size: BYTES.length });
      expect((await readFile(join(dir, `upload-${size}`))).equals(BYTES), `chunk size ${size}`).toBe(true);
    }
  });

  it('waits for the disk without piling up listeners on a big file', async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on('warning', onWarning);
    try {
      const big = Buffer.from(Array.from({ length: 3 << 20 }, (_, i) => (i * 131) % 256));
      const form = new FormData();
      form.append('file', new Blob([big]), 'big.m4a');
      const { chunks, boundary } = await encode(form, 4096);
      let out: WriteStream | null = null;
      let drains = 0;
      const errorListeners: number[] = [];
      async function* watched() {
        for (const c of chunks) {
          if (out) errorListeners.push(out.listenerCount('error'));
          yield c;
        }
      }
      const r = await readMultipart(watched(), boundary, {
        fileLimit: 4 << 20,
        open,
        onFileStream: (s) => {
          out = s;
          s.on('drain', () => drains++);
        },
      });
      expect(r.file?.size).toBe(big.length);
      expect((await readFile(join(dir, 'upload'))).equals(big)).toBe(true);
      expect(drains).toBeGreaterThan(20);
      expect(Math.max(...errorListeners)).toBe(1);
      await new Promise((ok) => setImmediate(ok));
      expect(warnings.map((w) => w.name)).not.toContain('MaxListenersExceededWarning');
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('refuses a file past the limit with 413 and removes what it wrote', async () => {
    const form = new FormData();
    form.append('file', new Blob([BYTES]), 'big.m4a');
    const { chunks, boundary } = await encode(form, 1000);
    await expect(readMultipart(stream(chunks), boundary, { fileLimit: 10_000, open })).rejects.toMatchObject({ status: 413 });
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a cut-off body and removes the partial file', async () => {
    const form = new FormData();
    form.append('file', new Blob([BYTES]), 'a.m4a');
    const { chunks, boundary } = await encode(form, 1000);
    await expect(readMultipart(stream(chunks.slice(0, 20)), boundary, { fileLimit: 1 << 20, open })).rejects.toMatchObject({ status: 400, message: 'The upload was cut off.' });
    expect(existsSync(join(dir, 'upload'))).toBe(false);
  });

  it('refuses two files, an over-long field and garbage', async () => {
    const two = new FormData();
    two.append('file', new Blob(['a']), 'a.m4a');
    two.append('file2', new Blob(['b']), 'b.m4a');
    let e = await encode(two, 100);
    await expect(readMultipart(stream(e.chunks), e.boundary, { fileLimit: 100, open })).rejects.toMatchObject({ status: 400, message: 'Send one file at a time.' });
    expect(await readdir(dir)).toEqual([]);

    const long = new FormData();
    long.append('video', 'x'.repeat(2000));
    e = await encode(long, 100);
    await expect(readMultipart(stream(e.chunks), e.boundary, { fileLimit: 100, open })).rejects.toMatchObject({ status: 400 });

    await expect(readMultipart(stream([Buffer.from('x'.repeat(5000))]), 'b', { fileLimit: 100, open })).rejects.toMatchObject({ status: 400 });
    await expect(readMultipart(stream([Buffer.from('--b\r\nNo-Disposition: x\r\n\r\nhi\r\n--b--')]), 'b', { fileLimit: 100, open })).rejects.toMatchObject({ status: 400 });
  });

  it('passes on a refusal from open', async () => {
    const form = new FormData();
    form.append('file', new Blob(['a']), 'a.m4a');
    const { chunks, boundary } = await encode(form, 100);
    const refused = Object.assign(new Error('nope'), { status: 404 });
    await expect(readMultipart(stream(chunks), boundary, { fileLimit: 100, open: async () => Promise.reject(refused) })).rejects.toBe(refused);
  });
});

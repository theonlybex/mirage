// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleMedia, mediaPath } from './media.js';
import { CLIP_BYTES, makeProject, type TestProject } from './test-project.js';

let t: TestProject;
beforeAll(async () => {
  t = await makeProject();
});
const get = (abs: string, headers: Record<string, string> = {}, roots = [t.project, t.footage], method = 'GET') =>
  handleMedia(new Request(`http://127.0.0.1:1${mediaPath(abs)}?k=x`, { method, headers }), roots);

describe('mediaPath', () => {
  it('is /media/ and the encoded absolute path', () => {
    expect(mediaPath('/a b/c#d.mp4')).toBe('/media/%2Fa%20b%2Fc%23d.mp4');
  });
});

describe('handleMedia', () => {
  it('serves a whole file with its type, length and range support', async () => {
    const r = await get(join(t.project, 'clip.mp4'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(r.headers.get('content-length')).toBe('1000');
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await r.arrayBuffer()).equals(CLIP_BYTES)).toBe(true);
  });

  it('answers the three kinds of Range with 206', async () => {
    const cases: [string, string, Buffer][] = [
      ['bytes=10-19', 'bytes 10-19/1000', CLIP_BYTES.subarray(10, 20)],
      ['bytes=990-', 'bytes 990-999/1000', CLIP_BYTES.subarray(990)],
      ['bytes=-5', 'bytes 995-999/1000', CLIP_BYTES.subarray(995)],
      ['bytes=900-5000', 'bytes 900-999/1000', CLIP_BYTES.subarray(900)],
    ];
    for (const [range, contentRange, bytes] of cases) {
      const r = await get(join(t.project, 'clip.mp4'), { range });
      expect(r.status, range).toBe(206);
      expect(r.headers.get('content-range')).toBe(contentRange);
      expect(r.headers.get('content-length')).toBe(String(bytes.length));
      expect(r.headers.get('accept-ranges')).toBe('bytes');
      expect(Buffer.from(await r.arrayBuffer()).equals(bytes)).toBe(true);
    }
  });

  it('refuses a Range past the end with 416', async () => {
    const r = await get(join(t.project, 'clip.mp4'), { range: 'bytes=1000-' });
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe('bytes */1000');
  });

  it('gives only headers for HEAD', async () => {
    const r = await get(join(t.project, 'clip.mp4'), {}, [t.project], 'HEAD');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe('1000');
    expect((await r.arrayBuffer()).byteLength).toBe(0);
  });

  it('types files by extension', async () => {
    const types: Record<string, string> = {
      'a.mov': 'video/quicktime', 'a.jpg': 'image/jpeg', 'a.png': 'image/png', 'a.webm': 'audio/webm', 'a.m4a': 'audio/mp4', 'a.wav': 'audio/wav', 'a.xyz': 'application/octet-stream',
    };
    for (const [name, type] of Object.entries(types)) {
      await writeFile(join(t.project, name), 'x');
      expect((await get(join(t.project, name))).headers.get('content-type'), name).toBe(type);
    }
  });

  it('serves files in a footage folder', async () => {
    expect((await get(join(t.footage, 'raw.mov'))).status).toBe(200);
  });

  it('404s a missing file or a folder', async () => {
    expect((await get(join(t.project, 'nope.mp4'))).status).toBe(404);
    await mkdir(join(t.project, 'adir'), { recursive: true });
    expect((await get(join(t.project, 'adir'))).status).toBe(404);
  });

  it('403s anything outside the roots: other folders, "..", a symlink out, a dangling path', async () => {
    const secret = join(t.outside, 'secret.txt');
    expect((await get(secret)).status).toBe(403);
    expect((await get(join(t.project, '..', 'outside', 'secret.txt'))).status).toBe(403);
    expect((await get(join(t.project, 'link', 'secret.txt'))).status).toBe(403);
    expect((await get(join(t.outside, 'missing.txt'))).status).toBe(403);
    expect((await get('/etc/hosts')).status).toBe(403);
    // a file symlink pointing out
    await symlink(secret, join(t.project, 'peek.txt'));
    expect((await get(join(t.project, 'peek.txt'))).status).toBe(403);
    // a sibling folder that merely starts with the root's name
    await mkdir(`${t.project}-evil`, { recursive: true });
    await writeFile(join(`${t.project}-evil`, 'x.txt'), 'x');
    expect((await get(join(`${t.project}-evil`, 'x.txt'))).status).toBe(403);
  });

  it('400s a path that is not absolute or not decodable', async () => {
    expect((await handleMedia(new Request('http://127.0.0.1:1/media/relative%2Fpath'), [t.project])).status).toBe(400);
    expect((await handleMedia(new Request('http://127.0.0.1:1/media/%E0%A4%A'), [t.project])).status).toBe(400);
  });
});

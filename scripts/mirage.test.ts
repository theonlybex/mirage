import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

/** Runs the CLI as `pnpm mirage` would (cwd = the repo, INIT_CWD = where the user typed it). */
function mirage(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    execFile(TSX, [join(ROOT, 'scripts', 'mirage.ts'), ...args], { cwd: ROOT, env: { ...process.env, ...env } }, (e, out, err) => {
      done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err });
    });
  });
}

async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'we-cli-'));
  const r = await mirage(['init', dir, '--title', 'CLI test']);
  expect(r.code).toBe(0);
  return dir;
}

describe('pnpm mirage usage errors', () => {
  it('says what is wrong before the usage', async () => {
    const dir = await project();
    const cases: [string[], string][] = [
      [['frob', dir], '✖ unknown command "frob"'],
      [['check'], '✖ missing project path'],
      [['check', dir], '✖ missing episode number'],
      [['check', dir, '0x1'], '✖ episode must be a whole number like 1'],
      [['check', dir, '1e0'], '✖ episode must be a whole number like 1'],
      [['check', dir, '01'], '✖ episode must be a whole number like 1'],
      [['check', dir, '1', 'extra'], '✖ unexpected argument "extra"'],
      [['music', dir, 'x'], '✖ unexpected argument "x"'],
      [['ingest', dir], '✖ missing clips folder'],
    ];
    for (const [args, first] of cases) {
      const r = await mirage(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err.trim().split('\n')[0], args.join(' ')).toBe(first);
      expect(r.err).toContain('usage: pnpm mirage <command>');
    }
  });
});

describe('pnpm mirage projects', () => {
  it('refuses init over an existing project, leaving mirage.json alone', async () => {
    const dir = await project();
    const before = await readFile(join(dir, 'mirage.json'), 'utf8');
    const r = await mirage(['init', dir]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`✖ ${dir} is already a Mirage project`);
    expect(r.err).toContain('edit mirage.json');
    expect(await readFile(join(dir, 'mirage.json'), 'utf8')).toBe(before);
  });

  it('needs mirage.json for every other command, and ingest never creates a project on a typo', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'we-cli-'));
    const typo = join(parent, 'weather-ap');
    const r = await mirage(['ingest', typo, parent]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`✖ no Mirage project at ${typo}`);
    expect(r.err).toContain(`pnpm mirage init ${typo}`);
    expect(existsSync(typo)).toBe(false);
    expect((await mirage(['check', parent, '1'])).err).toContain(`✖ no Mirage project at ${parent}`);
  });

  it('resolves relative paths against the folder the command was typed in, and expands ~/', async () => {
    const here = await mkdtemp(join(tmpdir(), 'we-cli-cwd-'));
    expect((await mirage(['init', 'rel', '--title', 'R'], { INIT_CWD: here })).code).toBe(0);
    expect(existsSync(join(here, 'rel', 'mirage.json'))).toBe(true);
    expect((await mirage(['init', '~/tilde'], { HOME: here })).code).toBe(0);
    expect(existsSync(join(here, 'tilde', 'mirage.json'))).toBe(true);
  });
});

describe('pnpm mirage errors', () => {
  it('names a misspelled key in episode.json', async () => {
    const dir = await project();
    await mkdir(join(dir, 'episodes', '1'), { recursive: true });
    const items = [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 1 }, speeed: 2 }];
    await writeFile(join(dir, 'episodes', '1', 'episode.json'), JSON.stringify({ version: 2, number: 1, title: 't', output: { width: 1920, height: 1080, fps: 30 }, items }));
    const r = await mirage(['check', dir, '1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('✖ episodes/1/episode.json: items[0]: unknown key "speeed" (valid keys: id, beat, clip, src, speed,');
    expect(r.err).toContain('Remove or rename that key');
  });

  it('says which folder is read-only', async () => {
    const dir = await project();
    const clip = join(dir, 'a.mp4');
    await writeFile(clip, '');
    const probe = { durationSec: 10, width: 640, height: 360, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null, colorTransfer: null };
    await writeFile(join(dir, 'catalog.json'), JSON.stringify({ version: 1, clips: [{ id: 'c001', path: clip, sha256: 'a'.repeat(64), probe, kind: 'screen', transcript: null, frames: [] }] }));
    const epDir = join(dir, 'episodes', '1');
    await mkdir(epDir, { recursive: true });
    // No defaults written yet, so check has something to save.
    await writeFile(join(epDir, 'episode.json'), JSON.stringify({ version: 2, number: 1, title: 't', output: { width: 640, height: 360, fps: 30 }, items: [{ id: 'a', beat: 'problem', clip: 'c001', src: { in: 0, out: 1 } }] }));
    await chmod(epDir, 0o555);
    try {
      const r = await mirage(['check', dir, '1']);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`✖ can't write in ${epDir}: permission denied`);
      expect(r.err).not.toContain('EACCES');
    } finally {
      await chmod(epDir, 0o755);
    }
  });

  it('says which file cannot be read', async () => {
    const dir = await project();
    const cat = join(dir, 'catalog.json');
    await writeFile(cat, JSON.stringify({ version: 1, clips: [] }));
    await chmod(cat, 0o000);
    try {
      const r = await mirage(['check', dir, '1']);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`✖ can't read ${cat}: permission denied`);
    } finally {
      await chmod(cat, 0o644);
    }
  });
});

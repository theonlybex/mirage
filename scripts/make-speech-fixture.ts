import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { run } from '@wordedits/sidecars';

if (process.platform !== 'darwin') {
  console.error('fixtures:speech needs macOS (uses the say command)');
  process.exit(1);
}
const text =
  'Welcome to WordEdits. Um, this is scene one, the hook. Uh, let me say that again. ' +
  'This is scene one, the hook. [[slnc 3000]] Now scene two explains how the app cuts your take.';
await mkdir('fixtures/tmp', { recursive: true });
execFileSync('say', ['-v', 'Samantha', '-o', 'fixtures/tmp/speech.aiff', text]);
await run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
  '-i', 'fixtures/tmp/speech.aiff',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-shortest', '-movflags', '+faststart',
  'fixtures/speech-retake.mp4',
]);
await rm('fixtures/tmp/speech.aiff', { force: true });
console.log('wrote fixtures/speech-retake.mp4');

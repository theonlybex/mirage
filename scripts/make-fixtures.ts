import { mkdir } from 'node:fs/promises';
import { run } from '@wordedits/sidecars';

const out = 'fixtures';
await mkdir(out, { recursive: true });

const video = (rate: string) => ['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${rate}:duration=6`];
const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6'];
const silence = ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '6'];
const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', '-y'];

const jobs: [string, string[]][] = [
  ['tone-6s.mp4', [...video('30'), ...tone, ...enc]],
  ['tone-6s-2997.mp4', [...video('30000/1001'), ...tone, ...enc]],
  ['noaudio-6s.mp4', [...video('30'), ...enc.filter((a) => !['-c:a', 'aac', '-b:a', '96k'].includes(a)), '-an']],
  ['silent-6s.mp4', [...video('30'), ...silence, ...enc]],
];

for (const [name, args] of jobs) {
  await run('ffmpeg', [...args, `${out}/${name}`]);
  console.log('wrote', name);
}

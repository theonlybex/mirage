// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ViewerInfoSchema } from '@wordedits/shared';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Whether a viewer other than process `self` serves `project` now: .mirage/viewer.json names a live process that isn't it. */
export function otherViewer(project: string, self: number, alive: (pid: number) => boolean = isAlive): boolean {
  try {
    const info = ViewerInfoSchema.safeParse(JSON.parse(readFileSync(join(project, '.mirage', 'viewer.json'), 'utf8')));
    return info.success && info.data.pid !== self && alive(info.data.pid);
  } catch {
    return false;
  }
}

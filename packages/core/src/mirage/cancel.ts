// SPDX-License-Identifier: MIT
import { MirageError } from './errors.js';

/**
 * The error a command ends with when it was stopped on request: a CANCELLED MirageError when `signal` aborted or `e` is
 * a sidecar's CANCELLED error (matched by name and code: core loads the sidecars lazily), otherwise `e` itself.
 */
export function asCancelled(e: unknown, signal?: AbortSignal): unknown {
  const sidecar = e instanceof Error && e.name === 'SidecarError' && (e as { code?: unknown }).code === 'CANCELLED';
  if (signal?.aborted || sidecar) return new MirageError('CANCELLED', 'Stopped before it finished', 'Nothing was changed. Run it again to finish.');
  return e;
}

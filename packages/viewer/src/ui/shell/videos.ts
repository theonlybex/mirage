// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from 'react';
import type { VideoSummary } from '../../view-types.js';
import { get } from '../api.js';

const REFRESH_MS = 10_000;

/** The project's videos, fetched now, every 10 s and whenever the window comes back into focus. */
export function useVideos(): { videos: VideoSummary[] | null; error: string | null; reload: () => void } {
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    get<VideoSummary[]>('/api/videos').then(
      (v) => {
        setVideos(v);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  useEffect(() => {
    reload();
    const id = setInterval(reload, REFRESH_MS);
    window.addEventListener('focus', reload);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', reload);
    };
  }, [reload]);
  return { videos, error, reload };
}

/** A video's stage in plain words, with the chip tone it gets. */
export const STAGE: Record<VideoSummary['stage'], { label: string; tone: 'neutral' | 'secondary' | 'primary' | 'success' }> = {
  new: { label: 'Not started', tone: 'neutral' },
  rough: { label: 'First cut', tone: 'secondary' },
  guide: { label: 'Ready for voice-over', tone: 'primary' },
  final: { label: 'Finished', tone: 'success' },
};

export const toWatch = (n: number): string => (n === 0 ? 'Nothing to watch yet' : `${n} ${n === 1 ? 'version' : 'versions'} to watch`);

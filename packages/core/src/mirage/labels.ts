// SPDX-License-Identifier: MIT
import type { EpisodeMode } from './render-episode.js';

/** What each kind of render is called to the person watching. */
export const DELIVERY_LABEL: Record<EpisodeMode, string> = {
  rough: 'Rough cut',
  guide: 'Guide cut (record your voice-over over this)',
  final: 'Final video',
};

// SPDX-License-Identifier: AGPL-3.0-or-later
// Every Material Symbol the page uses. Adding one: put its name here, then run `pnpm --filter @wordedits/viewer icons`,
// which writes its outlined and filled paths into icon-paths.generated.ts. A name used but not listed is a type error.

export const ICONS = [
  'arrow_back',
  'bedtime',
  'check',
  'chevron_right',
  'cloud_off',
  'dark_mode',
  'error',
  'history',
  'image',
  'light_mode',
  'link_off',
  'list',
  'mic',
  'movie',
  'music_note',
  'pause',
  'pause_circle',
  'play_arrow',
  'refresh',
  'send',
  'smart_display',
  'stop',
  'stop_circle',
  'title',
  'undo',
  'video_library',
  'warning',
] as const;

export type IconName = (typeof ICONS)[number];

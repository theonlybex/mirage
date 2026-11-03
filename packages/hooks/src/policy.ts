// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure decisions of the hooks: what a tool call is called, which video it belongs to, whether it changes the video, and
// whether a file write is denied or auto-approved. Only node:fs/node:path here, so a hook outside a project loads fast.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { SessionState } from '@wordedits/shared';

export const ENGINE_PREFIX = 'mcp__plugin_mirage_engine__';
export const FOOTAGE_DENY = 'Footage folders are read-only in Mirage.';

/** The engine tool's short name (`check` for `mcp__plugin_mirage_engine__check`), or null for any other tool. */
export const engineTool = (tool: string): string | null => (tool.startsWith(ENGINE_PREFIX) ? tool.slice(ENGINE_PREFIX.length) : null);

const SAVE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const FILE_TOOLS = new Set([...SAVE_TOOLS, 'NotebookEdit']);
const READ_ONLY = new Set(['versions', 'status', 'get_notes', 'log']);
const STAGES = new Set(['ingest', 'check', 'cut', 'slots', 'guide', 'vo', 'render']);
/** Engine tools that make a project or a video: they belong to no video yet. */
const NO_VIDEO = new Set(['new_project', 'new_video']);

const ENGINE_LABELS: Record<string, [string, string]> = {
  new_project: ['Starting the project', 'Project started'],
  new_video: ['Setting up the video', 'Video set up'],
  ingest: ['Cataloguing your clips', 'Clips catalogued'],
  music: ['Reading the music', 'Music read'],
  check: ['Checking the timeline', 'Timeline checked'],
  cut: ['Rendering the rough cut', 'Rough cut rendered'],
  slots: ['Finding room for narration', 'Narration slots found'],
  guide: ['Rendering the guide video', 'Guide video rendered'],
  vo: ['Fitting your voice-over', 'Voice-over fitted'],
  render: ['Rendering the final video', 'Final video rendered'],
  versions: ['Checking', 'Checked'],
  status: ['Checking', 'Checked'],
  restore: ['Going back to an earlier version', 'Went back'],
  get_notes: ['Reading your notes', 'Read your notes'],
  note_status: ['Updating a note', 'Note updated'],
  log: ['Making a note for you', 'Noted'],
  overnight: ['Getting ready for overnight', 'Ready for overnight'],
};

const record = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

/** The file a tool works on (`file_path`, or a notebook's `notebook_path`), as given; null when there is none. */
export function filePathOf(input: unknown): string | null {
  const o = record(input);
  const p = typeof o.file_path === 'string' ? o.file_path : o.notebook_path;
  return typeof p === 'string' && p !== '' ? p : null;
}

/** The last part of a path, splitting on both separators so a Windows-style path names its file too. */
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * `p` made absolute against `base`, with symlinks resolved: the realpath of the nearest existing parent plus the rest. A
 * dangling symlink is followed to where it points, so a write through it is judged by its target.
 */
export function normalisePath(p: string, base: string, depth = 0): string {
  const abs = path.resolve(base, p);
  const rest: string[] = [];
  let head = abs;
  for (;;) {
    try {
      return path.join(realpathSync.native(head), ...rest.reverse());
    } catch {
      // Not there (or not readable): a dangling link is followed, anything else is looked up one level higher.
    }
    if (depth < 16) {
      try {
        if (lstatSync(head).isSymbolicLink()) return normalisePath(path.join(path.resolve(path.dirname(head), readlinkSync(head)), ...rest.reverse()), base, depth + 1);
      } catch {
        // no such file
      }
    }
    const parent = path.dirname(head);
    if (parent === head) return abs;
    rest.push(path.basename(head));
    head = parent;
  }
}

/** `child` relative to `parent` when it is inside it (or is it, giving ''), else null. */
function inside(child: string, parent: string): string | null {
  const rel = path.relative(parent, child);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel;
}

/** The project-relative path of the tool's file (normalised), or null when it has none or it is outside the project. */
function projectRelative(input: unknown, project: string): string | null {
  const p = filePathOf(input);
  if (p === null) return null;
  return inside(normalisePath(p, project), normalisePath(project, path.sep));
}

const segments = (rel: string) => rel.split(path.sep);

/** The label of a tool call while it runs, and once it is done. */
export function stepLabel(tool: string, input: unknown): { label: string; doneLabel: string } {
  const engine = engineTool(tool);
  if (engine !== null) {
    const [label, doneLabel] = ENGINE_LABELS[engine] ?? ['Working', 'Done'];
    return { label, doneLabel };
  }
  const file = filePathOf(input);
  if (tool === 'Read' && file !== null) {
    if (/(^|[\\/])frames[\\/]/.test(file)) return { label: 'Looking at clips', doneLabel: 'Looked at clips' };
    const name = baseName(file);
    return { label: `Reading ${name}`, doneLabel: `Read ${name}` };
  }
  if (SAVE_TOOLS.has(tool) && file !== null) {
    const name = baseName(file);
    if (name === 'episode.json') return { label: 'Writing the timeline', doneLabel: 'Timeline written' };
    if (name === 'catalog.json') return { label: 'Describing clips', doneLabel: 'Clips described' };
    return { label: `Saving ${name}`, doneLabel: `Saved ${name}` };
  }
  if (tool === 'Glob' || tool === 'Grep') return { label: 'Looking through the project', doneLabel: 'Looked through the project' };
  return { label: 'Working', doneLabel: 'Done' };
}

/**
 * The video a tool call belongs to: the engine input's `video`, else `episodes/<n>/` in its file path (inside the project),
 * else the session's video. new_project and new_video belong to none.
 */
export function videoOf(tool: string, input: unknown, project: string, session: SessionState): number | null {
  const engine = engineTool(tool);
  if (engine !== null && NO_VIDEO.has(engine)) return null;
  const v = record(input).video;
  if (engine !== null && typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  const rel = projectRelative(input, project);
  if (rel !== null) {
    const [top, n] = segments(rel);
    if (top === 'episodes' && n !== undefined && /^[1-9]\d*$/.test(n)) return Number(n);
  }
  return session.video;
}

/** Whether the call can change a video: engine tools other than the read-only ones, and saves inside episodes/ or of catalog.json. */
export function isChanging(tool: string, input: unknown, project: string): boolean {
  const engine = engineTool(tool);
  if (engine !== null) return !READ_ONLY.has(engine);
  if (!SAVE_TOOLS.has(tool)) return false;
  const rel = projectRelative(input, project);
  if (rel === null || rel === '') return false;
  return rel === 'catalog.json' || segments(rel)[0] === 'episodes';
}

/** The engine stages, after each of which a checkpoint is taken. */
export const isStage = (tool: string): boolean => STAGES.has(engineTool(tool) ?? '');

/**
 * The file guard. Writes (Write, Edit, MultiEdit, NotebookEdit) inside any footage folder are denied. Saves of the project's
 * catalog.json, or of episode.json or summary.md directly in episodes/<n>/, are allowed without a prompt. Anything else: null.
 */
export function fileDecision(tool: string, input: unknown, project: string, footage: string[]): 'allow' | { deny: string } | null {
  if (!FILE_TOOLS.has(tool)) return null;
  const p = filePathOf(input);
  if (p === null) return null;
  const target = normalisePath(p, project);
  if (footage.some((f) => inside(target, normalisePath(f, project)) !== null)) return { deny: FOOTAGE_DENY };
  if (!SAVE_TOOLS.has(tool)) return null;
  const rel = inside(target, normalisePath(project, path.sep));
  if (rel === null) return null;
  if (rel === 'catalog.json') return 'allow';
  const s = segments(rel);
  return s.length === 3 && s[0] === 'episodes' && /^[1-9]\d*$/.test(s[1]!) && (s[2] === 'episode.json' || s[2] === 'summary.md') ? 'allow' : null;
}

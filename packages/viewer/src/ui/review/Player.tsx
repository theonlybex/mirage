// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { NoteView, VersionView } from '../../view-types.js';
import { post as apiPost, withKey, type Post } from '../api.js';
import { FloatingToolbar } from '../components/FloatingToolbar.js';
import { Icon } from '../components/Icon.js';
import { IconButton } from '../components/IconButton.js';
import { BoxOutline, type Box } from './box.js';
import { NoteComposer, type SendAudio } from './NoteComposer.js';
import { timecode } from './timecode.js';

type PlayerProps = {
  video: number;
  /** The version playing; it has a `videoUrl`. */
  version: VersionView;
  /** The notes on this version, shown as markers on the scrubber. */
  notes: readonly NoteView[];
  /** Go to this moment (and pause); a new `nonce` goes there again. */
  seek?: { t: number; nonce: number } | null;
  post?: Post;
  sendAudio?: SendAudio;
};

/** How far the pointer must move before a press becomes a drag (a box) rather than a click. */
const DRAG_PX = 6;
/** A box smaller than this (of the picture's width or height) is taken as a click. */
const MIN_BOX = 0.01;
/** While playing, the toolbar fades this long after the pointer last moved over the picture. */
const IDLE_MS = 2500;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

type Point = { x: number; y: number };
const boxBetween = (a: Point, b: Point): Box => ({
  x: round4(Math.min(a.x, b.x)),
  y: round4(Math.min(a.y, b.y)),
  w: round4(Math.abs(a.x - b.x)),
  h: round4(Math.abs(a.y - b.y)),
});

/** The paused frame as a small JPEG for the composer, or null when the browser has no picture yet. */
function grabStill(video: HTMLVideoElement): string | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = Math.round((480 * video.videoHeight) / video.videoWidth);
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}

/**
 * The Review player: the version's video in a 16 px frame with §15's floating toolbar (play, a scrubber with the
 * notes as markers, the timecode). Clicking the picture pauses it and opens a note at that moment; dragging draws a
 * box first. "Add a note here" in the toolbar does the same from the keyboard.
 */
export function Player({ video, version, notes, seek = null, post = apiPost, sendAudio }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const press = useRef<(Point & { id: number; px: number; py: number; t: number; moved: boolean }) | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [drag, setDrag] = useState<Box | null>(null);
  const [note, setNote] = useState<{ t: number; box: Box | null; still: string | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A smooth timecode while playing (timeupdate only comes about four times a second).
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      if (videoRef.current) setCurrent(videoRef.current.currentTime);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing]);

  const goTo = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = t;
    setCurrent(t);
  };

  useEffect(() => {
    if (!seek) return;
    const v = videoRef.current;
    if (v && v.readyState >= 1) goTo(seek.t);
    else pendingSeek.current = seek.t;
    frameRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [seek]);

  useEffect(() => () => void (idleTimer.current && clearTimeout(idleTimer.current)), []);

  const wake = () => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) void v.play()?.catch(() => {});
    else v.pause();
  };

  /** Opens the composer at `t`, with the still of the paused picture. */
  const openNote = (t: number, box: Box | null) => {
    const v = videoRef.current;
    setCurrent(t);
    setNote((n) => ({ t, box, still: v ? grabStill(v) : (n?.still ?? null) }));
  };

  const at = (e: PointerEvent): Point => {
    const r = surfaceRef.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / (r.width || 1)), y: clamp01((e.clientY - r.top) / (r.height || 1)) };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || failed) return;
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    press.current = { ...at(e), id: e.pointerId, px: e.clientX, py: e.clientY, t: v.currentTime, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (!p.moved && Math.hypot(e.clientX - p.px, e.clientY - p.py) < DRAG_PX) return;
    p.moved = true;
    setDrag(boxBetween(p, at(e)));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    setDrag(null);
    const box = p.moved ? boxBetween(p, at(e)) : null;
    openNote(p.t, box && box.w >= MIN_BOX && box.h >= MIN_BOX ? box : null);
  };
  const onPointerCancel = () => {
    press.current = null;
    setDrag(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const v = videoRef.current;
    if (!v) return;
    if (e.key === ' ' || e.key === 'k') togglePlay();
    else if (e.key === 'ArrowLeft') goTo(Math.max(0, v.currentTime - 5));
    else if (e.key === 'ArrowRight') goTo(Math.min(duration || v.currentTime + 5, v.currentTime + 5));
    else if (e.key === 'n') {
      v.pause();
      openNote(v.currentTime, null);
    } else return;
    e.preventDefault();
  };

  const add = async (text: string) => {
    if (!note) return;
    await post('/api/notes', { video, versionId: version.id, t: note.t, text, box: note.box });
    setNote(null);
  };

  const shown = drag ?? note?.box ?? null;
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;
  const hidden = playing && idle && !drag;

  return (
    <div className="player">
      <div
        ref={frameRef}
        className="player__frame"
        tabIndex={0}
        aria-label="Video picture"
        aria-keyshortcuts="Space K ArrowLeft ArrowRight N"
        onKeyDown={onKeyDown}
        onPointerMove={wake}
        data-toolbar-hidden={hidden || undefined}
      >
        <div className="player__stage">
          <video
            ref={videoRef}
            className="player__video"
            src={version.videoUrl ? withKey(version.videoUrl) : undefined}
            preload="metadata"
            playsInline
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              setDuration(Number.isFinite(v.duration) ? v.duration : 0);
              if (pendingSeek.current !== null) {
                goTo(pendingSeek.current);
                pendingSeek.current = null;
              } else setCurrent(v.currentTime);
            }}
            onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
            onTimeUpdate={(e) => !playing && setCurrent(e.currentTarget.currentTime)}
            onPlay={() => {
              setPlaying(true);
              wake();
            }}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => setFailed(true)}
          />
          <div
            ref={surfaceRef}
            className="player__surface"
            aria-hidden="true"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            data-dragging={drag ? 'true' : undefined}
          />
          {shown && <BoxOutline box={shown} />}
          {failed && (
            <div className="player__failed" role="alert">
              <Icon name="error" />
              <p>This video can’t be played. It may have been moved or deleted.</p>
            </div>
          )}
        </div>
        <FloatingToolbar label="Player" className="player__toolbar">
          <IconButton className="player__play" variant="filled" icon={playing ? 'pause' : 'play_arrow'} aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay} disabled={failed} />
          <div className="player__scrub" style={{ '--progress': progress } as CSSProperties}>
            <input
              type="range"
              className="player__range"
              aria-label="Position"
              aria-valuetext={`${timecode(current)} of ${timecode(duration)}`}
              min={0}
              max={duration || 0}
              step={0.01}
              value={Math.min(current, duration || 0)}
              disabled={!duration}
              onChange={(e) => goTo(Number(e.currentTarget.value))}
            />
            {duration > 0 && (
              <span className="player__markers" aria-hidden="true">
                {notes.map((n) => (
                  <span key={n.id} className="player__marker" data-sent={n.round !== null || undefined} style={{ left: `${Math.min(1, n.t / duration) * 100}%` }} />
                ))}
              </span>
            )}
          </div>
          <span className="player__time">
            {timecode(current)} / {timecode(duration)}
          </span>
          <IconButton
            icon="add_comment"
            aria-label="Add a note here"
            disabled={failed}
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              v.pause();
              openNote(v.currentTime, null);
            }}
          />
        </FloatingToolbar>
      </div>
      {note ? (
        <NoteComposer video={video} t={note.t} box={note.box} still={note.still} onAdd={add} onCancel={() => setNote(null)} sendAudio={sendAudio} />
      ) : (
        <p className="player__hint">
          <Icon name="add_comment" size={18} />
          Click the picture to note that moment. Drag to mark part of it.
        </p>
      )}
    </div>
  );
}

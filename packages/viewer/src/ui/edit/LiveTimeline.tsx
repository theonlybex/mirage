// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { TimelineView } from '../../view-types.js';
import { withKey } from '../api.js';
import { Chip } from '../components/Chip.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Spinner } from '../components/Spinner.js';
import { keysBy, usePresence, type Presence } from './presence.js';
import { assignRows, beatColour, beatName, formatTime, PX_PER_ITEM, rulerTicks, SCROLL_AFTER_ITEMS } from './timeline-layout.js';

type Span = { start: number; end: number };

/** Where a span sits, as fractions of the lane (the CSS turns them into a transform and a width). */
function place(span: Span, duration: number, extra: Record<string, string | number> = {}): CSSProperties {
  const d = duration > 0 ? duration : 1;
  return { '--start': Math.max(0, span.start) / d, '--len': Math.max(0, span.end - span.start) / d, ...extra } as CSSProperties;
}

function Lane({ name, label, icon, children, style }: { name: string; label: string; icon: IconName; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="timeline__row" data-row={name} style={style}>
      <div className="timeline__label" aria-hidden="true">
        <Icon name={icon} size={18} />
        <span>{label}</span>
      </div>
      <div className="timeline__lane" data-lane={name} role="list" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

const span = (s: Span) => `${formatTime(s.start)} to ${formatTime(s.end)}`;

function Picture({ p, duration }: { p: Presence<TimelineView['items'][number]>; duration: number }) {
  const { item } = p;
  const [broken, setBroken] = useState(false);
  const words = [beatName(item.beat), span(item), item.quiet ? 'quiet' : null, item.speed !== 1 ? `${item.speed}× speed` : null].filter(Boolean).join(' · ');
  return (
    <div
      className="tl-picture"
      role="listitem"
      aria-label={words}
      title={words}
      data-key={p.key}
      data-state={p.state}
      data-beat={item.beat}
      data-quiet={item.quiet ? 'true' : undefined}
      style={place(item, duration, { '--beat': beatColour(item.beat) })}
    >
      {item.thumb && !broken ? (
        <img src={withKey(item.thumb)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />
      ) : (
        <span className="tl-picture__blank" />
      )}
      {item.speed !== 1 && <span className="tl-picture__speed">{item.speed}×</span>}
    </div>
  );
}

/** The edit as it is being made: pictures, what's on screen, music and narration on a shared time ruler. */
export function LiveTimeline({ view }: { view: TimelineView }) {
  const duration = view.durationSec;
  const pictures = usePresence(view.items, (i) => i.id);
  const overlayKeys = keysBy(view.overlays, (o) => `${o.kind}:${o.text}`);
  const overlays = usePresence(view.overlays, (_o, i) => overlayKeys[i]!);
  const musicKeys = keysBy(view.music, (m) => m.track);
  const music = usePresence(view.music, (_m, i) => musicKeys[i]!);
  const slots = usePresence(view.slots, (s) => s.id);
  const voiceKeys = keysBy(view.voice, (v) => v.slot);
  const voice = usePresence(view.voice, (_v, i) => voiceKeys[i]!);

  const overlayRows = assignRows(overlays.map((o) => o.item));
  const scrolls = view.items.length > SCROLL_AFTER_ITEMS;
  const editing = view.status === 'editing';
  const empty = view.status === 'empty' || (view.items.length === 0 && view.overlays.length === 0 && view.slots.length === 0 && view.music.length === 0);

  // The ruler gets a label every ~64 px at most, whatever the width.
  const ruler = useRef<HTMLDivElement>(null);
  const [rulerWidth, setRulerWidth] = useState(640);
  useLayoutEffect(() => {
    const el = ruler.current;
    if (!el) return;
    const measure = () => el.clientWidth > 0 && setRulerWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [empty]);

  // Moves animate only once the lanes have their size: before that, a first layout would read as everything moving.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => (second = requestAnimationFrame(() => setSettled(true))));
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  return (
    <section className="timeline" aria-labelledby="timeline-title" data-editing={editing ? 'true' : undefined} data-settled={settled ? 'true' : undefined}>
      <header className="timeline__head">
        <div className="timeline__titles">
          <h2 id="timeline-title" className="timeline__title">
            {view.title || 'Timeline'}
          </h2>
          {!empty && <span className="timeline__duration">{formatTime(duration)} long</span>}
        </div>
        {editing && (
          <Chip tone="tertiary" leading={<Spinner size={16} />}>
            Being edited…
          </Chip>
        )}
      </header>

      {empty ? (
        <div className="empty-state">
          <Icon name="movie" size={40} />
          <p>No timeline yet. It shows up here as soon as Claude starts putting the video together.</p>
        </div>
      ) : (
        <div className="timeline__scroll" tabIndex={scrolls ? 0 : undefined} aria-label={scrolls ? 'Timeline, scrolls sideways' : undefined}>
          <div className="timeline__track" data-track="" style={scrolls ? { minWidth: `${view.items.length * PX_PER_ITEM}px` } : undefined}>
            <div className="timeline__row timeline__row--ruler" aria-hidden="true">
              <div className="timeline__label" />
              <div className="timeline__lane timeline__ruler" ref={ruler}>
                {rulerTicks(duration, Math.max(2, Math.floor(rulerWidth / 64)))
                  // A label too close to the end would be cut off.
                  .filter((t) => t === 0 || t / duration <= 0.92)
                  .map((t) => (
                  <span key={t} className="tl-tick" style={place({ start: t, end: t }, duration)}>
                    {formatTime(t)}
                  </span>
                ))}
              </div>
            </div>

            <Lane name="picture" label="Picture" icon="image">
              {pictures.map((p) => (
                <Picture key={p.key} p={p} duration={duration} />
              ))}
            </Lane>

            <Lane name="on-screen" label="On screen" icon="title" style={{ '--rows': overlayRows.count } as CSSProperties}>
              {overlays.map((o, i) => (
                <div
                  key={o.key}
                  className="tl-pill"
                  role="listitem"
                  title={`${o.item.text} · ${span(o.item)}`}
                  data-key={o.key}
                  data-state={o.state}
                  data-tone={o.item.tone}
                  style={place(o.item, duration, { '--row': overlayRows.rows[i] ?? 0 })}
                >
                  <span className="tl-pill__text">{o.item.text}</span>
                </div>
              ))}
            </Lane>

            <Lane name="music" label="Music" icon="music_note">
              {music.map((m) => (
                <div key={m.key} className="tl-music" role="listitem" title={`${m.item.track} · ${span(m.item)}`} data-key={m.key} data-state={m.state} style={place(m.item, duration)}>
                  <span className="tl-music__text">{m.item.track}</span>
                </div>
              ))}
            </Lane>

            <Lane name="narration" label="Narration" icon="mic">
              {voice.map((v) => (
                <div key={`voice:${v.key}`} className="tl-voice" data-voice="" data-key={`voice:${v.key}`} data-state={v.state} style={place(v.item, duration)} aria-hidden="true" />
              ))}
              {slots.map((s) => {
                const voiced = view.voice.some((v) => v.slot === s.item.id);
                return (
                  <div
                    key={s.key}
                    className="tl-slot"
                    role="listitem"
                    aria-label={`${voiced ? 'Recorded' : 'To record'}: ${s.item.line || 'no line yet'} · ${span(s.item)}`}
                    title={s.item.line}
                    data-key={s.key}
                    data-state={s.state}
                    data-voiced={voiced ? 'true' : undefined}
                    style={place(s.item, duration)}
                  >
                    <span className="tl-slot__text">{s.item.line}</span>
                  </div>
                );
              })}
            </Lane>
          </div>
        </div>
      )}
    </section>
  );
}

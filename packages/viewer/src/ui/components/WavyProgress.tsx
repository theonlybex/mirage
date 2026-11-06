// SPDX-License-Identifier: MIT
import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

type WavyProgressProps = {
  /** 0..1, or undefined while how far it is isn't known (indeterminate). */
  value?: number;
  /** What is progressing, for screen readers. */
  label: string;
  /** Track thickness (§15: 8 px for render progress). */
  thickness?: 4 | 8;
};

const GAP = 4;

/** The wave as a polyline from x = 0 to `width`, centred on `mid`. */
function wavePath(width: number, mid: number, amplitude: number, wavelength: number): string {
  let d = `M 0 ${mid}`;
  for (let x = 2; x <= width; x += 2) d += ` L ${x} ${(mid + amplitude * Math.sin((2 * Math.PI * x) / wavelength)).toFixed(2)}`;
  return d;
}

/**
 * M3 Expressive linear wavy progress: the done part is a travelling wave in primary, the rest a flat track in
 * secondary-container ending in a 4 px stop indicator. Reduced motion keeps the wave still.
 */
export function WavyProgress({ value, label, thickness = 8 }: WavyProgressProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const clip = `wave-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => el.clientWidth > 0 && setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const determinate = value !== undefined;
  const v = determinate ? Math.min(1, Math.max(0, value)) : 0;
  const amplitude = thickness === 8 ? 3 : 2;
  const wavelength = thickness === 8 ? 40 : 32;
  const height = thickness + amplitude * 2 + 2;
  const mid = height / 2;
  const done = Math.max(0, v * width);
  const trackStart = determinate ? Math.min(width, done + (done > 0 ? GAP + thickness / 2 : 0)) : 0;
  const style = { '--wave-length': `${wavelength}px`, '--wavy-width': `${width}px`, height } as CSSProperties;

  return (
    <div
      ref={ref}
      className="m3-wavy"
      data-indeterminate={determinate ? undefined : 'true'}
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(v * 100) : undefined}
      style={style}
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <defs>
          <clipPath id={clip}>
            {determinate ? (
              <rect x={0} y={0} width={done} height={height} rx={thickness / 2} />
            ) : (
              <rect className="m3-wavy__sweep" x={0} y={0} width={width * 0.4} height={height} rx={thickness / 2} />
            )}
          </clipPath>
        </defs>
        {(!determinate || trackStart < width) && (
          <line className="m3-wavy__track" x1={trackStart + thickness / 2} x2={width - thickness / 2} y1={mid} y2={mid} strokeWidth={thickness} strokeLinecap="round" />
        )}
        {determinate && <circle className="m3-wavy__stop" cx={width - thickness / 2} cy={mid} r={2} />}
        <g clipPath={`url(#${clip})`}>
          <path className="m3-wavy__wave" d={wavePath(width + wavelength, mid, amplitude, wavelength)} fill="none" strokeWidth={thickness} strokeLinecap="round" />
        </g>
      </svg>
    </div>
  );
}

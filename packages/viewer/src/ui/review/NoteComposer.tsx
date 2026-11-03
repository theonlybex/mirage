// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { postBytes } from '../api.js';
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { Spinner } from '../components/Spinner.js';
import { TextField } from '../components/TextField.js';
import { BoxOutline, type Box } from './box.js';
import { timecode } from './timecode.js';

/** Turns a recording into text: `/api/voice-note`, or a stand-in in tests. */
export type SendAudio = (video: number, audio: Blob) => Promise<{ text: string }>;

const sendAudioToServer: SendAudio = (video, audio) => postBytes<{ text: string }>(`/api/voice-note?video=${video}`, audio, 'audio/webm');

/** A press shorter than this is taken as a tap: it says to hold the button instead of sending a blip. */
const SHORT_MS = 400;
const HOLD_HINT = 'Hold the button while you talk.';

/** What went wrong starting the microphone, in words. */
export function micError(e: unknown): string {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Mirage can’t use the microphone. Allow it for this page in the browser’s site settings, or type the note.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found. Type the note instead.';
  return 'The microphone didn’t start. Type the note instead.';
}

type Recording = { recorder: MediaRecorder | null; stream: MediaStream | null; chunks: Blob[]; released: boolean; startedAt: number };
type MicState = 'idle' | 'starting' | 'recording' | 'transcribing';

const stopTracks = (s: MediaStream | null) => s?.getTracks().forEach((t) => t.stop());

/** Hold-to-talk: records while held (MediaRecorder, audio/webm), then hands the words to `onText`. */
function useVoiceNote(video: number, onText: (text: string) => void, sendAudio: SendAudio) {
  const [state, setState] = useState<MicState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const rec = useRef<Recording | null>(null);
  const alive = useRef(true);
  const supported = typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const r = rec.current;
      if (!r) return;
      r.released = true;
      if (r.recorder && r.recorder.state !== 'inactive') {
        r.recorder.onstop = null;
        r.recorder.stop();
      }
      stopTracks(r.stream);
      rec.current = null;
    };
  }, []);

  const finish = async (r: Recording) => {
    stopTracks(r.stream);
    rec.current = null;
    if (!alive.current) return;
    if (Date.now() - r.startedAt < SHORT_MS || !r.chunks.length) {
      setState('idle');
      setMessage(HOLD_HINT);
      return;
    }
    setState('transcribing');
    try {
      const { text } = await sendAudio(video, new Blob(r.chunks, { type: 'audio/webm' }));
      if (!alive.current) return;
      if (text.trim()) onText(text.trim());
      else setMessage('Mirage didn’t catch any words. Try again a little closer to the microphone.');
    } catch (e) {
      if (alive.current) setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setState('idle');
    }
  };

  const start = async () => {
    if (rec.current || state === 'transcribing') return;
    const r: Recording = { recorder: null, stream: null, chunks: [], released: false, startedAt: 0 };
    rec.current = r;
    setMessage(null);
    setState('starting');
    try {
      r.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      rec.current = null;
      if (!alive.current) return;
      setState('idle');
      setMessage(micError(e));
      return;
    }
    // Let go before the microphone came on (or the composer closed): nothing to record.
    if (r.released || !alive.current) {
      stopTracks(r.stream);
      rec.current = null;
      if (alive.current) {
        setState('idle');
        setMessage(HOLD_HINT);
      }
      return;
    }
    const type = MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    try {
      const recorder = MediaRecorder.isTypeSupported?.(type) ? new MediaRecorder(r.stream, { mimeType: type }) : new MediaRecorder(r.stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size) r.chunks.push(e.data);
      };
      recorder.onstop = () => void finish(r);
      r.recorder = recorder;
      // Inside the try: a recorder that will not start must still give the microphone back.
      recorder.start();
    } catch (e) {
      if (r.recorder) r.recorder.onstop = null;
      stopTracks(r.stream);
      rec.current = null;
      setState('idle');
      setMessage(micError(e));
      return;
    }
    r.startedAt = Date.now();
    setState('recording');
  };

  const stop = () => {
    const r = rec.current;
    if (!r) return;
    r.released = true;
    if (r.recorder?.state === 'recording') r.recorder.stop();
  };

  return { supported, state, message, start, stop };
}

type NoteComposerProps = {
  video: number;
  /** Seconds into the version. */
  t: number;
  box: Box | null;
  /** The paused frame (a data: URL), when the browser could grab it. */
  still: string | null;
  onAdd: (text: string) => Promise<void>;
  onCancel: () => void;
  sendAudio?: SendAudio;
};

/** A new note at a moment of the video: the still, what to change (typed or spoken), Add. */
export function NoteComposer({ video, t, box, still, onAdd, onCancel, sendAudio = sendAudioToServer }: NoteComposerProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const mic = useVoiceNote(video, (words) => setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${words}` : words)), sendAudio);

  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, [t, box]);

  const add = async () => {
    const said = text.trim();
    if (!said || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(said);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void add();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const hold = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      void mic.start();
    },
    onPointerUp: mic.stop,
    onPointerCancel: mic.stop,
    onLostPointerCapture: mic.stop,
    // Focus leaving the button (Tab, a click elsewhere, the window losing focus) ends a keyboard or pointer hold.
    onBlur: mic.stop,
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        void mic.start();
      }
    },
    onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        mic.stop();
      }
    },
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  };
  const listening = mic.state === 'starting' || mic.state === 'recording';
  const micStatus =
    mic.state === 'recording' ? 'Listening… let go when you’re done.' : mic.state === 'transcribing' ? 'Turning your words into text…' : mic.state === 'starting' ? 'Starting the microphone…' : mic.message;

  return (
    <section className="composer" aria-label="New note">
      <div className="composer__still">
        {still ? <img src={still} alt="" /> : <Icon name="image" size={40} />}
        {box && <BoxOutline box={box} />}
      </div>
      <div className="composer__main">
        <p className="composer__when">
          Note at <span className="composer__time">{timecode(t)}</span>
          {box && <span className="composer__area"> · on the marked area</span>}
        </p>
        <TextField ref={field} label="Your note" value={text} onChange={setText} onKeyDown={onKeyDown} multiline rows={2} maxLength={2000} placeholder="What should change here?" disabled={busy} />
        <div className="composer__actions">
          {mic.supported && (
            <Button
              variant={listening ? 'filled' : 'tonal'}
              icon="mic"
              className="composer__mic"
              aria-pressed={listening}
              aria-describedby="composer-mic-status"
              disabled={busy || mic.state === 'transcribing'}
              data-listening={listening || undefined}
              {...hold}
            >
              {listening ? 'Release to stop' : 'Hold to talk'}
            </Button>
          )}
          <span className="composer__spacer" />
          <Button variant="text" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="filled" icon="add_comment" onClick={() => void add()} disabled={!text.trim() || busy}>
            Add
          </Button>
        </div>
        <p id="composer-mic-status" className="composer__status" aria-live="polite">
          {mic.state === 'transcribing' && <Spinner size={16} />}
          {micStatus}
        </p>
        {error && (
          <p className="composer__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

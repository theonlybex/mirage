// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { postForm } from '../api.js';
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { Spinner } from '../components/Spinner.js';

/** Sends a recording to the server, which saves it with the video and tells Claude. */
export type UploadVoiceover = (video: number, file: File) => Promise<{ ok: boolean; path: string }>;

const uploadToServer: UploadVoiceover = (video, file) => {
  const form = new FormData();
  // The video first: the server reads it before the file to know where the file goes.
  form.append('video', String(video));
  form.append('file', file, file.name);
  return postForm('/api/voiceover', form);
};

/** Kept in step with the server's RECORDING_EXTENSIONS. */
const RECORDING = /\.(aac|aif|aiff|caf|flac|m4a|m4v|mov|mp3|mp4|ogg|opus|wav|webm)$/i;
const LIMIT = 4 * 1024 ** 3;

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

type State = { kind: 'idle' } | { kind: 'sending'; name: string } | { kind: 'sent'; name: string } | { kind: 'failed'; message: string };

/** On a guide cut: what to do, and where to drop the recording (or "Choose file"). */
export function VoiceoverDrop({ video, upload = uploadToServer }: { video: number; upload?: UploadVoiceover }) {
  const [over, setOver] = useState(false);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const input = useRef<HTMLInputElement>(null);

  // A recording dropped next to the box must not make the browser leave the page to play it.
  useEffect(() => {
    const keep = (e: globalThis.DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', keep);
    window.addEventListener('drop', keep);
    return () => {
      window.removeEventListener('dragover', keep);
      window.removeEventListener('drop', keep);
    };
  }, []);

  const send = async (file: File | undefined) => {
    if (!file || state.kind === 'sending') return;
    if (!RECORDING.test(file.name)) {
      setState({ kind: 'failed', message: 'That doesn’t look like a recording. Drop an audio or video file, such as .m4a, .mp3, .wav or .mov.' });
      return;
    }
    if (file.size > LIMIT) {
      setState({ kind: 'failed', message: 'That recording is over 4 GB. Export it as audio (.m4a) and drop that instead.' });
      return;
    }
    setState({ kind: 'sending', name: file.name });
    try {
      await upload(video, file);
      setState({ kind: 'sent', name: file.name });
    } catch (e) {
      setState({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <section
      className="vo-drop"
      aria-label="Voice-over"
      data-over={over ? 'true' : undefined}
      aria-busy={state.kind === 'sending'}
      onDragEnter={(e) => hasFiles(e) && setOver(true)}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void send(e.dataTransfer?.files?.[0]);
      }}
    >
      <span className="vo-drop__icon">
        <Icon name="record_voice_over" />
      </span>
      <div className="vo-drop__body">
        <h2 className="vo-drop__title">Record your voice-over</h2>
        <p>Play this guide and read the lines out loud as they come up. Record yourself with QuickTime or your phone, then drop the recording here.</p>
        <div className="vo-drop__actions">
          <Button variant="tonal" icon="upload_file" onClick={() => input.current?.click()} disabled={state.kind === 'sending'}>
            Choose file
          </Button>
          <input
            ref={input}
            type="file"
            accept="audio/*,video/*,.m4a,.caf,.aif,.aiff"
            hidden
            tabIndex={-1}
            onChange={(e) => {
              void send(e.currentTarget.files?.[0]);
              e.currentTarget.value = '';
            }}
          />
          <p className="vo-drop__status" role="status">
            {state.kind === 'sending' && (
              <>
                <Spinner size={16} /> Sending “{state.name}”…
              </>
            )}
            {state.kind === 'sent' && (
              <>
                <Icon name="check" size={18} /> Got “{state.name}”. Claude is fitting it to the guide now.
              </>
            )}
          </p>
        </div>
        {state.kind === 'failed' && (
          <p className="vo-drop__error" role="alert">
            {state.message}
          </p>
        )}
      </div>
    </section>
  );
}

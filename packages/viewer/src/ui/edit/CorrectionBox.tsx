// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { Button } from '../components/Button.js';
import { TextField } from '../components/TextField.js';

const LIMIT = 2000;

/** While paused: what Mirage should change, sent along with resuming. Ctrl/⌘+Enter sends it too. */
export function CorrectionBox({ onResume, disabled }: { onResume: (correction: string) => Promise<boolean> | boolean; disabled?: boolean }) {
  const [text, setText] = useState('');
  const ready = text.trim().length > 0 && !disabled;
  const send = async () => {
    if (!ready) return;
    // Kept when sending failed, so nothing typed is lost.
    if (await onResume(text.trim())) setText('');
  };
  return (
    <div className="correction">
      <TextField
        label="Correction"
        value={text}
        onChange={setText}
        placeholder="Tell Mirage what to change…"
        multiline
        rows={2}
        maxLength={LIMIT}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <Button variant="tonal" icon="send" onClick={() => void send()} disabled={!ready}>
        Resume with this
      </Button>
    </div>
  );
}

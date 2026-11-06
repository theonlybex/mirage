// SPDX-License-Identifier: MIT
import { Button } from '../components/Button.js';
import { Dialog, DialogClose } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';

type StopDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The last finished step the edit goes back to, when there is one. */
  label: string | null;
  onStop: () => void;
};

/** Confirms Stop, saying where the edit goes back to. "Keep editing" has the focus: it is the safe answer. */
export function StopDialog({ open, onOpenChange, label, onStop }: StopDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      role="alertdialog"
      icon={<Icon name="stop_circle" />}
      title="Stop the edit?"
      actions={
        <>
          <DialogClose asChild>
            <Button variant="text" autoFocus>
              Keep editing
            </Button>
          </DialogClose>
          <Button
            variant="text"
            tone="error"
            onClick={() => {
              onStop();
              onOpenChange(false);
            }}
          >
            Stop
          </Button>
        </>
      }
    >
      {label !== null ? (
        <p>Mirage goes back to the last finished step, “{label}”. Nothing before it is lost.</p>
      ) : (
        <p>Mirage goes back to how the video was before this edit. Nothing before it is lost.</p>
      )}
    </Dialog>
  );
}

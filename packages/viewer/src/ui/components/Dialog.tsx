// SPDX-License-Identifier: AGPL-3.0-or-later
import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** The supporting text. */
  children: ReactNode;
  /** The buttons, right-aligned; wrap one in `<DialogClose asChild>` to close on click. */
  actions: ReactNode;
  /** `alertdialog` for a confirmation that interrupts (Stop). */
  role?: 'dialog' | 'alertdialog';
  icon?: ReactNode;
};

export const DialogClose = RadixDialog.Close;

/** An M3 basic dialog (Radix Dialog underneath): 28 px corners on surface-container-high, headline-small title, text actions. */
export function Dialog({ open, onOpenChange, title, children, actions, role = 'dialog', icon }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="m3-scrim" />
        <RadixDialog.Content className="m3-dialog" role={role} data-has-icon={icon ? 'true' : undefined}>
          {icon && <div className="m3-dialog__icon">{icon}</div>}
          <RadixDialog.Title className="m3-dialog__title">{title}</RadixDialog.Title>
          <RadixDialog.Description asChild>
            <div className="m3-dialog__body">{children}</div>
          </RadixDialog.Description>
          <div className="m3-dialog__actions">{actions}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

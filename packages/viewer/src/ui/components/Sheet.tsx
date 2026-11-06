// SPDX-License-Identifier: MIT
import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

type SheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
};

/** An M3 modal bottom sheet (Radix Dialog underneath): 28 px top corners, a drag handle, a scrim; Escape or the scrim closes it. */
export function Sheet({ open, onOpenChange, title, description, children }: SheetProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="m3-scrim" />
        <RadixDialog.Content className="m3-sheet" {...(description ? {} : { 'aria-describedby': undefined })}>
          <div className="m3-sheet__handle" aria-hidden="true" />
          <RadixDialog.Title className="m3-sheet__title">{title}</RadixDialog.Title>
          {description && <RadixDialog.Description className="m3-sheet__description">{description}</RadixDialog.Description>}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

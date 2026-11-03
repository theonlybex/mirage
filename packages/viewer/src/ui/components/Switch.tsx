// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId } from 'react';
import { Icon } from './Icon.js';

/** An M3 switch with its label beside it: a 52 × 32 track whose handle grows and shows a check when on. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  const id = useId();
  return (
    <span className="m3-switch-row">
      <button id={id} type="button" role="switch" aria-checked={checked} aria-label={label} className="m3-switch" onClick={() => onChange(!checked)}>
        <span className="m3-switch__handle">{checked && <Icon name="check" size={16} />}</span>
      </button>
      <label htmlFor={id} className="m3-switch-row__label" aria-hidden="true">
        {label}
      </label>
    </span>
  );
}

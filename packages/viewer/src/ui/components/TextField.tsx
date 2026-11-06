// SPDX-License-Identifier: MIT
import { useId, type KeyboardEvent, type Ref } from 'react';

type TextFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  supportingText?: string;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  disabled?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
  /** The text area, when `multiline`. */
  ref?: Ref<HTMLTextAreaElement>;
};

/** An M3 filled text field: label always visible, 4 px top corners, an active indicator that thickens on focus. */
export function TextField({ label, value, onChange, placeholder, supportingText, multiline = false, rows = 3, maxLength, disabled, onKeyDown, ref }: TextFieldProps) {
  const id = useId();
  const help = supportingText ? `${id}-help` : undefined;
  const common = {
    id,
    value,
    placeholder,
    maxLength,
    disabled,
    onKeyDown,
    'aria-describedby': help,
    className: 'm3-field__input',
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <div className="m3-field" data-disabled={disabled || undefined}>
      <div className="m3-field__container">
        <label className="m3-field__label" htmlFor={id}>
          {label}
        </label>
        {multiline ? <textarea {...common} ref={ref} rows={rows} /> : <input {...common} type="text" />}
      </div>
      {supportingText && (
        <p className="m3-field__support" id={help}>
          {supportingText}
        </p>
      )}
    </div>
  );
}

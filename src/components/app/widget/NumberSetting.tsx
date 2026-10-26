/**
 * A whole-number setting: typed freely (Persian digits too), saved on blur
 * or Enter when it is within [min, max]; otherwise it says so and saves
 * nothing. Follows the stored value while not being edited. `aside` sits
 * next to the field (a default it follows, a reset link).
 *
 * Widget → Behaviour → Conversation assignment and the Super Admin's
 * routing rules use it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { parseRoutingNumber } from '@/lib/chat-routing-api';

export function NumberSetting({
  id, label, hint, unit, value, min, max, disabled, onCommit, aside,
}: {
  id: string;
  label: string;
  hint?: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onCommit: (n: number) => void;
  aside?: ReactNode;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  const editing = useRef(false);

  useEffect(() => {
    if (editing.current) return;
    setText(String(value));
    setInvalid(false);
  }, [value]);

  const commit = () => {
    const n = parseRoutingNumber(text, min, max);
    if (typeof n !== 'number') {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText(String(n));
    if (n !== value) onCommit(n);
  };

  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={id} className="text-sm">{label}</Label>
        <div className="flex items-center gap-1.5">
          <Input
            id={id}
            type="text"
            inputMode="numeric"
            dir="ltr"
            className="h-8 w-20 text-center"
            value={text}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            onFocus={() => { editing.current = true; }}
            onChange={(e) => { setText(e.target.value); setInvalid(false); }}
            onBlur={() => { editing.current = false; commit(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              }
            }}
          />
          {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
        </div>
        {aside}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {invalid && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {t('widgetPage.behavior.assignment.invalidRange', { min, max })}
        </p>
      )}
    </div>
  );
}

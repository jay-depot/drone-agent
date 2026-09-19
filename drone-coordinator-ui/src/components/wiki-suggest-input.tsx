import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * A text input with an inline suggestion dropdown, modelled on the Config
 * page's key-completion UI. Suggestions are a convenience: typing is always
 * free-form, and choosing a suggestion replaces the current token only.
 */
export default function WikiSuggestInput({
  value,
  onChange,
  suggestions,
  placeholder,
  id,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  suggestions: string[];
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const visible = open && suggestions.length > 0;

  const applySuggestion = (suggestion: string) => {
    const lastComma = value.lastIndexOf(',');
    const head = lastComma === -1 ? '' : value.slice(0, lastComma + 1) + ' ';
    onChange(`${head}${suggestion}`);
    setOpen(false);
  };

  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={e => {
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {visible && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-input bg-background shadow-sm">
          {suggestions.map(suggestion => (
            <button
              key={suggestion}
              type="button"
              className="block w-full px-3 py-1 text-left text-xs hover:bg-muted"
              // Use onMouseDown so the click lands before the input's blur
              // closes the dropdown.
              onMouseDown={e => {
                e.preventDefault();
                applySuggestion(suggestion);
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

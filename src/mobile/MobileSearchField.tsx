/** iOS-style pinned search field used by the native screens. */
import { Search, X } from 'lucide-react';

export function MobileSearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute start-3 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect="off"
        className="h-10 w-full rounded-xl border border-border bg-muted/60 ps-9 pe-9 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50 focus:bg-card"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute end-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground active:bg-muted"
          aria-label="Clear"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

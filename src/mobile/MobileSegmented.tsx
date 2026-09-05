/** iOS-style segmented control with a sliding selection pill. */
import { cn } from '@/lib/utils';

export function MobileSegmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const index = Math.max(0, options.findIndex((o) => o.key === value));
  const width = 100 / options.length;

  return (
    <div className="relative flex h-9 items-stretch rounded-full bg-muted/80 p-[3px]">
      <span
        className="absolute inset-y-[3px] rounded-full bg-primary shadow-sm transition-transform duration-300 ease-out rtl:-scale-x-100"
        style={{
          width: `calc(${width}% - 4px)`,
          insetInlineStart: 3,
          transform: `translateX(calc(${index * 100}% + ${index * 4}px))`,
        }}
      />
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={cn(
            'relative z-10 flex-1 truncate rounded-full px-2 text-[13px] font-semibold transition-colors',
            value === o.key ? 'text-primary-foreground' : 'text-muted-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

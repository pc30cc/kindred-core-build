/**
 * Call Center — a duration with its unit spelled out beside the number.
 *
 * The service-level tiles used to render "۵د ۳۰ث": a bare letter glued to a
 * number, which reads as noise rather than as a unit. Here the unit is the
 * whole word ("ثانیه" / "seconds" / "saniye") but set much smaller than the
 * figure, so the number still carries the tile and the unit just labels it.
 *
 * The unit size is `em`-relative on purpose: the same component sits in a
 * `text-2xl` KPI tile and in a `text-xs` queue row, and in both it stays
 * proportional to whatever type size it lands in.
 */
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { callDurationParts } from '@/features/calls/callLabels';

export function CallDuration({
  seconds,
  className,
  /** Fraction of the surrounding font size used for the unit word. */
  unitScale = 0.45,
}: {
  seconds: number | null | undefined;
  className?: string;
  unitScale?: number;
}) {
  const { t } = useTranslation();
  const parts = callDurationParts(t, seconds);

  return (
    <span className={cn('inline-flex items-baseline gap-1', className)}>
      {parts.map((part) => (
        <span key={part.unit} className="inline-flex items-baseline gap-0.5">
          <span className="tabular-nums">{part.value}</span>
          {/* Inherits the tile's colour at reduced opacity rather than forcing
              a muted grey — the "longest wait" tile turns red past its SLA and
              the unit should follow the value, not clash with it. */}
          <span
            className="font-normal opacity-60 whitespace-nowrap"
            style={{ fontSize: `${unitScale}em` }}
          >
            {part.unit}
          </span>
        </span>
      ))}
    </span>
  );
}

export default CallDuration;

import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { CalendarIcon } from 'lucide-react';
import jalaali from 'jalaali-js';

function toJalaaliStr(date: Date): string {
  const j = jalaali.toJalaali(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return `${j.jy}/${String(j.jm).padStart(2, '0')}/${String(j.jd).padStart(2, '0')}`;
}

interface PersianDatePickerProps {
  value: string;
  onChange: (isoString: string) => void;
  className?: string;
  minDate?: Date;
}

export function PersianDatePicker({ value, onChange, className, minDate }: PersianDatePickerProps) {
  const { locale } = useTranslation();
  const isPersian = locale === 'fa';
  const [open, setOpen] = useState(false);

  const selectedDate = value ? new Date(value) : undefined;

  if (!isPersian) {
    return (
      <input
        type="datetime-local"
        value={value}
        onChange={e => onChange(e.target.value)}
        dir="ltr"
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 text-left text-xs",
          className
        )}
        min={minDate ? minDate.toISOString().slice(0, 16) : undefined}
      />
    );
  }

  const displayText = selectedDate ? toJalaaliStr(selectedDate) : 'تاریخ را انتخاب کنید';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "w-full justify-start text-right font-normal text-xs",
            !selectedDate && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="ml-2 h-4 w-4" />
          {displayText}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selectedDate}
          onSelect={(date) => {
            if (date) {
              onChange(date.toISOString());
              setOpen(false);
            }
          }}
          disabled={(date) => minDate ? date < minDate : false}
          initialFocus
          className="p-3 pointer-events-auto"
          formatters={{
            formatCaption: (date) => {
              const j = jalaali.toJalaali(date.getFullYear(), date.getMonth() + 1, date.getDate());
              const months = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
              return `${months[j.jm - 1]} ${j.jy}`;
            },
            formatDay: (date) => {
              const j = jalaali.toJalaali(date.getFullYear(), date.getMonth() + 1, date.getDate());
              return String(j.jd);
            },
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

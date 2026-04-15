import { useState } from 'react';
import DatePicker, { DateObject } from 'react-multi-date-picker';
import persian from 'react-multi-date-picker/calendars/persian';
import persian_fa from 'react-multi-date-picker/locales/persian_fa';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

interface PersianDatePickerProps {
  value: string; // ISO string or datetime-local format
  onChange: (isoString: string) => void;
  className?: string;
  placeholder?: string;
  minDate?: Date;
}

export function PersianDatePicker({ value, onChange, className, placeholder, minDate }: PersianDatePickerProps) {
  const { locale } = useTranslation();
  const isPersian = locale === 'fa';

  const dateValue = value ? new DateObject(new Date(value)) : undefined;

  if (!isPersian) {
    return (
      <input
        type="datetime-local"
        value={value}
        onChange={e => onChange(e.target.value)}
        dir="ltr"
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 text-left text-xs",
          className
        )}
        min={minDate ? minDate.toISOString().slice(0, 16) : undefined}
      />
    );
  }

  return (
    <DatePicker
      value={dateValue}
      onChange={(date: DateObject) => {
        if (date) {
          const jsDate = date.toDate();
          onChange(jsDate.toISOString());
        }
      }}
      calendar={persian}
      locale={persian_fa}
      calendarPosition="bottom-right"
      minDate={minDate ? new DateObject(minDate) : undefined}
      format="YYYY/MM/DD HH:mm"
      plugins={[]}
      placeholder={placeholder || 'تاریخ را انتخاب کنید'}
      style={{
        width: '100%',
        height: '40px',
        borderRadius: '6px',
        fontSize: '12px',
        padding: '0 12px',
        border: '1px solid hsl(var(--input))',
        backgroundColor: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))',
      }}
      containerStyle={{ width: '100%' }}
    />
  );
}

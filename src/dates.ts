import { z } from 'zod';

export const CalendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');

export function calendarValue(value: string, precision: string): boolean {
  if (precision === 'day') return CalendarDay.safeParse(value).success;
  if (precision === 'month') return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
  return precision === 'year' && /^\d{4}$/.test(value);
}

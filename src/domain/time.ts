import type { FreezeWindow } from './types';

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Weekday (0-6) and hour (0-23) of an instant in an IANA timezone. */
export function localDayHour(instant: Date, timezone: string): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const day = WEEKDAYS[weekday];
  if (day === undefined || Number.isNaN(hour)) {
    throw new Error(`Could not resolve local time for timezone ${timezone}`);
  }
  return { day, hour };
}

/**
 * True when the instant falls inside the window.
 * fromHour is inclusive and toHour exclusive. If fromHour > toHour the window wraps midnight,
 * and the day refers to the day the window starts on.
 */
export function inWindow(window: FreezeWindow, instant: Date): boolean {
  const { day, hour } = localDayHour(instant, window.timezone);
  const { fromHour, toHour, days } = window;
  if (fromHour === toHour) return days.includes(day); // whole day
  if (fromHour < toHour) return days.includes(day) && hour >= fromHour && hour < toHour;
  // Wraps midnight: e.g. Fri 18:00 -> Sat 06:00
  if (hour >= fromHour) return days.includes(day);
  const previousDay = (day + 6) % 7;
  return hour < toHour && days.includes(previousDay);
}

export function isExpired(expiresAt: string | undefined, now: Date): boolean {
  return expiresAt !== undefined && new Date(expiresAt).getTime() <= now.getTime();
}

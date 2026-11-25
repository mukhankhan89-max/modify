export interface PakistanDateTimeInfo {
  isoTimestamp: string;
  date: string;
  dayOfWeek: string;
  year: string;
  time12Hour: string;
  time24Hour: string;
  timezone: string;
}

const PAKISTAN_TIMEZONE = 'Asia/Karachi';

// Cache Intl.DateTimeFormat instances at module scope to avoid per-request ICU initialization overhead
const pktDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PAKISTAN_TIMEZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const pktDayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PAKISTAN_TIMEZONE,
  weekday: 'long',
});

const pktYearFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PAKISTAN_TIMEZONE,
  year: 'numeric',
});

const pktTime12Formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PAKISTAN_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

const pktTime24Formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: PAKISTAN_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function getPakistanDateTime(now: Date = new Date()): PakistanDateTimeInfo {
  return {
    isoTimestamp: now.toISOString(),
    date: pktDateFormatter.format(now),
    dayOfWeek: pktDayFormatter.format(now),
    year: pktYearFormatter.format(now),
    time12Hour: pktTime12Formatter.format(now),
    time24Hour: pktTime24Formatter.format(now),
    timezone: 'Asia/Karachi (PKT, UTC+05:00)',
  };
}

export function buildSystemInstruction(
  baseInstruction: string,
  now: Date = new Date()
): string {
  const pkt = getPakistanDateTime(now);
  return `${baseInstruction}\nNow (PKT, Asia/Karachi UTC+05:00): ${pkt.dayOfWeek}, ${pkt.date}, ${pkt.time12Hour} (${pkt.time24Hour}). Use this exact date/time for any date, day, year, or time question; never guess or use UTC.`;
}

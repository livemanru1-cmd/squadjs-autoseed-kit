import crypto from 'crypto';

const PUBLIC_SESSION_ID_PATTERN = /^s1_[a-f0-9]{24}$/;
const SQUAD_LOG_TIMESTAMP_PATTERN =
  /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{1,3})$/;

function parseSquadLogTimestamp(value) {
  const match = String(value ?? '')
    .trim()
    .match(SQUAD_LOG_TIMESTAMP_PATTERN);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, milliseconds] = match;
  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(milliseconds.padEnd(3, '0'))
  );
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  ) {
    return null;
  }
  return date;
}

export function resolveEventDate(value, fallback = new Date()) {
  const hasValue = value !== null && typeof value !== 'undefined' && value !== '';
  const candidate = hasValue
    ? value instanceof Date
      ? new Date(value.getTime())
      : new Date(value)
    : new Date(Number.NaN);
  if (!Number.isNaN(candidate.getTime())) return candidate;

  const squadLogDate = parseSquadLogTimestamp(value);
  if (squadLogDate) return squadLogDate;

  const fallbackDate = fallback instanceof Date ? new Date(fallback.getTime()) : new Date(fallback);
  if (!Number.isNaN(fallbackDate.getTime())) return fallbackDate;
  return new Date();
}

export function normalizeSessionEndedAt(value, fallback = new Date()) {
  const date = resolveEventDate(value, fallback);
  date.setMilliseconds(0);
  return date.toISOString();
}

export function buildPublicSessionId(serverID, endedAt) {
  const normalizedServerID = String(serverID ?? '').trim() || 'unknown';
  const normalizedEndedAt = normalizeSessionEndedAt(endedAt);
  const digest = crypto
    .createHash('sha256')
    .update(`squad-session:v1:${normalizedServerID}:${normalizedEndedAt}`)
    .digest('hex')
    .slice(0, 24);
  return `s1_${digest}`;
}

export function isPublicSessionId(value) {
  return PUBLIC_SESSION_ID_PATTERN.test(String(value ?? ''));
}

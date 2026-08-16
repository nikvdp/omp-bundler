/**
 * Self-contained 5-field POSIX-style cron expression parser and next-fire-time
 * calculator. Pure, deterministic, dependency-free — uses only `Intl` (ECMA-402)
 * for timezone-aware arithmetic.
 *
 * Field grammar (comma-separated parts, optional `N` step):
 *   `*`/N        every N-th value across the field's full range
 *   `A`          the single value A
 *   `A-B`        every value from A to B inclusive (wrap-around when A > B)
 *   `A-B`/N      every N-th value within A..B
 *   `A`/M        every M-th value from A to the range max (Vixie/Quartz style)
 *
 * Named macros (`@reboot`, ...) and L/W/# modifiers are rejected for v1.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parsed cron schedule: each field is the sorted list of matching values. */
export interface CronSchedule {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  /** Normalized to 0-6 with 0 = Sunday. */
  dayOfWeek: number[];
}

// ---------------------------------------------------------------------------
// Field definition & parsing
// ---------------------------------------------------------------------------

interface FieldDef {
  name: string;
  min: number;
  /** Inclusive upper bound accepted in input. */
  max: number;
}

const FIELDS: FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

// Matches `*`, `A`, or `A-B`, each optionally followed by a `/step`.
const PART_RE = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;

/**
 * Parse one comma-separated field into the sorted list of matching values,
 * normalized so day-of-week uses 0-6 (input 7 collapses to 0 = Sunday).
 */
function parseField(raw: string, def: FieldDef): number[] {
  const values: number[] = [];
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (p.length === 0) throw new Error(`empty list element in "${raw}"`);
    const m = PART_RE.exec(p);
    if (!m) {
      throw new Error(
        `invalid ${def.name} field part "${p}" (expected *, A, A-B, or a /step form)`,
      );
    }
    const start = m[1] === undefined ? def.min : Number(m[1]);
    const end = m[1] === undefined ? def.max : m[2] !== undefined ? Number(m[2]) : start;
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    if (step < 1) throw new Error(`invalid step value ${step} in "${p}"`);
    if (start < def.min || end < def.min || start > def.max || end > def.max) {
      throw new Error(
        `${def.name} value out of range in "${p}" (valid ${def.min}-${def.max})`,
      );
    }
    if (start <= end) {
      for (let v = start; v <= end; v += step) values.push(v);
    } else {
      // Wrap-around range (e.g. "55-5" in minutes): start..max then min..end,
      // stepping from the range start (Vixie behaviour).
      const seq: number[] = [];
      for (let v = start; v <= def.max; v++) seq.push(v);
      for (let v = def.min; v <= end; v++) seq.push(v);
      for (let i = 0; i < seq.length; i += step) values.push(seq[i]);
    }
  }
  let uniq = [...new Set(values)];
  if (def.max === 7) uniq = uniq.map((v) => (v === 7 ? 0 : v));
  return [...new Set(uniq)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// parseCronExpression
// ---------------------------------------------------------------------------

/**
 * Parse a 5-field cron expression ("minute hour day-of-month month day-of-week")
 * into a {@link CronSchedule}. Throws `Error` on malformed input: wrong field
 * count, out-of-range values, named macros (`@reboot`), or L/W/# modifiers.
 */
export function parseCronExpression(expr: string): CronSchedule {
  const trimmed = expr.trim();
  if (trimmed.startsWith("@")) {
    throw new Error(`named cron macros are not supported: "${trimmed.split(/\s+/)[0]}"`);
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have exactly 5 fields, got ${fields.length}: "${expr}"`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map(
    (f, i) => parseField(f, FIELDS[i]),
  );
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

function partOf(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const found = parts.find((p) => p.type === type);
  if (!found) throw new Error(`timezone formatting did not produce "${type}"`);
  return Number(found.value);
}

/**
 * UTC offset (ms, local = utc + offset) of `epochMs` in the target timezone,
 * derived from the "GMT±HH:MM" name produced by a longOffset formatter.
 */
function offsetMs(fmt: Intl.DateTimeFormat, epochMs: number): number {
  const name = fmt.formatToParts(epochMs).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  if (name === "GMT" || name === "UTC") return 0;
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (!m) throw new Error(`unable to interpret timezone offset "${name}"`);
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + (m[3] !== undefined ? Number(m[3]) : 0)) * 60000;
}

/** Does the wall clock of `epochMs` in the target tz equal the given parts? */
function wallEquals(fmt: Intl.DateTimeFormat, epochMs: number, y: number, m0: number, d: number, h: number, min: number): boolean {
  const parts = fmt.formatToParts(epochMs);
  return (
    partOf(parts, "year") === y &&
    partOf(parts, "month") - 1 === m0 &&
    partOf(parts, "day") === d &&
    partOf(parts, "hour") === h &&
    partOf(parts, "minute") === min
  );
}

/**
 * Convert a target-timezone wall clock to an epoch ms, or null when the wall
 * time does not exist (spring-forward gap). Iterates at most twice to converge
 * on the DST-valid offset.
 */
function wallToEpoch(wall: Intl.DateTimeFormat, offset: Intl.DateTimeFormat, y: number, m0: number, d: number, h: number, min: number): number | null {
  const guess = Date.UTC(y, m0, d, h, min);
  let cand = guess - offsetMs(offset, guess);
  if (wallEquals(wall, cand, y, m0, d, h, min)) return cand;
  cand = guess - offsetMs(offset, cand);
  if (wallEquals(wall, cand, y, m0, d, h, min)) return cand;
  return null;
}

// ---------------------------------------------------------------------------
// nextRunAfter
// ---------------------------------------------------------------------------

/** Days scanned forward before giving up (366 days = the minute-search cap). */
const MAX_DAYS = 366;

/**
 * Return the epoch ms of the next fire time strictly after `afterEpochMs` that
 * matches `schedule`, interpreted in the IANA `timezone`.
 *
 * Walks forward by whole days in the target timezone, then tries the schedule's
 * (hour, minute) combinations for each matching day, so at most a handful of
 * timezone conversions happen per call. Throws if the timezone is invalid or no
 * fire time exists within the 366-day search window.
 */
export function nextRunAfter(schedule: CronSchedule, afterEpochMs: number, timezone: string): number {
  let wall: Intl.DateTimeFormat;
  let offset: Intl.DateTimeFormat;
  try {
    wall = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    offset = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
  } catch {
    throw new Error(`invalid timezone: "${timezone}"`);
  }

  // Wall clock of `afterEpochMs` in the target timezone.
  const start = wall.formatToParts(afterEpochMs);
  let y = partOf(start, "year");
  let m0 = partOf(start, "month") - 1;
  let d = partOf(start, "day");
  const afterHour = partOf(start, "hour");
  const afterMinute = partOf(start, "minute");
  let weekday = new Date(Date.UTC(y, m0, d)).getUTCDay();

  const { minute, hour, dayOfMonth, month, dayOfWeek } = schedule;
  const domAll = dayOfMonth.length === 31;
  const dowAll = dayOfWeek.length === 7;

  for (let day = 0; day < MAX_DAYS; day++) {
    const monthMatches = month.includes(m0 + 1);
    let dayMatches: boolean;
    if (domAll && dowAll) {
      dayMatches = true;
    } else if (domAll) {
      dayMatches = dayOfWeek.includes(weekday);
    } else if (dowAll) {
      dayMatches = dayOfMonth.includes(d);
    } else {
      // Vixie OR semantics: fire when dom OR dow matches.
      dayMatches = dayOfMonth.includes(d) || dayOfWeek.includes(weekday);
    }
    dayMatches = dayMatches && monthMatches;

    if (dayMatches) {
      for (const hh of hour) {
        for (const mm of minute) {
          if (day === 0 && (hh < afterHour || (hh === afterHour && mm <= afterMinute))) {
            continue;
          }
          const cand = wallToEpoch(wall, offset, y, m0, d, hh, mm);
          if (cand !== null && cand > afterEpochMs) return cand;
        }
      }
    }

    // Advance to the next calendar day in the target timezone.
    const nextDay = new Date(Date.UTC(y, m0, d + 1));
    y = nextDay.getUTCFullYear();
    m0 = nextDay.getUTCMonth();
    d = nextDay.getUTCDate();
    weekday = (weekday + 1) % 7;
  }

  throw new Error("cron expression never matches within the search window");
}

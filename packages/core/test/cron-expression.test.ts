import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  nextRunAfter,
  parseCronExpression,
} from "../src/cron-expression.ts";

// ---------------------------------------------------------------------------
// parseCronExpression
// ---------------------------------------------------------------------------

test("'* * * * *' yields full-range arrays of the right sizes", () => {
  const s = parseCronExpression("* * * * *");
  assert.equal(s.minute.length, 60);
  assert.equal(s.hour.length, 24);
  assert.equal(s.dayOfMonth.length, 31);
  assert.equal(s.month.length, 12);
  assert.equal(s.dayOfWeek.length, 7);
  assert.deepEqual(s.minute, range(0, 59));
  assert.deepEqual(s.hour, range(0, 23));
  assert.deepEqual(s.dayOfMonth, range(1, 31));
  assert.deepEqual(s.month, range(1, 12));
  assert.deepEqual(s.dayOfWeek, range(0, 6));
});

test("'0 9 * * 1-5' parses minute, hour and weekday ranges", () => {
  const s = parseCronExpression("0 9 * * 1-5");
  assert.deepEqual(s.minute, [0]);
  assert.deepEqual(s.hour, [9]);
  assert.deepEqual(s.dayOfWeek, [1, 2, 3, 4, 5]);
});

test("step values: */15 minute and 9-17/2 hour", () => {
  const s = parseCronExpression("*/15 9-17/2 * * *");
  assert.deepEqual(s.minute, [0, 15, 30, 45]);
  assert.deepEqual(s.hour, [9, 11, 13, 15, 17]);
});

test("day-of-week 7 normalizes to 0 and 0-6 covers every weekday", () => {
  assert.deepEqual(parseCronExpression("* * * * 7").dayOfWeek, [0]);
  assert.deepEqual(parseCronExpression("* * * * 0-6").dayOfWeek, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseCronExpression("* * * * 1-7").dayOfWeek, [0, 1, 2, 3, 4, 5, 6]);
});

test("comma lists deduplicate and sort", () => {
  const s = parseCronExpression("5,5,0,3 * * * *");
  assert.deepEqual(s.minute, [0, 3, 5]);
});

test("invalid expressions throw", () => {
  assert.throws(() => parseCronExpression("* * *"), /exactly 5 fields/);
  assert.throws(() => parseCronExpression("* * * * * *"), /exactly 5 fields/);
  assert.throws(() => parseCronExpression("60 * * * *"), /out of range/);
  assert.throws(() => parseCronExpression("0 0 32 * *"), /out of range/);
  assert.throws(() => parseCronExpression("@reboot"), /macros are not supported/);
  assert.throws(() => parseCronExpression("0 0 L * *"), /invalid/);
  assert.throws(() => parseCronExpression("0 0 1 * 8"), /out of range/);
  assert.throws(() => parseCronExpression("1..5 * * * *"), /invalid/);
  assert.throws(() => parseCronExpression(""), /exactly 5 fields/);
});

// ---------------------------------------------------------------------------
// nextRunAfter
// ---------------------------------------------------------------------------

const FRIDAY = Date.UTC(2026, 7, 7); // 2026-08-07
assert.equal(new Date(FRIDAY).getUTCDay(), 5, "test fixture must be a Friday");

test("daily 9am UTC fires same day when already past 8am, next day after 10am", () => {
  const s = parseCronExpression("0 9 * * *");
  assert.equal(nextRunAfter(s, Date.UTC(2026, 7, 6, 8, 0), "UTC"), Date.UTC(2026, 7, 6, 9, 0));
  assert.equal(nextRunAfter(s, Date.UTC(2026, 7, 6, 10, 0), "UTC"), Date.UTC(2026, 7, 7, 9, 0));
  // Strictly-after: firing exactly at the fire time schedules the next day.
  assert.equal(nextRunAfter(s, Date.UTC(2026, 7, 6, 9, 0), "UTC"), Date.UTC(2026, 7, 7, 9, 0));
});

test("weekday-only schedule skips the weekend", () => {
  const s = parseCronExpression("0 9 * * 1-5");
  // Friday 10am → Monday 9am (Sat/Sun excluded).
  assert.equal(nextRunAfter(s, Date.UTC(2026, 7, 7, 10, 0), "UTC"), Date.UTC(2026, 7, 10, 9, 0));
});

test("day-of-month and day-of-week use Vixie OR semantics", () => {
  const s = parseCronExpression("0 0 1 * 1");
  // 2026-08-01 is a Saturday: not a Monday, so a dom=1-only fire proves the
  // first-of-month branch matches.
  assert.notEqual(new Date(Date.UTC(2026, 7, 1)).getUTCDay(), 1);
  assert.equal(nextRunAfter(s, Date.UTC(2026, 6, 31, 23, 59), "UTC"), Date.UTC(2026, 7, 1, 0, 0));
  // After the 1st passes (00:00:01), the next fire is the following Monday.
  assert.equal(nextRunAfter(s, Date.UTC(2026, 7, 1, 0, 0, 1), "UTC"), Date.UTC(2026, 7, 3, 0, 0));
});

test("timezone: 9am New York from an 8am New York instant", () => {
  const s = parseCronExpression("0 9 * * *");
  // Aug 2026: New York is EDT (UTC-4), so 8am NY == 12:00 UTC.
  const after = Date.UTC(2026, 7, 6, 12, 0);
  const result = nextRunAfter(s, after, "America/New_York");
  // 9am NY == 13:00 UTC — a different UTC instant than 9am UTC.
  assert.equal(result, Date.UTC(2026, 7, 6, 13, 0));
  assert.notEqual(result, Date.UTC(2026, 7, 6, 9, 0));
});

test("a 9am-New-York schedule also fires on a DST-transition day", () => {
  const s = parseCronExpression("0 9 * * *");
  // 2026-11-01 is the US fall-back (clocks 2am->1am EST). 09:00 local = 14:00 UTC.
  assert.equal(nextRunAfter(s, Date.UTC(2026, 9, 31, 14, 0), "America/New_York"), Date.UTC(2026, 10, 1, 14, 0));
});

test("Feb 30 never matches within the search window", () => {
  const s = parseCronExpression("0 0 31 2 *");
  assert.throws(() => nextRunAfter(s, Date.UTC(2026, 0, 1), "UTC"), /never matches within the search window/);
});

test("invalid timezone throws", () => {
  const s = parseCronExpression("0 9 * * *");
  assert.throws(() => nextRunAfter(s, Date.UTC(2026, 7, 6, 8, 0), "Not/AZone"), /invalid timezone/);
});

test("fire time is always strictly after the reference instant", () => {
  const s = parseCronExpression("*/15 * * * *");
  // Reference exactly on a fire minute: the next fire is 15 minutes later.
  assert.equal(nextRunAfter(s, Date.UTC(2026, 7, 6, 10, 0), "UTC"), Date.UTC(2026, 7, 6, 10, 15));
});

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

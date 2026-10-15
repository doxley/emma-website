// When each service can be booked online.
import assert from "node:assert/strict";
const { allowedStart, kindOf, searchWindow } = await import("../api/_rules.js");

const now = new Date("2026-10-15T11:00:00Z");
const course = { name: "Tarot training: Understanding the basics", minutes: 180 };
const next = { name: "Tarot training: Next level", minutes: 180 };
const online = { name: "Online tarot reading", minutes: 60 };
const reiki = { name: "Reiki", minutes: 60 };

assert.equal(kindOf(course.name), "training");
assert.equal(kindOf(next.name), "training");
assert.equal(kindOf(online.name), "online");
assert.equal(kindOf(reiki.name), "inPerson");

// Courses: Tuesdays 1pm / 5pm UK time, 3 Nov – 22 Dec 2026 (UK is on GMT then, so UTC = UK time)
assert.ok(allowedStart(course, "2026-11-03T13:00:00Z", now), "first date, 1pm");
assert.ok(allowedStart(next, "2026-11-03T17:00:00Z", now), "first date, 5pm");
assert.ok(allowedStart(course, "2026-12-22T17:00:00Z", now), "last date, 5pm");
assert.ok(!allowedStart(course, "2026-11-03T14:00:00Z", now), "2pm isn't a course start");
assert.ok(!allowedStart(course, "2026-11-03T12:00:00Z", now), "noon isn't a course start");
assert.ok(!allowedStart(course, "2026-10-27T13:00:00Z", now), "before 3 Nov");
assert.ok(!allowedStart(course, "2026-12-29T13:00:00Z", now), "after 22 Dec");
assert.ok(!allowedStart(course, "2026-11-04T13:00:00Z", now), "Wednesday");
console.log("✓ courses: Tuesdays 1–4pm or 5–8pm, 3 Nov – 22 Dec only");

// Online tarot: any Tuesday hour; in person: Wed–Fri
assert.ok(allowedStart(online, "2026-11-03T15:00:00Z", now));
assert.ok(!allowedStart(online, "2026-11-04T15:00:00Z", now));
assert.ok(allowedStart(reiki, "2026-11-04T15:00:00Z", now));
assert.ok(!allowedStart(reiki, "2026-11-03T15:00:00Z", now));
console.log("✓ online tarot Tuesdays, treatments Wednesday–Friday (unchanged)");

// Nothing same-day
assert.ok(!allowedStart(reiki, "2026-10-15T15:00:00Z", now));
console.log("✓ no same-day online bookings");

// Courses are searched across their whole date range, not just 3 weeks
const w = searchWindow(course, now);
assert.equal(w.start.toISOString().slice(0, 10), "2026-11-03");
assert.equal(w.end.toISOString().slice(0, 10), "2026-12-22");
console.log("✓ course dates offered right through to 22 December");

// Launch offer: in-person £25 for bookings made up to and including 30 Oct 2026 (UK time)
const { priceFor } = await import("../api/_rules.js");
const reikiP = { name: "Reiki", amount: 4000, currency: "GBP" };
const onlineP = { name: "Online tarot reading", amount: 3000, currency: "GBP" };
const courseP = { name: "Tarot training: Next level", amount: 11000, currency: "GBP" };
assert.equal(priceFor(reikiP, new Date("2026-10-15T12:00:00Z")).amount, 2500);
assert.equal(priceFor(reikiP, new Date("2026-10-30T22:59:00Z")).amount, 2500, "last minute of 30 Oct UK time (GMT)");
assert.equal(priceFor(reikiP, new Date("2026-10-31T00:00:00Z")).amount, 4000, "back to £40 from 31 Oct");
assert.equal(priceFor(onlineP, new Date("2026-10-15T12:00:00Z")).amount, 3000, "online tarot unchanged");
assert.equal(priceFor(courseP, new Date("2026-10-15T12:00:00Z")).amount, 11000, "courses unchanged");
console.log("✓ launch offer: in-person £25 until end of 30 Oct, online tarot and courses unchanged");

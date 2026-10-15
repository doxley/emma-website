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

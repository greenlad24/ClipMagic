'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  isWeekend,
  nextMonday,
  suggestSendTime,
  normalizePhone,
  toChatId,
  parseWhen,
  validateSchedule,
  parseChatCommand,
} = require('../server/schedule-logic');

// Fixed reference points (server-local time), verified day-of-week:
//   SAT = Saturday 2026-07-25 10:00
//   WED = Wednesday 2026-07-22 12:00
//   MON = Monday    2026-07-27 08:00
const SAT = new Date(2026, 6, 25, 10, 0, 0, 0);
const WED = new Date(2026, 6, 22, 12, 0, 0, 0);
const MON = new Date(2026, 6, 27, 8, 0, 0, 0);

test('isWeekend', () => {
  assert.strictEqual(isWeekend(SAT), true); // Saturday
  assert.strictEqual(isWeekend(new Date(2026, 6, 26, 10, 0, 0)), true); // Sunday
  assert.strictEqual(isWeekend(WED), false); // Wednesday
  assert.strictEqual(isWeekend(MON), false); // Monday
});

test('nextMonday from a Saturday -> upcoming Monday 09:00', () => {
  const m = nextMonday(SAT, 9, 0);
  assert.strictEqual(m.getFullYear(), 2026);
  assert.strictEqual(m.getMonth(), 6);
  assert.strictEqual(m.getDate(), 27);
  assert.strictEqual(m.getDay(), 1);
  assert.strictEqual(m.getHours(), 9);
  assert.strictEqual(m.getMinutes(), 0);
});

test('nextMonday when today is Monday and time still ahead -> today', () => {
  // MON is 08:00; requesting 09:00 which is later today.
  const m = nextMonday(MON, 9, 0);
  assert.strictEqual(m.getDate(), 27);
  assert.strictEqual(m.getHours(), 9);
});

test('nextMonday when today is Monday and time already passed -> next week', () => {
  const mondayLate = new Date(2026, 6, 27, 10, 0, 0); // Monday 10:00
  const m = nextMonday(mondayLate, 9, 0);
  assert.strictEqual(m.getMonth(), 7); // August (0-indexed)
  assert.strictEqual(m.getDate(), 3); // 2026-08-03
  assert.strictEqual(m.getDay(), 1);
  assert.strictEqual(m.getHours(), 9);
});

test('suggestSendTime on weekend suggests Monday', () => {
  const r = suggestSendTime(SAT);
  assert.strictEqual(r.isWeekend, true);
  assert.strictEqual(r.suggested.getDay(), 1);
  assert.strictEqual(r.suggested.getHours(), 9);
  assert.ok(r.reason.length > 0);
  // defaultSend = now + 1h rounded up to 5 min = 11:00
  assert.strictEqual(r.defaultSend.getHours(), 11);
  assert.strictEqual(r.defaultSend.getMinutes(), 0);
});

test('suggestSendTime on a weekday suggests default (now+1h rounded up 5min)', () => {
  const base = new Date(2026, 6, 22, 12, 1, 30); // Wed 12:01:30
  const r = suggestSendTime(base);
  assert.strictEqual(r.isWeekend, false);
  assert.strictEqual(r.reason, '');
  // 12:01:30 + 1h = 13:01:30 -> round up to 13:05:00
  assert.strictEqual(r.suggested.getHours(), 13);
  assert.strictEqual(r.suggested.getMinutes(), 5);
  assert.strictEqual(r.suggested.getSeconds(), 0);
  assert.strictEqual(r.defaultSend.getTime(), r.suggested.getTime());
});

test('normalizePhone valid formats', () => {
  assert.deepStrictEqual(normalizePhone('+44 7911 123456'), {
    ok: true,
    value: '447911123456',
  });
  assert.deepStrictEqual(normalizePhone('(044) 791-1123'), {
    ok: true,
    value: '0447911123',
  });
});

test('normalizePhone invalid formats', () => {
  assert.strictEqual(normalizePhone('123').ok, false); // too short
  assert.strictEqual(normalizePhone('1234567890123456').ok, false); // 16 digits, too long
  assert.strictEqual(normalizePhone('').ok, false);
  assert.strictEqual(normalizePhone(null).ok, false);
  assert.strictEqual(normalizePhone('abc').ok, false);
});

test('toChatId', () => {
  assert.strictEqual(toChatId('447911123456'), '447911123456@c.us');
});

test('parseWhen relative forms', () => {
  assert.strictEqual(parseWhen('in 2h', WED).getTime(), WED.getTime() + 2 * 3600000);
  assert.strictEqual(parseWhen('in 30m', WED).getTime(), WED.getTime() + 30 * 60000);
  assert.strictEqual(parseWhen('in 90 mins', WED).getTime(), WED.getTime() + 90 * 60000);
  assert.strictEqual(parseWhen('in 1 day', WED).getTime(), WED.getTime() + 86400000);
  assert.strictEqual(parseWhen('in 3 days', WED).getTime(), WED.getTime() + 3 * 86400000);
  assert.strictEqual(parseWhen('in 1 hour', WED).getTime(), WED.getTime() + 3600000);
});

test('parseWhen tomorrow / today with time', () => {
  const tmr9 = parseWhen('tomorrow at 9am', WED);
  assert.strictEqual(tmr9.getDate(), 23);
  assert.strictEqual(tmr9.getHours(), 9);
  assert.strictEqual(tmr9.getMinutes(), 0);

  const tmrDefault = parseWhen('tomorrow', WED);
  assert.strictEqual(tmrDefault.getDate(), 23);
  assert.strictEqual(tmrDefault.getHours(), 9); // default 09:00

  const today3 = parseWhen('today at 3pm', WED);
  assert.strictEqual(today3.getDate(), 22);
  assert.strictEqual(today3.getHours(), 15);

  const today2100 = parseWhen('today 21:00', WED);
  assert.strictEqual(today2100.getHours(), 21);
  assert.strictEqual(today2100.getMinutes(), 0);

  const todayMil = parseWhen('today 0900', WED);
  assert.strictEqual(todayMil.getHours(), 9);
  assert.strictEqual(todayMil.getMinutes(), 0);
});

test('parseWhen weekday names (full + short), next strict future', () => {
  // Wed -> Friday is +2 days
  const fri = parseWhen('friday at 14:30', WED);
  assert.strictEqual(fri.getDate(), 24);
  assert.strictEqual(fri.getDay(), 5);
  assert.strictEqual(fri.getHours(), 14);
  assert.strictEqual(fri.getMinutes(), 30);

  const mon = parseWhen('mon', WED); // -> 2026-07-27 09:00 default
  assert.strictEqual(mon.getDate(), 27);
  assert.strictEqual(mon.getHours(), 9);

  // Same weekday, time still ahead -> today
  const wedLater = parseWhen('wed at 3pm', WED);
  assert.strictEqual(wedLater.getDate(), 22);
  assert.strictEqual(wedLater.getHours(), 15);

  // Same weekday, time already passed -> next week
  const wedPassed = parseWhen('wed at 9am', WED); // WED is 12:00, 9am passed
  assert.strictEqual(wedPassed.getDate(), 29);
  assert.strictEqual(wedPassed.getHours(), 9);
});

test('parseWhen ISO-ish', () => {
  const d = parseWhen('2026-08-01T09:30', WED);
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 7);
  assert.strictEqual(d.getDate(), 1);
  assert.strictEqual(d.getHours(), 9);
  assert.strictEqual(d.getMinutes(), 30);

  const d2 = parseWhen('2026-08-01 21:00', WED);
  assert.strictEqual(d2.getHours(), 21);

  const dateOnly = parseWhen('2026-08-01', WED);
  assert.strictEqual(dateOnly.getHours(), 9); // default 09:00
});

test('parseWhen unparseable -> null', () => {
  assert.strictEqual(parseWhen('gibberish', WED), null);
  assert.strictEqual(parseWhen('', WED), null);
  assert.strictEqual(parseWhen('in 2 fortnights', WED), null);
  assert.strictEqual(parseWhen('today at 99pm', WED), null);
});

test('validateSchedule', () => {
  const future = WED.getTime() + 3600000;
  const okRes = validateSchedule(
    { to: '447911123456', text: 'hi', when: future },
    WED
  );
  assert.strictEqual(okRes.ok, true);
  assert.deepStrictEqual(okRes.errors, []);

  const past = validateSchedule(
    { to: '447911123456', text: 'hi', when: WED.getTime() - 1000 },
    WED
  );
  assert.strictEqual(past.ok, false);

  const badPhone = validateSchedule({ to: '12', text: 'hi', when: future }, WED);
  assert.strictEqual(badPhone.ok, false);

  const noText = validateSchedule(
    { to: '447911123456', text: '   ', when: future },
    WED
  );
  assert.strictEqual(noText.ok, false);

  const badWhen = validateSchedule(
    { to: '447911123456', text: 'hi', when: 'soon' },
    WED
  );
  assert.strictEqual(badWhen.ok, false);

  // now as epoch ms also works
  const okMs = validateSchedule(
    { to: '447911123456', text: 'hi', when: future },
    WED.getTime()
  );
  assert.strictEqual(okMs.ok, true);
});

test('parseChatCommand happy paths', () => {
  const r1 = parseChatCommand('/schedule tomorrow at 9am : Hello there', WED, {
    defaultChatNumber: '447911123456',
  });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.to, '447911123456');
  assert.strictEqual(r1.toDisplay, '447911123456');
  assert.strictEqual(r1.text, 'Hello there');
  const expected = new Date(2026, 6, 23, 9, 0, 0, 0).getTime();
  assert.strictEqual(r1.when, expected);

  // explicit "to <number>" overrides default; /s trigger; +/spaces in number
  const r2 = parseChatCommand('/s in 2h to +44 7911 123456 : Ping', WED, {
    defaultChatNumber: '999999999',
  });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.to, '447911123456');
  assert.strictEqual(r2.text, 'Ping');
  assert.strictEqual(r2.when, WED.getTime() + 2 * 3600000);

  // /sched trigger, now passed as epoch ms (as index.js does)
  const r3 = parseChatCommand('/sched friday : Standup', WED.getTime(), {
    defaultChatNumber: '447911123456',
  });
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(new Date(r3.when).getDate(), 24);
});

test('parseChatCommand error paths', () => {
  // no trigger
  assert.strictEqual(parseChatCommand('hello world', WED, {}).ok, false);

  // no colon
  assert.strictEqual(
    parseChatCommand('/schedule tomorrow Hello', WED, {
      defaultChatNumber: '447911123456',
    }).ok,
    false
  );

  // empty message
  assert.strictEqual(
    parseChatCommand('/schedule in 2h :   ', WED, {
      defaultChatNumber: '447911123456',
    }).ok,
    false
  );

  // no recipient and no default
  const noTo = parseChatCommand('/schedule in 2h : hi', WED, {});
  assert.strictEqual(noTo.ok, false);

  // unparseable time
  const badTime = parseChatCommand('/schedule someday : hi', WED, {
    defaultChatNumber: '447911123456',
  });
  assert.strictEqual(badTime.ok, false);

  // past time
  const past = parseChatCommand(
    '/schedule 2020-01-01T09:00 to 447911123456 : hi',
    WED
  );
  assert.strictEqual(past.ok, false);

  // missing schedule time (only "to <number>")
  const noWhen = parseChatCommand('/schedule to 447911123456 : hi', WED, {});
  assert.strictEqual(noWhen.ok, false);

  // invalid recipient number
  const badNum = parseChatCommand('/schedule in 2h to 12 : hi', WED, {});
  assert.strictEqual(badNum.ok, false);
});

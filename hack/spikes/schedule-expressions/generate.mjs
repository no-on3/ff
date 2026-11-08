// Expressions made at random for run.sh's comparison of the two readers: each line a time in Unix milliseconds, a
// count and an expression, separated by tabs. Their parts are drawn from what EventBridge takes and from what it
// refuses, near misses most of all: a value one past its field's end, a step of 0, a name misspelt, a field too many.
//   node generate.mjs <lines> <seed>
const [lines = 20000, seed = 1] = process.argv.slice(2).map(Number);

// mulberry32: the same expressions from the same seed.
let state = seed >>> 0;
function random() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(random() * list.length)];
const chance = (p) => random() < p;

// Each part's valid values, then its invalid ones, which one part in 25 is drawn from.
const fields = {
  minutes: [['*', '0', '5', '15', '59', '0/15', '5/20', '*/7', '10-20', '50-10', '0,30', '1,2,3', '00', '007', '*/1', '58-2/3', '30/100'], ['60', '7/0', 'x', '', '-5', '5-', '1-2-3', '0/15/2', '?', '99999999999999999999999']],
  hours: [['*', '0', '8', '23', '8-17', '20-2', '*/12', '8-16/4', '0,12', '1/5', '2-2', '23-0'], ['24', '?', '99999999999999999999']],
  dayOfMonth: [['*', '1', '15', '31', '29', '30', 'L', 'LW', '15W', '1W', '31W', '2W', 'L,15', '1,15', '1-7', '25-5', '*/10', 'LW,1', '1W,L', 'l', 'lw', '31w', '1-31/7'], ['0', '32', 'W', '15W/2', 'ABC', '5#2', 'L-3']],
  month: [['*', '1', '2', '12', 'JAN', 'feb', 'FEB-APR', 'NOV-FEB', '1-12/3', 'JAN,JUL', 'dec-jan', '*/2'], ['13', '0', 'JANUARY', '?']],
  dayOfWeek: [['*', '1', '7', 'MON-FRI', 'FRI-MON', 'SUN', 'sat', 'L', '6L', 'FRIL', '2#1', '5#5', 'mon#2', '1-7/2', 'MON,WED,FRI', 'SUN-SAT', 'THU-TUE/2', '7L', 'SUNL'], ['2#6', '2#0', '8', '0', 'LL', '#1', '1#', '2#1#3']],
  year: [['*', '*', '*', '*', '*', '2026', '2027', '2025', '2026-2030', '2199', '1970', '2030/2', '*/50', '2100-2026', '2026,2199'], ['2200', '1969', '?', 'abc']],
};
const part = ([valid, invalid]) => (chance(0.04) ? pick(invalid) : pick(valid));
const rateValues = [['1', '2', '5', '01', '05', '12', '36500', '100000000', '9007199254740991'], ['0', '9007199254740992', '1.5', '-1', '99999999999999999999', '', 'x']];
const rateUnits = [['minute', 'minutes', 'hour', 'hours', 'day', 'days'], ['second', 'seconds', 'constructor', 'constructors', 'Minutes', 'minutess', 'toString', '']];
const spaces = [' ', ' ', ' ', '  ', '\t', ' '];

function cron() {
  const parts = [fields.minutes, fields.hours, fields.dayOfMonth, fields.month, fields.dayOfWeek, fields.year].map(part);
  // One day "?", as EventBridge wants; one in twenty with both days or neither.
  if (!chance(0.05)) parts[chance(0.5) ? 2 : 4] = '?';
  else if (chance(0.5)) parts[2] = parts[4] = '?';
  if (chance(0.02)) parts.pop();
  if (chance(0.02)) parts.unshift('0');
  return `cron(${parts.join(pick(spaces))})`;
}

// The unit plural above 1, as EventBridge wants, but one in ten.
function rate() {
  const value = part(rateValues);
  let unit = part(rateUnits);
  if (!chance(0.1) && /^(minute|hour|day)s?$/.test(unit)) unit = unit.replace(/s$/, '') + (/^0*1$/.test(value) ? '' : 's');
  return `rate(${chance(0.05) ? ' ' : ''}${value}${pick(spaces)}${unit}${chance(0.05) ? ' ' : ''})`;
}

function expression() {
  const text = chance(0.3) ? rate() : cron();
  const roll = random();
  if (roll < 0.02) return ` ${text} `;
  if (roll < 0.03) return text.toUpperCase();
  if (roll < 0.04) return text.slice(0, -1);
  if (roll < 0.05) return `at(${text})`;
  return text;
}

// From 2026 to 2200, a time to the millisecond; one in ten in 2199's last days, where the runs end.
const START = Date.UTC(2026, 0, 1);
const END = Date.UTC(2200, 0, 1);
const LAST_DAYS = Date.UTC(2199, 11, 25);
const out = [];
for (let i = 0; i < lines; i++) {
  const after = chance(0.1) ? LAST_DAYS + Math.floor(random() * (END - LAST_DAYS)) : START + Math.floor(random() * (END - START));
  out.push(`${after}\t${1 + Math.floor(random() * 5)}\t${expression()}`);
}
process.stdout.write(out.join('\n') + '\n');

// Run with:  node tests/engine.test.js
// Checks that the chat engine's numbers match figures computed independently from the raw rows.
const assert = require('node:assert/strict');
const { createEngine } = require('../pmm-chat.js');
const { generate } = require('../demo/sample-data.js');

const rows = generate(2400, 7);
const sum = (rs, k = 'Outstanding Balance') => rs.reduce((s, r) => s + r[k], 0);
const fmt = n => Math.round(n).toLocaleString('en-US');
const pct = x => (x * 100).toFixed(1) + '%';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message.split('\n').join('\n       ')); }
}
const engine = () => createEngine({ data: rows, aliases: { SAIB: 'Saudi Investment Bank' } });

const anb = rows.filter(r => r.Partner === 'Arab National Bank');
const npl = rows.filter(r => r.DPD > 90);

test('exposure with ANB (acronym resolves to Arab National Bank)', () => {
  const a = engine().ask("What's our exposure with ANB?");
  assert.match(a.text, /Arab National Bank/);
  assert.ok(a.text.includes('SAR ' + fmt(sum(anb))), a.text);
  assert.ok(a.text.includes(fmt(anb.length) + ' loans'), a.text);
});

test('how much is over 90 DPD (whole portfolio, strictly > 90)', () => {
  const a = engine().ask('How much is over 90 DPD?');
  assert.ok(a.text.includes('SAR ' + fmt(sum(npl))), a.text);
  assert.match(a.text, /DPD > 90/);
});

test('follow-up "and how much is over 90 DPD?" keeps the ANB filter', () => {
  const e = engine();
  e.ask("What's our exposure with ANB?");
  const a = e.ask('And how much is over 90 DPD?');
  const exp = anb.filter(r => r.DPD > 90);
  assert.ok(a.text.includes('SAR ' + fmt(sum(exp))), a.text);
  assert.ok(a.text.includes(pct(sum(exp) / sum(anb))), a.text);
});

test('"what about SNB?" swaps the partner, keeps the DPD condition', () => {
  const e = engine();
  e.ask('exposure with ANB over 90 dpd');
  const a = e.ask('what about SNB?');
  const exp = rows.filter(r => r.Partner === 'Saudi National Bank' && r.DPD > 90);
  assert.ok(a.text.includes('SAR ' + fmt(sum(exp))), a.text);
});

test('a standalone question does not inherit earlier filters', () => {
  const e = engine();
  e.ask('exposure with ANB');
  const a = e.ask('how much is over 90 dpd?');
  assert.ok(a.text.includes('SAR ' + fmt(sum(npl))), a.text);
});

test('DPD ranges, "90+" and "at least"', () => {
  const e = engine();
  const r1 = rows.filter(r => r.DPD >= 31 && r.DPD <= 60);
  assert.ok(e.ask('exposure 31-60 dpd').text.includes('SAR ' + fmt(sum(r1))));
  assert.ok(e.ask('how much is 90+ dpd').text.includes('SAR ' + fmt(sum(npl))));
  const r3 = rows.filter(r => r.DPD >= 30);
  assert.ok(e.ask('exposure at least 30 days past due').text.includes('SAR ' + fmt(sum(r3))));
});

test('NPL ratio', () => {
  const a = engine().ask("what's the NPL ratio");
  assert.ok(a.text.includes(pct(sum(npl) / sum(rows))), a.text);
});

test('NPL ratio by partner ranks partners by ratio', () => {
  const a = engine().ask('which partner has the highest NPL ratio?');
  const by = {};
  for (const r of rows) { by[r.Partner] = by[r.Partner] || [0, 0]; by[r.Partner][1] += r['Outstanding Balance']; if (r.DPD > 90) by[r.Partner][0] += r['Outstanding Balance']; }
  const top = Object.entries(by).sort((a, b) => b[1][0] / b[1][1] - a[1][0] / a[1][1])[0];
  assert.ok(a.text.startsWith(top[0]), a.text);
});

test('count and distinct count', () => {
  const e = engine();
  assert.ok(e.ask('how many loans are past due').text.includes(fmt(rows.filter(r => r.DPD > 0).length) + ' loans'));
  const rajhi = rows.filter(r => r.Partner === 'Al Rajhi Bank');
  const n = new Set(rajhi.map(r => r['Borrower Name'].toLowerCase())).size;
  assert.ok(e.ask('how many borrowers with Al Rajhi?').text.startsWith(fmt(n) + ' distinct'));
});

test('short names and aliases', () => {
  const e = engine();
  assert.match(e.ask('exposure to rajhi').text, /Al Rajhi Bank/);
  assert.match(e.ask('approved limit for SAIB').text, /Saudi Investment Bank/);
  assert.ok(e.ask('approved limit for SAIB').text.includes(fmt(sum(rows.filter(r => r.Partner === 'Saudi Investment Bank'), 'Approved Limit'))));
});

test('unknown names are refused, not answered with a total', () => {
  const a = engine().ask('exposure with XYZ bank');
  assert.match(a.text, /couldn't find “XYZ”/);
  assert.doesNotMatch(a.text, /SAR \d/);
});

test('off-topic questions are not answered with numbers', () => {
  const a = engine().ask('what is the weather tomorrow');
  assert.doesNotMatch(a.text, /SAR \d/);
});

test('group by sector with top N', () => {
  const a = engine().ask('top 3 sectors by exposure');
  const by = {};
  for (const r of rows) by[r.Sector] = (by[r.Sector] || 0) + r['Outstanding Balance'];
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
  const lines = a.text.split('\n').slice(2, 5).map(l => l.split('\t')[0]);
  assert.deepEqual(lines, top);
});

test('DPD buckets sum to the total', () => {
  const a = engine().ask('DPD aging buckets');
  assert.match(a.text, /Current \(0\)[\s\S]*1–30[\s\S]*31–60[\s\S]*61–90[\s\S]*90\+/);
  assert.ok(a.text.includes('SAR ' + fmt(sum(rows))));
});

test('list largest NPL loans sorted by amount', () => {
  const a = engine().ask('list the 5 largest loans over 90 DPD');
  const top = npl.slice().sort((a, b) => b['Outstanding Balance'] - a['Outstanding Balance'])[0];
  assert.ok(a.text.split('\n')[2].startsWith(top['Loan ID']), a.text);
});

test('HTML in data is escaped', () => {
  const evil = rows.slice(0, 5).map((r, i) => Object.assign({}, r, { Partner: i ? r.Partner : '<img src=x onerror=alert(1)> Bank' }));
  const e = createEngine({ data: evil });
  const a = e.ask('exposure by partner');
  assert.doesNotMatch(a.html, /<img/);
});

test('string amounts like "1,234,567.50" and "(1,000)" are parsed', () => {
  const data = [
    { Partner: 'Arab National Bank', Outstanding: '1,234,567.50', DPD: '0' },
    { Partner: 'Arab National Bank', Outstanding: '(1,000)', DPD: '120' },
  ];
  const a = createEngine({ data }).ask('exposure with ANB');
  assert.ok(a.text.includes('SAR 1,233,568'), a.text);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

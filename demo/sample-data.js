/*
 * SYNTHETIC sample portfolio for the PMM Chat demo and tests.
 * All borrowers, amounts and DPD values are randomly generated — not real data.
 */
(function (root) {
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function generate(n, seed) {
    const rnd = mulberry32(seed || 42);
    const pick = arr => arr[Math.floor(rnd() * arr.length)];
    const weighted = pairs => {
      const tot = pairs.reduce((s, p) => s + p[1], 0);
      let x = rnd() * tot;
      for (const [v, w] of pairs) { if ((x -= w) < 0) return v; }
      return pairs[pairs.length - 1][0];
    };

    const partners = {
      'Co-Financing': [['Arab National Bank', 18], ['Saudi National Bank', 22], ['Al Rajhi Bank', 20], ['Riyad Bank', 14], ['Banque Saudi Fransi', 10], ['Alinma Bank', 9], ['Saudi Investment Bank', 7]],
      'Agency': [['Arab National Bank', 30], ['Saudi National Bank', 40], ['Riyad Bank', 30]],
      'NBFIs': [['Nama Finance Co.', 35], ['Tasheel Finance Co.', 40], ['Waha Leasing Co.', 25]],
    };
    const sectors = [['Wholesale & Retail Trade', 24], ['Construction', 18], ['Manufacturing', 15], ['Hospitality & Food', 10], ['Transport & Logistics', 9], ['Healthcare', 7], ['Information Technology', 6], ['Education', 5], ['Agriculture', 6]];
    const regions = [['Riyadh', 34], ['Makkah', 22], ['Eastern Province', 20], ['Madinah', 7], ['Qassim', 6], ['Asir', 6], ['Tabuk', 5]];
    const first = ['Al Noor', 'Al Fajr', 'Sahara', 'Najd', 'Al Waha', 'Rawabi', 'Al Masar', 'Danat', 'Al Yamama', 'Tamkeen', 'Al Bayan', 'Jood', 'Al Dana', 'Manar', 'Al Safwa', 'Rimal', 'Al Ufuq', 'Badr', 'Al Khair', 'Sanad'];
    const kind = ['Trading', 'Contracting', 'Industries', 'Logistics', 'Foods', 'Medical', 'Tech', 'Services', 'Holding', 'Supplies'];
    const form = ['Est.', 'Co.', 'LLC'];

    const rows = [];
    for (let i = 0; i < n; i++) {
      const program = weighted([['Co-Financing', 60], ['Agency', 25], ['NBFIs', 15]]);
      const partner = weighted(partners[program]);
      const limit = Math.round((program === 'NBFIs' ? 150000 + rnd() * 1.2e6 : 300000 + Math.pow(rnd(), 2.2) * 9.5e6) / 1000) * 1000;
      const utilised = limit * (0.35 + rnd() * 0.65);
      const riskBoost = (program === 'NBFIs' ? 1.8 : 1) * (partner === 'Alinma Bank' ? 1.4 : 1);
      const r = rnd() / riskBoost;
      let dpd;
      if (r < 0.055) dpd = 91 + Math.floor(rnd() * 400);
      else if (r < 0.085) dpd = 61 + Math.floor(rnd() * 30);
      else if (r < 0.12) dpd = 31 + Math.floor(rnd() * 30);
      else if (r < 0.2) dpd = 1 + Math.floor(rnd() * 30);
      else dpd = 0;
      rows.push({
        'Loan ID': 'LN-' + String(100000 + i),
        'Borrower Name': `${pick(first)} ${pick(kind)} ${pick(form)}`,
        'Program': program,
        'Partner': partner,
        'Sector': weighted(sectors),
        'Region': weighted(regions),
        'Approved Limit': limit,
        'Outstanding Balance': Math.round(utilised),
        'DPD': dpd,
        'IFRS9 Stage': dpd > 90 ? 'Stage 3' : dpd > 30 ? 'Stage 2' : 'Stage 1',
        'Interest Rate %': +(5 + rnd() * 4).toFixed(2),
      });
    }
    return rows;
  }

  const api = { generate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMMSample = api;
})(typeof self !== 'undefined' ? self : this);

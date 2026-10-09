/*!
 * PMM Chat — offline Q&A assistant for the Portfolio Monitoring & Management dashboard.
 *
 * Runs entirely inside the browser page: no network requests, no external libraries,
 * no AI service. Questions are translated into filters / aggregations over the same
 * records the dashboard already holds, so every number is computed, never guessed.
 *
 * Usage (browser):   PMMChat.init({ data: () => myRows, fields: {...}, aliases: {...} })
 * Usage (Node/test): const { createEngine } = require('./pmm-chat.js')
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMMChat = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ vocabulary

  const STOP = new Set((
    'a an the of to for with in on at from by and or is are was were be been being what whats how much many ' +
    'our we us my me i you your show tell give list all please it its this that those these them which who whom ' +
    'do does did has have had can could would should will there their than then as per each every about any some ' +
    'across between into within under over above below more less currently now today get got find see let know ' +
    'need want just only also so if not no yes still left exactly roughly approximately approx around'
  ).split(' '));

  // Words that describe the question rather than name an entity.
  const VOCAB = new Set((
    'exposure exposures outstanding balance balances total totals amount amounts sum value book portfolio ' +
    'loan loans facility facilities account accounts deal deals contract contracts record records ' +
    'dpd day days past due overdue arrears delinquent delinquency npl npls nonperforming performing non ' +
    'default defaulted impaired bucket buckets aging ageing breakdown split distribution concentration ' +
    'summary overview snapshot number count average avg mean max maximum min minimum highest lowest largest ' +
    'biggest smallest top bottom most least worst oldest ratio share percent percentage proportion portion rate ' +
    'status sar riyal riyals million millions billion thousand bn level levels detail details group grouped ' +
    'hi hello hey help thanks thank'
  ).split(' '));

  const KNOWN_ACRONYMS = new Set(
    'DPD NPL NPLS SAR SR SME SMES ECL EAD PD LGD KSA YTD MTD QTD IFRS OS KPI KPIS USD ID NBFI NBFIS PMM'.split(' '));

  const LOAN_WORDS = new Set('loan loans facility facilities account accounts deal deals contract contracts record records'.split(' '));

  const GENERIC_LABEL_WORDS = new Set('amount total value sar usd net gross sum no number name the of in'.split(' '));
  const GENERIC_VALUE_SUFFIX = new Set('bank company co ltd limited est establishment llc group corp corporation inc plc finance financing'.split(' '));
  const UNMATCHABLE_VALUES = new Set('other others all total unknown na n a none null blank misc miscellaneous yes no'.split(' '));

  const MEASURE_SYNONYMS = [
    [/limit|approved|sanction/, ['limit', 'limits', 'approved', 'approved amount', 'sanctioned']],
    [/provision|ecl|impair|allowance/, ['provision', 'provisions', 'ecl', 'impairment', 'allowance']],
    [/disburs|funded/, ['disbursed', 'disbursement', 'disbursements', 'funded']],
    [/overdue|arrear|past ?due ?amount/, ['overdue amount', 'amount overdue', 'arrears', 'past due amount']],
    [/collateral|guarantee|security/, ['collateral', 'guarantee', 'guaranteed', 'security']],
    [/outstanding|exposure|balance|principal|\bead\b|utili[sz]/, ['exposure', 'outstanding', 'balance', 'principal', 'os', 'book', 'utilised', 'utilized']],
  ];

  const DIM_SYNONYMS = [
    [/partner|bank|lender|counterpart|financier|institution/, ['partner', 'partners', 'bank', 'banks', 'counterparty', 'counterparties', 'lender', 'lenders', 'institution', 'institutions']],
    [/borrower|customer|client|obligor|beneficiary|company|name/, ['borrower', 'borrowers', 'customer', 'customers', 'client', 'clients', 'obligor', 'obligors', 'company', 'companies', 'beneficiary', 'beneficiaries', 'name', 'names']],
    [/sector|industry|activity/, ['sector', 'sectors', 'industry', 'industries', 'activity', 'activities']],
    [/region|province|city|area|location/, ['region', 'regions', 'city', 'cities', 'area', 'areas', 'province', 'provinces', 'location', 'locations']],
    [/program|programme|product|scheme/, ['program', 'programs', 'programme', 'programmes', 'product', 'products', 'scheme', 'schemes']],
    [/branch/, ['branch', 'branches']],
    [/stage/, ['stage', 'stages']],
    [/rating|grade|score/, ['rating', 'ratings', 'grade', 'grades']],
    [/segment|size/, ['segment', 'segments', 'size']],
    [/status/, ['status', 'statuses']],
  ];

  const BUCKET_WORDS = new Set('dpd bucket buckets aging ageing delinquency arrears'.split(' '));

  // Numeric columns that should be averaged rather than summed.
  const AVG_TYPE = /rate|%|pct|percent|yield|margin|spread|tenor|term|months|years|score|\bpd\b|lgd|\bage\b|ratio|ltv|dscr/;

  // ------------------------------------------------------------------ utils

  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[’‘`]/g, "'")
      .replace(/[–—]/g, '-')
      .replace(/(\d),(?=\d{3}\b)/g, '$1')
      .replace(/'s\b/g, '')
      .replace(/(\d)\s*-\s*(\d)/g, '$1 to $2')
      .replace(/(\d)\s*\+/g, '$1 + ')
      .replace(/(\d)\.(\d)/g, '$1\u0001$2')          // protect decimals
      .replace(/[^a-z0-9؀-ۿ%+<>=\u0001 ]+/g, ' ')
      .replace(/\u0001/g, '.')
      .replace(/([<>]=?)/g, ' $1 ').replace(/ ([<>]) = /g, ' $1= ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v == null) return NaN;
    let s = String(v).trim();
    if (!s) return NaN;
    const neg = /^\(.*\)$/.test(s);
    s = s.replace(/[(),\s]|SAR|SR|USD|\$/gi, '').replace(/%$/, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
    const n = parseFloat(s);
    return neg ? -n : n;
  }

  function plural(w) {
    if (/(s|x|sh|ch)$/.test(w)) return w + 'es';
    if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
    return w + 's';
  }

  function lev(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function fmtInt(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  function fmtCompact(n) {
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }

  function fmtPct(x) {
    if (!isFinite(x)) return '–';
    const p = x * 100;
    return (Math.abs(p) < 0.1 && p !== 0 ? p.toFixed(2) : p.toFixed(1)) + '%';
  }

  function fmtNum(n, digits) {
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits == null ? 2 : digits });
  }

  // ------------------------------------------------------------------ schema

  function detectColumns(rows) {
    const cols = [];
    const seen = new Set();
    for (let i = 0; i < Math.min(rows.length, 50); i++) {
      for (const k of Object.keys(rows[i] || {})) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
    return cols.map(key => {
      let numeric = 0, filled = 0;
      const distinct = new Set();
      const sample = rows.length > 5000 ? rows.filter((_, i) => i % Math.ceil(rows.length / 5000) === 0) : rows;
      for (const r of sample) {
        const v = r[key];
        if (v === null || v === undefined || v === '') continue;
        filled++;
        if (!isNaN(toNum(v))) numeric++;
        if (distinct.size <= 20000) distinct.add(norm(v));
      }
      return { key, n: norm(key), isNumeric: filled > 0 && numeric / filled >= 0.9, distinct: distinct.size, filled };
    });
  }

  function synonymsFor(table, label) {
    for (const [re, words] of table) if (re.test(label)) return words;
    return [];
  }

  function labelWords(label) {
    return label.split(' ').filter(w => w && !GENERIC_LABEL_WORDS.has(w) && !STOP.has(w) && !/^[%+<>=]+$/.test(w));
  }

  function buildSchema(rows, cfg) {
    const f = cfg.fields || {};
    const cols = detectColumns(rows);
    const byKey = new Map(cols.map(c => [c.key, c]));
    const pick = (key) => (key && byKey.has(key) ? key : null);

    // DPD
    let dpdKey = pick(f.dpd);
    if (!dpdKey) {
      const c = cols.find(c => c.isNumeric && /\bdpd\b|days ?past ?due|days ?overdue|overdue ?days|days ?in ?arrears|delinquen.*days/.test(c.n));
      dpdKey = c ? c.key : null;
    }

    // Measures
    const measureKeys = Array.isArray(f.measures) && f.measures.length
      ? f.measures.filter(k => byKey.has(k))
      : cols.filter(c => c.isNumeric && c.key !== dpdKey && !/\bid\b|^id|_id$|code|year|month|\bno\b|number|zip|phone/.test(c.n)).map(c => c.key);
    let amountKey = pick(f.amount);
    if (!amountKey) {
      const order = [/outstanding|exposure|\bead\b/, /balance|principal/, /amount|utili/];
      for (const re of order) {
        const k = measureKeys.find(k => re.test(norm(k)) && !AVG_TYPE.test(norm(k)));
        if (k) { amountKey = k; break; }
      }
      if (!amountKey) amountKey = measureKeys.find(k => !AVG_TYPE.test(norm(k))) || null;
    }
    if (amountKey && !measureKeys.includes(amountKey)) measureKeys.unshift(amountKey);
    const measures = measureKeys.map(key => {
      const n = norm(key);
      const label = (cfg.labels && cfg.labels[key]) || key;
      const words = new Set([n, ...labelWords(n), ...synonymsFor(MEASURE_SYNONYMS, n)]);
      if (key !== amountKey) words.delete('exposure');
      return { key, label, n, words: [...words], avgType: AVG_TYPE.test(n), primary: key === amountKey };
    });

    // Dimensions
    let dimKeys;
    if (f.dimensions) {
      dimKeys = (Array.isArray(f.dimensions) ? f.dimensions : Object.keys(f.dimensions)).filter(k => byKey.has(k));
    } else {
      dimKeys = cols.filter(c => !c.isNumeric && c.key !== dpdKey && c.distinct > 0 && c.distinct <= (cfg.maxDistinct || 20000) &&
        !/date|\bid\b|^id|_id$|\bcode\b|\bref\b|\bkey\b|phone|mobile|email|address|\bcr\b|\biban\b|account no|number|comment|remark|note/.test(c.n))
        .map(c => c.key);
      if (f.name && byKey.has(f.name) && !dimKeys.includes(f.name)) dimKeys.push(f.name);
    }
    const usedSyn = new Set();
    const dims = dimKeys.map(key => {
      const n = norm(key);
      const label = (f.dimensions && !Array.isArray(f.dimensions) && f.dimensions[key]) || (cfg.labels && cfg.labels[key]) || key;
      let syn = synonymsFor(DIM_SYNONYMS, n);
      // Only the first column claims a synonym group (e.g. "Partner" vs "Partner Type").
      if (syn.length && usedSyn.has(syn[0])) syn = [];
      else if (syn.length) usedSyn.add(syn[0]);
      const base = labelWords(n);
      const words = new Set([n, ...base, ...base.map(plural), ...syn]);
      return { key, label, n, words: [...words], values: new Map() };
    });
    for (const r of rows) {
      for (const d of dims) {
        const v = r[d.key];
        if (v === null || v === undefined || v === '') continue;
        const nv = norm(v);
        if (!nv) continue;
        if (!d.values.has(nv)) d.values.set(nv, { raw: String(v).trim(), count: 0 });
        d.values.get(nv).count++;
      }
    }

    const idKey = pick(f.id) || (cols.find(c => /\bid\b|^id|_id$|loan ?(no|number|ref)|account ?(no|number)|contract/.test(c.n)) || {}).key || null;
    const nameKey = pick(f.name) || (dims.find(d => /borrower|customer|client|obligor|beneficiary|company/.test(d.n)) || {}).key || null;

    const schema = { rows, cols, dpdKey, amountKey, measures, dims, idKey, nameKey };
    schema.index = buildEntityIndex(schema, cfg);
    schema.vocab = new Set([...VOCAB, ...measures.flatMap(m => m.n.split(' ').concat(m.words)), ...dims.flatMap(d => d.n.split(' ').concat(d.words))]);
    return schema;
  }

  function acronymOf(tokens) {
    const t = tokens.filter(w => !['of', 'the', 'and', 'for', '&'].includes(w));
    if (t.length < 2 || t.some(w => /^\d/.test(w))) return null;
    return t.map(w => w[0]).join('');
  }

  function buildEntityIndex(schema, cfg) {
    const cands = [];
    const add = (phrase, dim, value, kind) => {
      const tokens = phrase.split(' ').filter(Boolean);
      if (!tokens.length) return;
      cands.push({ phrase: tokens.join(' '), tokens, dim, value, kind });
    };
    for (const d of schema.dims) {
      for (const [nv] of d.values) {
        const tokens = nv.split(' ');
        if (UNMATCHABLE_VALUES.has(nv)) continue;
        if (/^[\d.]+$/.test(nv)) {                    // numeric code, e.g. stage "3" -> "stage 3"
          for (const w of d.words.filter(w => !w.includes(' ') && !w.endsWith('s'))) add(w + ' ' + nv, d.key, nv, 'exact');
          continue;
        }
        if (tokens.length === 1 && (nv.length < 2 || STOP.has(nv))) continue;
        add(nv, d.key, nv, 'exact');
        // Short form: "Al Rajhi Bank" -> "al rajhi", "rajhi"
        let short = tokens.slice();
        while (short.length > 1 && GENERIC_VALUE_SUFFIX.has(short[short.length - 1])) short.pop();
        if (short.length < tokens.length) add(short.join(' '), d.key, nv, 'short');
        if (short.length > 1 && ['al', 'the', 'el'].includes(short[0])) add(short.slice(1).join(' '), d.key, nv, 'short');
        const acr = acronymOf(tokens);
        if (acr && acr.length >= 2) add(acr, d.key, nv, 'acronym');
      }
    }
    // Drop ambiguous short forms / acronyms and those colliding with ordinary words.
    const exact = new Set(cands.filter(c => c.kind === 'exact').map(c => c.phrase));
    const counts = new Map();
    for (const c of cands) counts.set(c.phrase, (counts.get(c.phrase) || 0) + 1);
    const kept = cands.filter(c => {
      if (c.kind === 'exact') return true;
      if (exact.has(c.phrase) || counts.get(c.phrase) > 1) return false;
      if (c.tokens.length === 1 && (c.phrase.length < 3 && c.kind !== 'acronym' || STOP.has(c.phrase) || VOCAB.has(c.phrase))) return false;
      if (c.kind === 'acronym' && (STOP.has(c.phrase) || VOCAB.has(c.phrase))) return false;
      if (c.tokens.length === 1 && c.kind === 'short' && c.phrase.length < 4) return false;
      return true;
    });
    // User-supplied aliases win.
    for (const [alias, target] of Object.entries(cfg.aliases || {})) {
      const nt = norm(target);
      const d = schema.dims.find(d => d.values.has(nt));
      if (d) kept.push({ phrase: norm(alias), tokens: norm(alias).split(' '), dim: d.key, value: nt, kind: 'alias' });
    }
    const byFirst = new Map();
    for (const c of kept) {
      if (!byFirst.has(c.tokens[0])) byFirst.set(c.tokens[0], []);
      byFirst.get(c.tokens[0]).push(c);
    }
    const rank = { alias: 0, exact: 1, short: 2, acronym: 3 };
    for (const list of byFirst.values()) list.sort((a, b) => b.tokens.length - a.tokens.length || rank[a.kind] - rank[b.kind]);
    return { all: kept, byFirst };
  }

  // ------------------------------------------------------------------ parsing

  function matchEntities(tokens, index) {
    const used = new Array(tokens.length).fill(false);
    const hits = [];
    for (let i = 0; i < tokens.length; i++) {
      const list = index.byFirst.get(tokens[i]);
      if (!list) continue;
      for (const c of list) {
        const L = c.tokens.length;
        if (i + L > tokens.length) continue;
        let ok = true;
        for (let k = 0; k < L; k++) if (tokens[i + k] !== c.tokens[k] || used[i + k]) { ok = false; break; }
        if (!ok) continue;
        for (let k = 0; k < L; k++) used[i + k] = true;
        hits.push(Object.assign({ start: i, end: i + L }, c));
        i += L - 1;
        break;
      }
    }
    return { hits, used };
  }

  function parseDpd(q, cfg) {
    const npl = cfg.nplDpd;
    const D = '(?:dpd|days? past due|days? overdue|days? in arrears|days? late|days?)';
    const context = /\bdpd\b|\bdays?\b|past due|overdue|arrears|delinq|aging|ageing|bucket|\d \+/.test(q);
    if (context) {
      let m;
      if ((m = q.match(new RegExp('\\b(?:between|from)\\s+(\\d+)\\s+(?:and|to)\\s+(\\d+)\\b'))) ||
          (m = q.match(new RegExp('\\b(\\d+)\\s+to\\s+(\\d+)\\s*' + D)))) {
        const a = +m[1], b = +m[2];
        return { op: 'between', a: Math.min(a, b), b: Math.max(a, b), label: `DPD ${Math.min(a, b)}–${Math.max(a, b)}` };
      }
      if ((m = q.match(/\bdpd\s*(>=|<=|>|<|=)\s*(\d+)/))) return mk(m[1], +m[2]);
      if ((m = q.match(new RegExp('(?:>=|at least|minimum of|no less than)\\s*(\\d+)\\b')))) return mk('>=', +m[1]);
      if ((m = q.match(new RegExp('(?:<=|at most|up to|within|no more than|maximum of)\\s*(\\d+)\\b')))) return mk('<=', +m[1]);
      if ((m = q.match(new RegExp('(?:>|over|above|more than|greater than|exceeding|beyond|past|plus)\\s*(\\d+)\\b')))) return mk('>', +m[1]);
      if ((m = q.match(new RegExp('(?:<|under|below|less than|fewer than)\\s*(\\d+)\\b')))) return mk('<', +m[1]);
      if ((m = q.match(/\b(\d+)\s*\+/))) return mk('>', +m[1]);
      if ((m = q.match(new RegExp('\\b(\\d+)\\s*' + D + '\\b')))) return mk('>', +m[1]);
    }
    if (/\bnon ?performing|\bnpls?\b|\bdefault(ed)?\b|\bimpaired\b|\bbad (loans|debts?)\b/.test(q)) return { op: '>', a: npl, label: `NPL (DPD > ${npl})`, npl: true };
    if (/\bperforming\b/.test(q)) return { op: '<=', a: npl, label: `Performing (DPD ≤ ${npl})` };
    if (/\bnot (past due|overdue|delinquent|in arrears)\b|\b(zero|0|no) dpd\b|\bcurrent bucket\b|\bup to date\b/.test(q)) return { op: '=', a: 0, label: 'Not past due (DPD = 0)' };
    if (/\bpast due\b|\boverdue\b|\bdelinquen|\barrears\b|\blate\b/.test(q) && !/\b(bucket|buckets|aging|ageing)\b/.test(q)) return { op: '>', a: 0, label: 'Past due (DPD > 0)' };
    return null;

    function mk(op, a) {
      const sym = { '>=': '≥', '<=': '≤', '>': '>', '<': '<', '=': '=' }[op];
      return { op, a, label: `DPD ${sym} ${a}`, npl: op === '>' && a === npl };
    }
  }

  function dpdTest(d) {
    switch (d.op) {
      case '>': return v => v > d.a;
      case '>=': return v => v >= d.a;
      case '<': return v => v < d.a;
      case '<=': return v => v <= d.a;
      case '=': return v => v === d.a;
      case 'between': return v => v >= d.a && v <= d.b;
    }
    return () => true;
  }

  function findDim(schema, word) {
    if (!word) return null;
    return schema.dims.find(d => d.words.includes(word)) || null;
  }

  function parse(question, schema, cfg) {
    const q = norm(question);
    const tokens = q ? q.split(' ') : [];
    const plan = {
      q, filters: {}, dpd: null, groupBy: null, topN: null, order: 'desc', agg: 'sum', measure: null,
      mode: 'aggregate', ratio: false, distinctDim: null, unmatched: [], explicit: {},
    };

    if (!q || /^(help|hi|hello|hey|salam|salaam|marhaba|what can you do|what can i ask|examples?|how does this work|\?)\b/.test(q)) {
      plan.mode = 'help';
      return plan;
    }

    // Entities
    const { hits, used } = matchEntities(tokens, schema.index);
    for (const h of hits) {
      (plan.filters[h.dim] = plan.filters[h.dim] || new Set()).add(h.value);
    }
    plan.hits = hits;

    // DPD condition
    plan.dpd = parseDpd(q, cfg);

    // Measure
    let best = null, bestScore = 0;
    const qm = ' ' + q.replace(/\b(npl|delinquency|default|past due|arrears|growth) rate\b/g, ' ') + ' ';
    for (const m of schema.measures) {
      for (const w of m.words) {
        if (!w) continue;
        if (qm.includes(' ' + w + ' ')) {
          const s = w.split(' ').length * 10 + w.length;
          if (s > bestScore) { bestScore = s; best = m; }
        }
      }
    }
    if (best) { plan.measure = best.key; plan.explicit.measure = true; }

    // Aggregation
    let m;
    if (/\b(average|avg|mean)\b/.test(q)) {
      plan.agg = 'avg'; plan.explicit.agg = true;
      if (/\b(average|avg|mean) (dpd|days)\b|\bdpd\b/.test(q) && !best) plan.measure = '__dpd';
    } else if (/\b(max|maximum|highest|worst|oldest|longest)\s+(dpd|days past due|delinquency)\b|\bmost (days )?overdue\b/.test(q) && !/\b(which|what|who|list|show)\b/.test(q)) {
      plan.agg = 'max'; plan.measure = '__dpd'; plan.explicit.agg = true;
    } else if ((m = q.match(/\b(how many|number of|count of|count|no of|# of|total number of)\s+(?:the\s+|our\s+|unique\s+|distinct\s+|different\s+)*([a-z]+)?/))) {
      plan.agg = 'count'; plan.explicit.agg = true;
      const d = m[2] && !LOAN_WORDS.has(m[2]) ? findDim(schema, m[2]) : null;
      if (d) { plan.agg = 'distinct'; plan.distinctDim = d.key; }
    } else if (/\bhow much\b|\btotal\b|\bsum\b/.test(q)) {
      plan.explicit.agg = true;
    }

    if (/%|\bpercent|\bpercentage\b|\bshare\b|\bratio\b|\bproportion\b|\bportion\b|\bwhat part\b|\b(npl|delinquency|default|past due|arrears) rate\b/.test(q)) {
      plan.ratio = true; plan.explicit.ratio = true;
    }

    // Group by
    const gbRe = /\b(?:by|per|for each|for every|each|across|breakdown(?: of| by)?|split(?: by)?|grouped by|group by|distribution(?: by| of)?|concentration(?: by| of)?)\s+(?:the\s+|our\s+|their\s+|all\s+)?([a-z]+)/g;
    while ((m = gbRe.exec(q))) {
      const w = m[1];
      if (BUCKET_WORDS.has(w)) { plan.groupBy = '__bucket'; break; }
      const d = findDim(schema, w);
      if (d) { plan.groupBy = d.key; break; }
    }
    if (!plan.groupBy && /\b(aging|ageing)\b|\bdpd (bucket|buckets|breakdown|distribution|profile)\b|\bbuckets\b/.test(q)) plan.groupBy = '__bucket';

    // Top / bottom / which-X-has-the-most
    if ((m = q.match(/\b(top|largest|biggest|highest|bottom|smallest|lowest|least|oldest|worst)\s+(\d+)?\s*([a-z]+)/))) {
      const n = m[2] ? +m[2] : null;
      const noun = m[3];
      const asc = /bottom|smallest|lowest|least/.test(m[1]);
      if (LOAN_WORDS.has(noun)) {
        plan.mode = 'list'; plan.topN = n || 10; plan.order = asc ? 'asc' : 'desc';
      } else {
        const d = findDim(schema, noun);
        if (d) {
          plan.groupBy = d.key;
          plan.topN = n || (/^(top|bottom)$/.test(m[1]) || noun.endsWith('s') ? 5 : 1);
          plan.order = asc ? 'asc' : 'desc';
        }
      }
    }
    if (!plan.topN && (m = q.match(/\b(?:which|what|who)\s+(?:is\s+(?:the\s+|our\s+)?)?([a-z]+)\b/))) {
      const d = findDim(schema, m[1]);
      const sup = q.match(/\b(highest|largest|biggest|most|max|maximum|top|lowest|smallest|least|min|minimum)\b/);
      if (d && sup) {
        plan.groupBy = d.key; plan.topN = d.words.includes(m[1]) && m[1].endsWith('s') ? 5 : 1;
        plan.order = /lowest|smallest|least|min/.test(sup[1]) ? 'asc' : 'desc';
      } else if (d && !plan.groupBy && !(plan.filters[d.key])) {
        plan.groupBy = d.key;                              // "which partners have NPLs?"
      } else if (!d && LOAN_WORDS.has(m[1])) {
        plan.mode = 'list';
      }
    }
    if (plan.groupBy) plan.explicit.groupBy = true;

    // List individual loans
    if (plan.mode !== 'list' && plan.agg !== 'count' && /\b(list|show|display|give me|what are|which are|see|detail|details)\b/.test(q) &&
        tokens.some(t => LOAN_WORDS.has(t)) && !plan.groupBy) {
      plan.mode = 'list';
    }
    if (plan.mode === 'list') {
      plan.explicit.list = true;
      plan.topN = plan.topN || ((m = q.match(/\b(\d+)\s+(?:loans|facilities|accounts|deals|contracts|records)\b/)) ? +m[1] : 10);
      if (/\b(oldest|most overdue|most delinquent|longest|worst|(highest|max|maximum) (dpd|days)|by dpd|sorted by dpd)\b/.test(q)) plan.sortByDpd = true;
    }

    if (/\b(summary|summari[sz]e|overview|snapshot|overall position|key (figures|numbers|metrics)|kpis?|health)\b/.test(q)) {
      plan.mode = 'summary';
    }

    // "ANB vs SNB": several values of one field -> show them side by side.
    if (!plan.groupBy && plan.mode === 'aggregate' && !plan.ratio) {
      const multi = Object.keys(plan.filters).find(k => plan.filters[k].size > 1);
      if (multi) { plan.groupBy = multi; plan.compare = true; }
    }

    plan.recognised = !!(hits.length || plan.dpd || plan.groupBy || plan.mode !== 'aggregate' ||
      Object.keys(plan.explicit).length || tokens.some(t => !STOP.has(t) && schema.vocab.has(t)));

    // Words that look like an entity but matched nothing in the data.
    plan.unmatched = findUnmatched(question, tokens, used, schema);
    return plan;
  }

  function findUnmatched(original, tokens, used, schema) {
    const out = new Set();
    const isKnown = w => STOP.has(w) || schema.vocab.has(w) || /^\d/.test(w) || w.length < 2 || /^[%+<>=]+$/.test(w);
    // 1) Upper-case acronyms such as "XYZ" that we could not resolve.
    const covered = new Set(tokens.filter((_, i) => used[i]));
    for (const raw of String(original).match(/\b[A-Z][A-Z0-9&]{1,6}\b/g) || []) {
      const w = norm(raw);
      if (!KNOWN_ACRONYMS.has(raw.toUpperCase()) && !covered.has(w) && !isKnown(w)) out.add(raw);
    }
    // 2) The word right after "with / to / for / at / in / on / from".
    const ignore = new Set(['the', 'our', 'a', 'an', 'all', 'each', 'every', 'total', 'this', 'that', 'those', 'these']);
    for (let i = 0; i < tokens.length - 1; i++) {
      if (!['with', 'to', 'for', 'at', 'in', 'on', 'from', 'against', 'towards', 'toward'].includes(tokens[i])) continue;
      let j = i + 1;
      while (j < tokens.length && ignore.has(tokens[j])) j++;
      if (j >= tokens.length || used[j]) continue;
      const w = tokens[j];
      if (isKnown(w)) continue;
      // multi-word names: take following unknown words too
      let k = j;
      while (k + 1 < tokens.length && !used[k + 1] && !isKnown(tokens[k + 1])) k++;
      out.add(tokens.slice(j, k + 1).join(' '));
    }
    // De-duplicate case-insensitive
    const seen = new Set();
    return [...out].filter(w => { const n = norm(w); if (seen.has(n)) return false; seen.add(n); return true; });
  }

  function suggestFor(term, schema) {
    const t = norm(term);
    const scored = [];
    const seen = new Set();
    for (const c of schema.index.all) {
      const key = c.dim + '|' + c.value;
      let s;
      if (c.phrase.includes(t) || (t.length >= 3 && t.includes(c.phrase))) s = 0;
      else s = lev(t, c.phrase) / Math.max(t.length, c.phrase.length);
      if (s <= 0.45) scored.push({ s, key, c });
    }
    scored.sort((a, b) => a.s - b.s);
    const out = [];
    for (const x of scored) {
      if (seen.has(x.key)) continue;
      seen.add(x.key);
      const d = schema.dims.find(d => d.key === x.c.dim);
      out.push({ value: d.values.get(x.c.value).raw, dim: d.label });
      if (out.length >= 4) break;
    }
    return out;
  }

  // ------------------------------------------------------------------ engine

  function createEngine(userCfg) {
    const cfg = Object.assign({
      currency: 'SAR',
      nplDpd: 90,
      buckets: [30, 60, 90],
      aliases: {},
      unitNoun: ['loan', 'loans'],
      maxGroupRows: 12,
    }, userCfg || {});

    let schema = null, schemaRows = null, schemaLen = -1, last = null;

    function getRows() {
      const d = typeof cfg.data === 'function' ? cfg.data() : cfg.data;
      return Array.isArray(d) ? d : [];
    }

    function ensureSchema() {
      const rows = getRows();
      if (!schema || rows !== schemaRows || rows.length !== schemaLen) {
        schema = buildSchema(rows, cfg);
        schemaRows = rows; schemaLen = rows.length;
      }
      return schema;
    }

    const measureOf = key => schema.measures.find(m => m.key === key);
    const dimOf = key => schema.dims.find(d => d.key === key);
    const valOf = (row, key) => key === '__dpd' ? dpdOf(row) : toNum(row[key]);
    const dpdOf = row => { const v = toNum(row[schema.dpdKey]); return isNaN(v) ? 0 : v; };

    function filterRows(plan, { useEntities = true, useDpd = true } = {}) {
      const f = useEntities ? Object.entries(plan.filters).map(([k, set]) => [k, set]) : [];
      const t = useDpd && plan.dpd && schema.dpdKey ? dpdTest(plan.dpd) : null;
      return schema.rows.filter(r => {
        for (const [k, set] of f) if (!set.has(norm(r[k]))) return false;
        if (t && !t(dpdOf(r))) return false;
        return true;
      });
    }

    function total(rows, key) {
      let s = 0;
      for (const r of rows) { const v = valOf(r, key); if (!isNaN(v)) s += v; }
      return s;
    }

    function money(n) {
      const m = measureOf(currentMeasure);
      if (currentMeasure === '__dpd' || (m && m.avgType)) return fmtNum(n);
      return `${cfg.currency} ${fmtInt(n)}` + (Math.abs(n) >= 1e4 ? ` <span class="pmmc-dim">(≈${fmtCompact(n)})</span>` : '');
    }
    const moneyShort = n => `${cfg.currency} ${fmtCompact(n)}`;
    let currentMeasure = null;

    function describeFilters(plan, { withDpd = true } = {}) {
      const parts = [];
      for (const [k, set] of Object.entries(plan.filters)) {
        const d = dimOf(k);
        parts.push(`${esc(d.label)} = ${[...set].map(v => esc(d.values.get(v).raw)).join(' or ')}`);
      }
      if (withDpd && plan.dpd) parts.push(esc(plan.dpd.label));
      return parts;
    }

    function subject(plan) {
      const names = [];
      for (const [k, set] of Object.entries(plan.filters)) {
        const d = dimOf(k);
        names.push([...set].map(v => '<b>' + esc(d.values.get(v).raw) + '</b>').join(' + '));
      }
      return names.join(' · ');
    }

    function basis(plan, n, extra) {
      const m = plan.measure === '__dpd' ? 'DPD' : (measureOf(plan.measure) || {}).label;
      const f = describeFilters(plan);
      const bits = [];
      bits.push(f.length ? 'Filters: ' + f.join('; ') : 'Filters: none (whole portfolio)');
      if (m && plan.agg !== 'count' && plan.agg !== 'distinct') bits.push('Measure: ' + esc(m));
      bits.push(`${fmtInt(n)} of ${fmtInt(schema.rows.length)} records`);
      if (extra) bits.push(extra);
      return `<div class="pmmc-basis">${bits.join(' · ')}</div>`;
    }

    function table(headers, rows, alignRight) {
      const th = headers.map((h, i) => `<th${alignRight[i] ? ' class="r"' : ''}>${h}</th>`).join('');
      const tr = rows.map(r => '<tr>' + r.map((c, i) => `<td${alignRight[i] ? ' class="r"' : ''}>${c}</td>`).join('') + '</tr>').join('');
      return `<div class="pmmc-table"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
    }

    function bucketOf(dpd) {
      const b = cfg.buckets;
      if (dpd <= 0) return { i: 0, label: 'Current (0)' };
      let lo = 1;
      for (let i = 0; i < b.length; i++) {
        if (dpd <= b[i]) return { i: i + 1, label: `${lo}–${b[i]}` };
        lo = b[i] + 1;
      }
      return { i: b.length + 1, label: `${b[b.length - 1]}+` };
    }

    function groupRows(rows, key) {
      const g = new Map();
      for (const r of rows) {
        let k, label, order = 0;
        if (key === '__bucket') { const b = bucketOf(dpdOf(r)); k = b.label; label = b.label; order = b.i; }
        else { k = norm(r[key]); label = k ? dimOf(key).values.get(k).raw : '(blank)'; }
        if (!g.has(k)) g.set(k, { k, label, order, rows: [] });
        g.get(k).rows.push(r);
      }
      return [...g.values()];
    }

    // -------------------------------------------------------------- answers

    function answerHelp() {
      const ex = examples();
      return {
        html: `<p>I answer questions about the portfolio data loaded in this dashboard. Everything is computed locally — nothing leaves this computer.</p>
<p>Things you can ask:</p><ul>${ex.map(e => `<li><a href="#" class="pmmc-ex" data-q="${esc(e)}">${esc(e)}</a></li>`).join('')}</ul>
<p class="pmmc-dim">I understand: ${schema.dims.map(d => esc(d.label)).join(', ')}${schema.dpdKey ? ', DPD (' + esc(schema.dpdKey) + ')' : ''}; measures: ${schema.measures.map(m => esc(m.label)).join(', ')}. Start a question with “and…” or “what about…” to build on the previous answer.</p>`,
      };
    }

    function examples() {
      const out = [];
      const partner = schema.dims.find(d => /partner|bank|lender|counterpart/.test(d.n)) || schema.dims[0];
      const short = partner && schema.index.all.find(c => c.dim === partner.key && (c.kind === 'acronym' || c.kind === 'alias'));
      const anyVal = partner && [...partner.values.values()].sort((a, b) => b.count - a.count)[0];
      const name = short ? short.phrase.toUpperCase() : anyVal ? anyVal.raw : null;
      if (name) out.push(`What's our exposure with ${name}?`);
      if (schema.dpdKey) out.push(`How much is over ${cfg.nplDpd} DPD?`);
      if (name && schema.dpdKey) out.push(`And how much of that is over ${cfg.nplDpd} DPD?`);
      const sector = schema.dims.find(d => /sector|industry/.test(d.n));
      if (schema.dpdKey) out.push(`NPL ratio by ${(partner || {}).label || 'partner'}`.toLowerCase().replace(/^npl/, 'NPL'));
      if (sector) out.push(`Top 5 ${sector.label.toLowerCase()}s by exposure`.replace(/ys by/, 'ies by'));
      if (schema.dpdKey) out.push('DPD aging buckets');
      if (schema.nameKey && schema.dpdKey) out.push(`List the 10 largest loans over ${cfg.nplDpd} DPD`);
      out.push('Portfolio summary');
      return out;
    }

    function answerUnmatched(plan) {
      const parts = plan.unmatched.map(u => {
        const sug = suggestFor(u, schema);
        const s = sug.length ? ` Did you mean ${sug.map(x => `<a href="#" class="pmmc-fix" data-from="${esc(u)}" data-to="${esc(x.value)}">${esc(x.value)}</a> <span class="pmmc-dim">(${esc(x.dim)})</span>`).join(', ')}?` : '';
        return `<p>I couldn't find <b>“${esc(u)}”</b> in the data (searched ${schema.dims.map(d => esc(d.label)).join(', ')}).${s}</p>`;
      });
      return { html: parts.join('') + `<p class="pmmc-dim">I won't guess, so I haven't calculated a figure. You can add a nickname for it in the <code>aliases</code> setting.</p>` };
    }

    function answerSummary(plan) {
      currentMeasure = plan.measure;
      const base = filterRows(plan);
      const tot = total(base, plan.measure);
      const sub = subject(plan);
      let html = `<p>${sub ? 'Snapshot for ' + sub : 'Portfolio snapshot'}${plan.dpd ? ' (' + esc(plan.dpd.label) + ')' : ''}:</p><ul>`;
      html += `<li>${esc(measureOf(plan.measure).label)}: <b>${money(tot)}</b> across <b>${fmtInt(base.length)}</b> ${cfg.unitNoun[1]}</li>`;
      if (schema.dpdKey && !plan.dpd) {
        const pd = base.filter(r => dpdOf(r) > 0), npl = base.filter(r => dpdOf(r) > cfg.nplDpd);
        const pdA = total(pd, plan.measure), nplA = total(npl, plan.measure);
        html += `<li>Past due (DPD &gt; 0): <b>${moneyShort(pdA)}</b> — ${fmtPct(tot ? pdA / tot : 0)}</li>`;
        html += `<li>NPL (DPD &gt; ${cfg.nplDpd}): <b>${moneyShort(nplA)}</b> — NPL ratio <b>${fmtPct(tot ? nplA / tot : 0)}</b> (${fmtInt(npl.length)} ${cfg.unitNoun[1]})</li>`;
      }
      const dim = schema.dims.find(d => !plan.filters[d.key] && /partner|bank|lender|counterpart/.test(d.n)) ||
                  schema.dims.find(d => !plan.filters[d.key] && d.values.size > 1 && d.values.size <= 50);
      if (dim) {
        const g = groupRows(base, dim.key).map(x => ({ label: x.label, v: total(x.rows, plan.measure) })).sort((a, b) => b.v - a.v).slice(0, 3);
        html += `<li>Largest ${esc(dim.label.toLowerCase())}: ${g.map(x => `${esc(x.label)} <b>${moneyShort(x.v)}</b> (${fmtPct(tot ? x.v / tot : 0)})`).join('; ')}</li>`;
      }
      html += '</ul>';
      return { html: html + basis(plan, base.length) };
    }

    function answerList(plan) {
      currentMeasure = plan.measure;
      const rows = filterRows(plan);
      const sortKey = plan.sortByDpd && schema.dpdKey ? '__dpd' : plan.measure;
      const sorted = rows.slice().sort((a, b) => (valOf(b, sortKey) || 0) - (valOf(a, sortKey) || 0));
      if (plan.order === 'asc') sorted.reverse();
      const shown = sorted.slice(0, plan.topN);
      const showCols = [];
      if (schema.idKey) showCols.push(schema.idKey);
      if (schema.nameKey && schema.nameKey !== schema.idKey) showCols.push(schema.nameKey);
      for (const d of schema.dims) if (showCols.length < 3 && !showCols.includes(d.key) && !plan.filters[d.key] && d.values.size <= 50) showCols.push(d.key);
      const m = measureOf(plan.measure);
      const headers = showCols.map(esc).concat([esc(m.label)]).concat(schema.dpdKey ? ['DPD'] : []);
      const body = shown.map(r => showCols.map(c => esc(r[c])).concat([fmtInt(valOf(r, plan.measure) || 0)]).concat(schema.dpdKey ? [fmtInt(dpdOf(r))] : []));
      const right = headers.map((_, i) => i >= showCols.length);
      const sub = subject(plan);
      const intro = rows.length
        ? `<p>${shown.length < rows.length ? `Top ${shown.length} of ${fmtInt(rows.length)}` : `All ${fmtInt(rows.length)}`} ${cfg.unitNoun[1]}${sub ? ' for ' + sub : ''}${plan.dpd ? ' with ' + esc(plan.dpd.label) : ''}, sorted by ${sortKey === '__dpd' ? 'DPD' : esc(m.label)}${plan.order === 'asc' ? ' (smallest first)' : ''}. Total: <b>${money(total(rows, plan.measure))}</b>.</p>`
        : `<p>No ${cfg.unitNoun[1]} match ${describeFilters(plan).join('; ') || 'this question'}.</p>`;
      return { html: intro + (rows.length ? table(headers, body, right) : '') + basis(plan, rows.length) };
    }

    function answerAggregate(plan) {
      currentMeasure = plan.measure;
      const m = measureOf(plan.measure);
      const mLabel = plan.measure === '__dpd' ? 'DPD' : m.label;
      const rows = filterRows(plan);
      const sub = subject(plan);
      const cond = plan.dpd ? esc(plan.dpd.label) : '';
      const scope = [sub && 'for ' + sub, cond && 'with <b>' + cond + '</b>'].filter(Boolean).join(' ');
      const N = cfg.unitNoun;

      // Grouped answers
      if (plan.groupBy) {
        if (plan.groupBy !== '__bucket' && !dimOf(plan.groupBy)) plan.groupBy = null;
      }
      if (plan.groupBy) {
        const gLabel = plan.groupBy === '__bucket' ? 'DPD bucket' : dimOf(plan.groupBy).label;
        const ratioMode = plan.ratio && plan.dpd;                    // e.g. NPL ratio by partner
        const gScope = ratioMode ? (sub ? 'for ' + sub : '') : scope;
        const universe = ratioMode ? filterRows(plan, { useDpd: false }) : rows;
        const groups = groupRows(universe, plan.groupBy);
        const test = plan.dpd ? dpdTest(plan.dpd) : null;
        const grandAll = total(universe, plan.measure);
        let stats = groups.map(g => {
          const sel = ratioMode ? g.rows.filter(r => test(dpdOf(r))) : g.rows;
          const v = plan.agg === 'count' ? sel.length
            : plan.agg === 'distinct' ? new Set(sel.map(r => norm(r[plan.distinctDim]))).size
            : plan.agg === 'avg' ? (sel.length ? total(sel, plan.measure) / sel.filter(r => !isNaN(valOf(r, plan.measure))).length : 0)
            : plan.agg === 'max' ? Math.max(0, ...sel.map(r => valOf(r, plan.measure) || 0))
            : total(sel, plan.measure);
          const base = total(g.rows, plan.measure);
          return { label: g.label, order: g.order, v, n: sel.length, base, ratio: base ? total(sel, plan.measure) / base : 0 };
        });
        const sortVal = s => ratioMode ? s.ratio : s.v;
        if (plan.groupBy === '__bucket') stats.sort((a, b) => a.order - b.order);
        else stats.sort((a, b) => plan.order === 'asc' ? sortVal(a) - sortVal(b) : sortVal(b) - sortVal(a));
        const allCount = stats.length;
        const limit = plan.topN || cfg.maxGroupRows;
        const shown = stats.slice(0, limit);
        const rest = stats.slice(limit);
        const grand = stats.reduce((s, x) => s + x.v, 0);

        let headers, body, right;
        if (ratioMode) {
          headers = [esc(gLabel), esc(plan.dpd.label), 'Total', 'Ratio'];
          body = shown.map(s => [esc(s.label), moneyShort(s.base * s.ratio), moneyShort(s.base), '<b>' + fmtPct(s.ratio) + '</b>']);
          right = [false, true, true, true];
        } else if (plan.agg === 'count' || plan.agg === 'distinct') {
          const what = plan.agg === 'distinct' ? dimOf(plan.distinctDim).label : N[1];
          headers = [esc(gLabel), esc(what[0].toUpperCase() + what.slice(1)), '% of total'];
          body = shown.map(s => [esc(s.label), fmtInt(s.v), fmtPct(grand ? s.v / grand : 0)]);
          right = [false, true, true];
        } else if (plan.agg === 'avg' || plan.agg === 'max') {
          headers = [esc(gLabel), (plan.agg === 'avg' ? 'Avg ' : 'Max ') + esc(mLabel), esc(N[1][0].toUpperCase() + N[1].slice(1))];
          body = shown.map(s => [esc(s.label), fmtNum(s.v), fmtInt(s.n)]);
          right = [false, true, true];
        } else {
          headers = [esc(gLabel), esc(mLabel), 'Share', esc(N[1][0].toUpperCase() + N[1].slice(1))];
          body = shown.map(s => [esc(s.label), moneyShort(s.v), fmtPct(grand ? s.v / grand : 0), fmtInt(s.n)]);
          right = [false, true, true, true];
        }
        if (rest.length && !plan.topN && !ratioMode && (plan.agg === 'sum' || plan.agg === 'count')) {
          const rv = rest.reduce((s, x) => s + x.v, 0), rn = rest.reduce((s, x) => s + x.n, 0);
          body.push([`<i>Other (${rest.length})</i>`].concat(plan.agg === 'sum' ? [moneyShort(rv), fmtPct(grand ? rv / grand : 0), fmtInt(rn)] : [fmtInt(rv), fmtPct(grand ? rv / grand : 0)]));
        }
        let intro;
        if (plan.topN === 1 && shown[0]) {
          const s = shown[0];
          const valTxt = ratioMode ? fmtPct(s.ratio) : (plan.agg === 'count' || plan.agg === 'distinct') ? fmtInt(s.v) : plan.agg === 'sum' ? money(s.v) : fmtNum(s.v);
          intro = `<p><b>${esc(s.label)}</b> has the ${plan.order === 'asc' ? 'lowest' : 'highest'} ${ratioMode ? esc(plan.dpd.label) + ' ratio' : esc(plan.agg === 'count' ? 'number of ' + N[1] : mLabel)}${gScope ? ' ' + gScope : ''}: <b>${valTxt}</b>${!ratioMode && plan.agg === 'sum' && grand ? ` (${fmtPct(s.v / grand)} of the total)` : ''}.</p>`;
        } else if (!universe.length) {
          intro = `<p>No ${N[1]} match ${describeFilters(plan).join('; ')}.</p>`;
        } else {
          const what = ratioMode ? esc(plan.dpd.label) + ' ratio'
            : plan.agg === 'count' ? 'Number of ' + N[1]
            : plan.agg === 'distinct' ? 'Number of ' + esc(dimOf(plan.distinctDim).label.toLowerCase()) + (/s$/.test(dimOf(plan.distinctDim).label) ? '' : 's')
            : plan.agg === 'avg' ? 'Average ' + esc(mLabel)
            : plan.agg === 'max' ? 'Maximum ' + esc(mLabel)
            : esc(mLabel);
          const head = plan.topN ? `${plan.order === 'asc' ? 'Bottom' : 'Top'} ${shown.length} of ${allCount}` : `${allCount} groups`;
          const totTxt = ratioMode ? `Overall: <b>${fmtPct(grandAll ? total(rows, plan.measure) / grandAll : 0)}</b>.`
            : plan.agg === 'sum' ? `Total: <b>${money(grand)}</b>.`
            : plan.agg === 'count' ? `Total: <b>${fmtInt(grand)}</b>.` : '';
          intro = `<p>${what} by ${esc(gLabel.toLowerCase())}${gScope ? ' ' + gScope : ''} — ${head}. ${totTxt}</p>`;
        }
        return { html: intro + (universe.length ? table(headers, body, right) : '') +
          basis(plan, rows.length, ratioMode ? `Ratio = ${esc(plan.dpd.label)} ÷ total ${esc(mLabel)} in each group` : '') };
      }

      // Ratio
      if (plan.ratio) {
        let num, den, numDesc, denDesc;
        if (plan.dpd) {
          num = rows; den = filterRows(plan, { useDpd: false });
          numDesc = esc(plan.dpd.label); denDesc = sub ? sub : 'the whole portfolio';
        } else if (Object.keys(plan.filters).length) {
          num = rows; den = schema.rows; numDesc = sub; denDesc = 'the whole portfolio';
        } else {
          return { html: '<p>A share of what? Try e.g. “what % of exposure is over 90 DPD” or “ANB share of the portfolio”.</p>' };
        }
        const useCount = plan.agg === 'count';
        const a = useCount ? num.length : total(num, plan.measure);
        const b = useCount ? den.length : total(den, plan.measure);
        const r = b ? a / b : 0;
        const fmt = useCount ? fmtInt : moneyShort;
        const label = plan.dpd && plan.dpd.npl ? 'NPL ratio' : 'Share';
        return {
          html: `<p>${label}${plan.dpd && sub ? ' for ' + sub : ''}: <b>${fmtPct(r)}</b> — ${numDesc} is ${fmt(a)} out of ${fmt(b)} for ${denDesc}${useCount ? ' (by number of ' + N[1] + ')' : ' (by ' + esc(mLabel) + ')'}.</p>` + basis(plan, num.length),
        };
      }

      if (!rows.length) {
        return { html: `<p>Nothing matches ${describeFilters(plan).join('; ')} — <b>${plan.agg === 'count' ? '0 ' + N[1] : cfg.currency + ' 0'}</b>.</p>` + basis(plan, 0) };
      }

      if (plan.agg === 'count') {
        const share = rows.length / schema.rows.length;
        return { html: `<p><b>${fmtInt(rows.length)}</b> ${rows.length === 1 ? N[0] : N[1]}${scope ? ' ' + scope : ''}${rows.length !== schema.rows.length ? ` (${fmtPct(share)} of all ${N[1]})` : ''}.</p>` + basis(plan, rows.length) };
      }
      if (plan.agg === 'distinct') {
        const d = dimOf(plan.distinctDim);
        const n = new Set(rows.map(r => norm(r[d.key])).filter(Boolean)).size;
        return { html: `<p><b>${fmtInt(n)}</b> distinct ${esc(d.label.toLowerCase())}${n === 1 ? '' : (/s$/.test(d.label) ? '' : 's')}${scope ? ' ' + scope : ''}, across ${fmtInt(rows.length)} ${N[1]}.</p>` + basis(plan, rows.length) };
      }
      if (plan.agg === 'avg') {
        const vals = rows.map(r => valOf(r, plan.measure)).filter(v => !isNaN(v));
        const avg = vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
        let extra = '';
        if (m && m.avgType && schema.amountKey) {
          let w = 0, ws = 0;
          for (const r of rows) { const a = toNum(r[schema.amountKey]), v = valOf(r, plan.measure); if (!isNaN(a) && !isNaN(v)) { w += a; ws += a * v; } }
          if (w) extra = ` Exposure-weighted average: <b>${fmtNum(ws / w)}</b>.`;
        }
        const val = plan.measure === '__dpd' ? `${fmtNum(avg, 1)} days` : m.avgType ? fmtNum(avg) : money(avg);
        return { html: `<p>Average ${esc(mLabel)}${scope ? ' ' + scope : ''}: <b>${val}</b> across ${fmtInt(vals.length)} ${N[1]}.${extra}</p>` + basis(plan, rows.length) };
      }
      if (plan.agg === 'max') {
        let top = rows[0];
        for (const r of rows) if (dpdOf(r) > dpdOf(top)) top = r;
        const who = [schema.nameKey, schema.idKey].filter(Boolean).map(k => esc(top[k])).join(', ');
        return { html: `<p>Highest DPD${scope ? ' ' + scope : ''}: <b>${fmtInt(dpdOf(top))} days</b>${who ? ' — ' + who : ''} (${moneyShort(toNum(top[schema.amountKey]) || 0)}).</p>` + basis(plan, rows.length) };
      }

      // Plain sum
      const amt = total(rows, plan.measure);
      if (m && m.avgType) {
        plan.agg = 'avg';
        return answerAggregate(plan);
      }
      let share = '';
      if (plan.dpd && Object.keys(plan.filters).length) {
        const base = total(filterRows(plan, { useDpd: false }), plan.measure);
        share = ` That is <b>${fmtPct(base ? amt / base : 0)}</b> of ${sub}'s total ${esc(mLabel.toLowerCase())} (${moneyShort(base)}).`;
      } else if (plan.dpd || Object.keys(plan.filters).length) {
        const base = total(schema.rows, plan.measure);
        share = ` That is <b>${fmtPct(base ? amt / base : 0)}</b> of the portfolio (${moneyShort(base)}).`;
      }
      const lead = plan.measure === schema.amountKey ? 'Exposure' : esc(mLabel);
      return {
        html: `<p>${lead}${scope ? ' ' + scope : ' (whole portfolio)'}: <b>${money(amt)}</b> across <b>${fmtInt(rows.length)}</b> ${rows.length === 1 ? N[0] : N[1]}.${share}</p>` + basis(plan, rows.length),
      };
    }

    // -------------------------------------------------------------- public

    function isFollowUp(q) {
      return /^(and|also|plus|what about|how about|same for|same but|of (that|those|which|them)|for (that|those|them)|then|now|only)\b/.test(q) ||
             /\b(of that|of those|of which|of them|of it|that amount|those loans|these loans|that portfolio|same partner|same bank)\b/.test(q);
    }

    function ask(question) {
      ensureSchema();
      if (!schema.rows.length) return { html: '<p>No portfolio data is loaded yet. Load the data in the dashboard and ask again.</p>', text: 'No data loaded.' };
      if (!schema.amountKey) return { html: '<p>I could not find an exposure/amount column. Set <code>fields.amount</code> in the chat configuration.</p>', text: 'No amount column.' };

      let plan = parse(question, schema, cfg);
      if (plan.mode === 'help') return finish(answerHelp(), plan);
      if (plan.unmatched.length) return finish(answerUnmatched(plan), plan, true);
      if (!plan.recognised && !(last && isFollowUp(plan.q))) {
        return finish({ html: `<p>I'm not sure how to answer that from the portfolio data. I can work with ${schema.dims.map(d => esc(d.label)).join(', ')}${schema.dpdKey ? ', DPD' : ''} and ${schema.measures.map(m => esc(m.label)).join(', ')}.</p><p>Type <a href="#" class="pmmc-ex" data-q="help">help</a> for examples.</p>` }, plan, true);
      }

      if (last && isFollowUp(plan.q)) {
        const merged = Object.assign({}, last, { explicit: plan.explicit, unmatched: [] });
        merged.filters = Object.assign({}, last.filters, plan.filters);
        merged.dpd = plan.dpd || last.dpd;
        merged.measure = plan.measure || last.measure;
        merged.ratio = plan.explicit.ratio ? plan.ratio : (plan.explicit.agg ? false : last.ratio);
        if (plan.explicit.agg) { merged.agg = plan.agg; merged.distinctDim = plan.distinctDim; merged.groupBy = null; merged.topN = null; merged.mode = 'aggregate'; }
        if (plan.explicit.groupBy) { merged.groupBy = plan.groupBy; merged.topN = plan.topN; merged.order = plan.order; merged.mode = 'aggregate'; }
        if (plan.explicit.list) { merged.mode = 'list'; merged.topN = plan.topN; merged.sortByDpd = plan.sortByDpd; merged.groupBy = null; }
        if (plan.mode === 'summary') merged.mode = 'summary';
        merged.q = plan.q;
        plan = merged;
      }
      plan.measure = plan.measure || schema.amountKey;
      if (plan.measure !== '__dpd' && !measureOf(plan.measure)) plan.measure = schema.amountKey;
      if (plan.dpd && !schema.dpdKey) {
        return finish({ html: '<p>I could not find a DPD column in the data, so I can’t filter by days past due. Set <code>fields.dpd</code> in the chat configuration.</p>' }, plan, true);
      }

      let ans;
      if (plan.mode === 'summary') ans = answerSummary(plan);
      else if (plan.mode === 'list') ans = answerList(plan);
      else ans = answerAggregate(plan);
      return finish(ans, plan);
    }

    function finish(ans, plan, skipContext) {
      if (!skipContext && plan.mode !== 'help') last = plan;
      ans.plan = plan;
      ans.text = htmlToText(ans.html);
      return ans;
    }

    return {
      ask,
      reset() { last = null; },
      refresh() { schema = null; ensureSchema(); },
      schema() { return ensureSchema(); },
      examples() { ensureSchema(); return examples(); },
      config: cfg,
    };
  }

  function htmlToText(html) {
    return String(html)
      .replace(/<\/(p|div|li|tr)>/g, '\n').replace(/<\/t[dh]>/g, '\t').replace(/<li>/g, '• ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
  }

  // ------------------------------------------------------------------ UI

  const CSS = `
.pmmc-root{--pmmc-accent:#0f6e5a;--pmmc-bg:#ffffff;--pmmc-fg:#1d2329;--pmmc-muted:#66707a;--pmmc-line:#e3e7eb;--pmmc-user:#e8f3f0;--pmmc-bot:#f5f7f9;--pmmc-shadow:0 12px 40px rgba(0,0,0,.18);
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--pmmc-fg)}
@media (prefers-color-scheme:dark){.pmmc-root:not(.pmmc-light){--pmmc-bg:#1b1f24;--pmmc-fg:#e6e9ec;--pmmc-muted:#9aa4ae;--pmmc-line:#2f353c;--pmmc-user:#183a33;--pmmc-bot:#242a31;--pmmc-shadow:0 12px 40px rgba(0,0,0,.5)}}
.pmmc-root *{box-sizing:border-box}
.pmmc-launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;height:52px;padding:0 18px 0 14px;border-radius:26px;border:0;background:var(--pmmc-accent);color:#fff;font:600 14px system-ui,sans-serif;display:flex;align-items:center;gap:8px;cursor:pointer;box-shadow:var(--pmmc-shadow)}
.pmmc-launcher svg{width:22px;height:22px}
.pmmc-panel{position:fixed;right:20px;bottom:84px;z-index:2147483001;width:500px;max-width:calc(100vw - 32px);height:640px;max-height:calc(100vh - 110px);display:none;flex-direction:column;background:var(--pmmc-bg);border:1px solid var(--pmmc-line);border-radius:14px;box-shadow:var(--pmmc-shadow);overflow:hidden}
.pmmc-open .pmmc-panel{display:flex}
.pmmc-inline .pmmc-panel{position:relative;right:auto;bottom:auto;display:flex;width:100%;max-width:none;height:100%;max-height:none;box-shadow:none}
.pmmc-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--pmmc-line)}
.pmmc-title{font-weight:600;flex:1}
.pmmc-badge{font-size:11px;color:var(--pmmc-accent);border:1px solid currentColor;border-radius:10px;padding:1px 7px;white-space:nowrap}
.pmmc-icon{background:none;border:0;color:var(--pmmc-muted);cursor:pointer;font-size:13px;padding:4px 6px;border-radius:6px}
.pmmc-icon:hover{background:var(--pmmc-bot);color:var(--pmmc-fg)}
.pmmc-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.pmmc-msg{max-width:92%;padding:9px 12px;border-radius:12px;overflow-wrap:anywhere}
.pmmc-msg p{margin:0 0 6px}.pmmc-msg p:last-child{margin-bottom:0}
.pmmc-msg ul{margin:4px 0 6px;padding-left:18px}
.pmmc-user{align-self:flex-end;background:var(--pmmc-user);border-bottom-right-radius:4px}
.pmmc-bot{align-self:flex-start;max-width:100%;background:var(--pmmc-bot);border-bottom-left-radius:4px}
.pmmc-dim{color:var(--pmmc-muted)}
.pmmc-basis{margin-top:6px;font-size:12px;color:var(--pmmc-muted);border-top:1px dashed var(--pmmc-line);padding-top:5px}
.pmmc-table{overflow-x:auto;margin:6px 0}
.pmmc-table table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}
.pmmc-table th,.pmmc-table td{padding:4px 8px;border-bottom:1px solid var(--pmmc-line);text-align:left;white-space:nowrap}
.pmmc-table th{color:var(--pmmc-muted);font-weight:600}
.pmmc-table .r{text-align:right}
.pmmc-msg a{color:var(--pmmc-accent)}
.pmmc-tools{margin-top:4px;text-align:right}
.pmmc-tools button{background:none;border:0;color:var(--pmmc-muted);font-size:11.5px;cursor:pointer;padding:0}
.pmmc-chips{display:flex;gap:6px;flex-wrap:wrap;padding:0 14px 8px}
.pmmc-chip{border:1px solid var(--pmmc-line);background:var(--pmmc-bg);color:var(--pmmc-fg);border-radius:14px;padding:4px 10px;font-size:12px;cursor:pointer}
.pmmc-chip:hover{border-color:var(--pmmc-accent);color:var(--pmmc-accent)}
.pmmc-form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--pmmc-line)}
.pmmc-input{flex:1;min-width:0;border:1px solid var(--pmmc-line);background:var(--pmmc-bg);color:var(--pmmc-fg);border-radius:10px;padding:9px 11px;font:inherit;outline:none}
.pmmc-input:focus{border-color:var(--pmmc-accent)}
.pmmc-send{border:0;background:var(--pmmc-accent);color:#fff;border-radius:10px;padding:0 14px;font:600 13px system-ui,sans-serif;cursor:pointer}
@media (max-width:520px){.pmmc-panel{right:8px;left:8px;width:auto;max-width:none;bottom:80px}}
`;

  function init(cfg) {
    if (typeof document === 'undefined') throw new Error('PMMChat.init needs a browser; use createEngine() in Node.');
    cfg = cfg || {};
    const engine = createEngine(cfg);

    if (!document.getElementById('pmmc-styles')) {
      const st = document.createElement('style');
      st.id = 'pmmc-styles';
      st.textContent = CSS;
      document.head.appendChild(st);
    }

    const rootEl = document.createElement('div');
    rootEl.className = 'pmmc-root';
    if (cfg.accent) rootEl.style.setProperty('--pmmc-accent', cfg.accent);
    if (cfg.theme === 'light') rootEl.classList.add('pmmc-light');
    const container = typeof cfg.container === 'string' ? document.querySelector(cfg.container) : cfg.container;
    if (container) rootEl.classList.add('pmmc-inline');

    const title = cfg.title || 'Portfolio Assistant';
    rootEl.innerHTML = `
      ${container ? '' : `<button class="pmmc-launcher" type="button" aria-expanded="false" aria-controls="pmmc-panel">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>Ask the data</span></button>`}
      <section class="pmmc-panel" id="pmmc-panel" role="dialog" aria-label="${esc(title)}">
        <div class="pmmc-head">
          <span class="pmmc-title">${esc(title)}</span>
          <span class="pmmc-badge" title="Answers are computed in this browser from the dashboard's data. Nothing is sent over the network.">Offline · data stays here</span>
          <button class="pmmc-icon pmmc-clear" type="button" title="Clear conversation">Clear</button>
          ${container ? '' : '<button class="pmmc-icon pmmc-close" type="button" title="Close" aria-label="Close">✕</button>'}
        </div>
        <div class="pmmc-log" aria-live="polite"></div>
        <div class="pmmc-chips"></div>
        <form class="pmmc-form" autocomplete="off">
          <input class="pmmc-input" type="text" placeholder="e.g. What's our exposure with ANB?" aria-label="Ask a question about the portfolio">
          <button class="pmmc-send" type="submit">Ask</button>
        </form>
      </section>`;
    (container || document.body).appendChild(rootEl);

    const $ = sel => rootEl.querySelector(sel);
    const log = $('.pmmc-log'), input = $('.pmmc-input'), chips = $('.pmmc-chips');
    const history = [];
    let hIdx = -1;

    function addMsg(who, html, text) {
      const el = document.createElement('div');
      el.className = 'pmmc-msg pmmc-' + who;
      if (who === 'user') el.textContent = html;
      else {
        el.innerHTML = html;
        const tools = document.createElement('div');
        tools.className = 'pmmc-tools';
        const copy = document.createElement('button');
        copy.type = 'button'; copy.textContent = 'Copy';
        copy.onclick = () => {
          const done = () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); };
          if (navigator.clipboard) navigator.clipboard.writeText(text || el.innerText).then(done, () => {});
        };
        tools.appendChild(copy);
        el.appendChild(tools);
      }
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    function ask(q) {
      q = String(q || '').trim();
      if (!q) return;
      history.push(q); hIdx = history.length;
      addMsg('user', q);
      chips.style.display = 'none';
      let ans;
      try { ans = engine.ask(q); } catch (e) {
        console.error('[PMMChat]', e);
        ans = { html: '<p>Sorry — something went wrong computing that answer. Try rephrasing.</p>', text: '' };
      }
      addMsg('bot', ans.html, ans.text);
      if (typeof cfg.onAnswer === 'function') cfg.onAnswer(q, ans);
      return ans;
    }

    function renderChips() {
      chips.innerHTML = '';
      let ex = [];
      try { ex = engine.examples().slice(0, 4); } catch (e) { /* no data yet */ }
      for (const q of ex) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'pmmc-chip'; b.textContent = q;
        b.onclick = () => ask(q);
        chips.appendChild(b);
      }
    }

    function greet() {
      log.innerHTML = '';
      chips.style.display = '';
      addMsg('bot', `<p>Hi! Ask me about the portfolio — exposure by partner, DPD, NPLs, sectors and more. Type <b>help</b> for examples.</p>`, '');
      renderChips();
    }

    $('.pmmc-form').addEventListener('submit', e => { e.preventDefault(); const q = input.value; input.value = ''; ask(q); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp' && history.length) { hIdx = Math.max(0, hIdx - 1); input.value = history[hIdx]; e.preventDefault(); }
      if (e.key === 'ArrowDown' && history.length) { hIdx = Math.min(history.length, hIdx + 1); input.value = history[hIdx] || ''; e.preventDefault(); }
    });
    log.addEventListener('click', e => {
      const a = e.target.closest('a.pmmc-ex, a.pmmc-fix');
      if (!a) return;
      e.preventDefault();
      if (a.classList.contains('pmmc-ex')) ask(a.dataset.q);
      else {
        const prev = history[history.length - 1] || '';
        const re = new RegExp(a.dataset.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        ask(prev.replace(re, a.dataset.to));
      }
    });
    $('.pmmc-clear').onclick = () => { engine.reset(); greet(); };

    const launcher = $('.pmmc-launcher');
    function open() { rootEl.classList.add('pmmc-open'); if (launcher) launcher.setAttribute('aria-expanded', 'true'); renderChips(); input.focus(); }
    function close() { rootEl.classList.remove('pmmc-open'); if (launcher) { launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); } }
    if (launcher) launcher.onclick = () => rootEl.classList.contains('pmmc-open') ? close() : open();
    const closeBtn = $('.pmmc-close');
    if (closeBtn) closeBtn.onclick = close;
    rootEl.addEventListener('keydown', e => { if (e.key === 'Escape' && !container) close(); });

    greet();
    return {
      engine, ask, open, close,
      refresh() { engine.refresh(); renderChips(); },
      destroy() { rootEl.remove(); },
    };
  }

  return { init, createEngine, _internals: { norm, parseDpd, toNum } };
});

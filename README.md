# PMM Chat: an offline chatbot for the PMM dashboard

A drop-in chat panel for the Portfolio Monitoring & Management dashboard. Users ask questions in plain English, for example:

- *"What's our exposure with ANB?"*
- *"And how much is over 90 DPD?"*: follow-ups remember the previous question

They get exact figures computed from the same data the dashboard has loaded.

## Why it is built this way

| Requirement | How it's met |
|---|---|
| **Data privacy** | Everything runs inside the dashboard page. There is no AI service, no API call and no network request. You can verify this: `demo/index.html` sets a Content-Security-Policy with `connect-src 'none'`, which makes the browser block any network call. |
| **Correct numbers** | It doesn't guess. Each question becomes a filter + sum/count/ratio over your records. Every answer ends with a **basis line** (filters, measure, record count) so the figure can be checked. |
| **No hallucinated entities** | If a name isn't found in the data (e.g. "XYZ Bank"), it says so and suggests close matches. It doesn't return the portfolio total instead. |
| **Works offline** | One JavaScript file, no dependencies, no CDN. Works from `file://`. |

## Try it

Open `demo/index.html` in a browser (double-click is fine). It loads **synthetic** sample data. To try your own data, use **Load CSV…**. The file is read in the browser only.

## Add it to your dashboard

1. Copy `pmm-chat.js` next to your dashboard HTML file. If you keep the dashboard as a single file, paste the file's contents inside a `<script>` tag instead.
2. Add this before `</body>`, pointing `data` at the array of records your dashboard already builds from its files:

```html
<script src="pmm-chat.js"></script>
<script>
  const chat = PMMChat.init({
    data: () => window.portfolioRows,   // ← your dashboard's array of loan/facility rows

    // Optional: column names are auto-detected, but you can pin them down
    fields: {
      amount: 'Outstanding Balance',    // main exposure measure
      dpd: 'DPD',                       // days past due
      id: 'Loan ID',
      name: 'Borrower Name',
      // dimensions: ['Partner', 'Program', 'Sector', 'Region']   // limit which columns are searchable
    },

    // Optional: nicknames people use. Acronyms like ANB, SNB, BSF are already
    // derived automatically from "Arab National Bank" etc.
    aliases: { SAIB: 'Saudi Investment Bank', Rajhi: 'Al Rajhi Bank' },

    currency: 'SAR',
    nplDpd: 90,                // NPL = DPD > 90
    buckets: [30, 60, 90],     // aging buckets: Current, 1–30, 31–60, 61–90, 90+
    title: 'Portfolio Assistant',
    // accent: '#0f6e5a',       // match your dashboard colour
    // container: '#chat-tab',  // render inside an element instead of a floating button
  });

  // If the dashboard reloads its files, call:
  // chat.refresh();
</script>
```

`data` is a function, so the chat always reads the current data. To make the chat answer for the dashboard's **current filtered view**, return the filtered array instead.

## What it can answer

| Question type | Examples |
|---|---|
| Exposure for an entity | "exposure with ANB", "how much do we have with Al Rajhi in Riyadh" |
| DPD conditions | "over 90 DPD", "90+", "31–60 days", "at least 30 days past due", "past due", "NPLs", "performing" |
| Follow-ups | "and how much of that is over 90 DPD?", "what about SNB?", "and by sector" |
| Ratios / shares | "NPL ratio", "NPL rate for Alinma", "what % of the portfolio is ANB" |
| Breakdowns | "exposure by sector", "NPL ratio by partner", "DPD aging buckets", "ANB vs SNB" |
| Rankings | "top 5 sectors", "which partner has the highest NPL ratio?" |
| Counts | "how many loans are past due", "how many borrowers with Al Rajhi" |
| Other measures | "approved limit for SAIB", "average interest rate for NBFIs", "average DPD by program", "max DPD for Riyad Bank" |
| Loan lists | "list the 10 largest loans over 90 DPD", "oldest loans for Alinma" |
| Overview | "portfolio summary", "summary for ANB", "help" |

**Definitions used.** "Over 90 DPD" and "90+" both mean DPD **> 90**, which matches the 90+ bucket and the NPL definition. "At least 90" means DPD ≥ 90. Change the NPL threshold with `nplDpd`.

## Tests

```bash
node tests/engine.test.js
```

The tests compare the chatbot's answers with figures computed directly from the raw rows.

## Files

- `pmm-chat.js`: the chatbot (query engine + chat UI), the only file your dashboard needs
- `demo/index.html`, `demo/sample-data.js`: demo page with synthetic data
- `tests/engine.test.js`: accuracy tests

## Possible next steps

- **Free-form questions with a local AI model.** For open-ended questions ("why did NPLs rise?"), a local model can run on the same PC (e.g. via Ollama), so data still never leaves the machine. Keep the current engine for the figures and use the model only to phrase them.
- **Arabic questions**: add Arabic keywords to the vocabulary.
- **Time questions** ("NPL trend since Q1"): needs a reporting-date column in the data.

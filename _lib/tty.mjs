// _lib/tty.mjs — colour, the wordmark, and the rules about when NOT to use them.
//
// WHY THIS IS HAND-ROLLED
//
// The obvious move is chalk, ora or ink. The pack ships with EXACTLY ONE runtime
// dependency (`yaml`), and that is not a preference — SECURITY.md states it as a fact a
// reader can verify by grep, directly under "No telemetry", as part of the argument that
// this package's supply chain is small enough to audit. Adding a colour library to make
// the output prettier would spend that claim, and the whole of it is ~40 lines of ANSI.
//
// Charm and Bubbles are the right answer to this problem in Go. There is no Node binding
// for them, and the Node equivalents are dependencies, so the same argument applies.
//
// WHEN NOT TO COLOUR — this matters more than the colours.
//
// The pack's output is machine-read: `--json` gets parsed, exit codes get branched on,
// and `richapi doctor` output gets pasted into issues. So styling is suppressed whenever
// it could corrupt any of that:
//
//   * not a TTY            piping to a file, a pipe, or CI
//   * NO_COLOR set         the cross-tool standard (https://no-color.org)
//   * TERM=dumb            an emacs shell, a serial console
//   * --json / --quiet     the caller explicitly asked for clean output
//
// FORCE_COLOR=1 overrides the TTY check, for a user piping into `less -R` on purpose. It
// cannot override --json, because that would produce unparseable output.

const ESC = '[';

/** Is styling safe on this stream right now? */
export function colorEnabled (stream = process.stdout, { json = false, quiet = false } = {}) {
  if (json) return false; // never corrupt parseable output
  if (quiet) return false;
  if (process.env.NO_COLOR !== undefined) return false; // no-color.org: presence, not value
  if (process.env.FORCE_COLOR) return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(stream && stream.isTTY);
}

const CODES = {
  reset: 0, bold: 1, dim: 2,
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90,
};

/**
 * A styling function bound to one decision, so a caller cannot accidentally colour half
 * its output. `style(false)` returns identity functions rather than null, so call sites
 * stay free of `enabled ? c.red(x) : x` ternaries.
 */
export function style (enabled) {
  const wrap = (code) => (enabled
    ? (s) => `${ESC}${code}m${s}${ESC}${CODES.reset}m`
    : (s) => String(s));
  const out = {};
  for (const [name, code] of Object.entries(CODES)) out[name] = wrap(code);
  out.enabled = Boolean(enabled);
  return out;
}

/** Strip every escape this module can emit. Used by tests and by width maths. */
export const stripAnsi = (s) => String(s).replace(/\[[0-9;]*m/g, '');

/** Visible width, so a box is not broken by the colours inside it. */
export const visibleWidth = (s) => stripAnsi(s).length;

// The wordmark. Deliberately small: a logo that fills the terminal is a logo the user
// turns off. Five lines, and it never prints more than once per command.
const WORDMARK = [
  '  ####   ##   ####  ##  ##',
  '  ##  #  ##  ##     ##  ##',
  '  #####  ##  ##     ######',
  '  ##  #  ##  ##     ##  ##',
  '  ##  #  ##   ####  ##  ##   A P I',
];

/**
 * The banner, or an empty string when styling is off.
 *
 * Returning '' rather than a plain-text logo is deliberate: in a pipe, in CI, or under
 * --json, the banner is noise a parser has to skip. A brand that turns up in somebody's
 * log parser is not charming.
 */
export function banner ({ enabled = colorEnabled(), version = null, tagline = null } = {}) {
  if (!enabled) return '';
  const c = style(true);
  const lines = WORDMARK.map((l) => c.cyan(l));
  const foot = [version && c.dim(version), tagline && c.dim(tagline)]
    .filter(Boolean).join(c.dim('  ·  '));
  return `\n${lines.join('\n')}\n${foot ? `  ${foot}\n` : ''}`;
}

/** A status chip: `[  ok  ]`, coloured by state, fixed width so columns line up. */
export function chip (state, c = style(false)) {
  const map = {
    ok: ['  ok  ', c.green],
    warn: [' warn ', c.yellow],
    fail: [' fail ', c.red],
    stop: [' stop ', c.red],
    unknown: ['  ??  ', c.gray],
  };
  const [label, paint] = map[String(state).toLowerCase()] ?? map.unknown;
  return `${c.dim('[')}${paint(label)}${c.dim(']')}`;
}

/**
 * A single-line box, sized to its VISIBLE width so embedded colour does not skew it.
 * Used for the one thing a user must not miss: the credit total awaiting approval.
 */
export function box (lines, { c = style(false), pad = 1 } = {}) {
  const rows = [].concat(lines);
  const width = Math.max(...rows.map(visibleWidth)) + pad * 2;
  const bar = '─'.repeat(width);
  const spaces = ' '.repeat(pad);
  const out = [c.dim(`┌${bar}┐`)];
  for (const r of rows) {
    const fill = ' '.repeat(Math.max(0, width - visibleWidth(r) - pad));
    out.push(`${c.dim('│')}${spaces}${r}${fill}${c.dim('│')}`);
  }
  out.push(c.dim(`└${bar}┘`));
  return out.join('\n');
}

/**
 * A progress line for a long run, written to STDERR so it never lands in piped output,
 * and skipped entirely when stderr is not a TTY.
 *
 * No spinner. A spinner on a slow API call animates while nothing is known, which is a
 * claim about progress the pack cannot make. This prints what it actually knows and
 * clears it when done.
 */
export function progress (text, { stream = process.stderr } = {}) {
  if (!stream || !stream.isTTY) return () => {};
  stream.write(`${ESC}2K\r${text}`);
  return () => stream.write(`${ESC}2K\r`);
}

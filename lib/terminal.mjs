// Small terminal vocabulary. Piped output stays plain; narrow terminals keep every value.
// One warm accent, the viewer's (#d9a049). Nothing else glows.
export const ACCENT = '38;5;179';

// A person is watching: colour, and plumbing lines (worktrees, trunk bookkeeping) stay out of
// the way. Piped output and logs keep every line, plain. OSTOYAE_VERBOSE=1 shows plumbing anyway.
export function forPerson(stream = process.stdout, env = process.env) {
  return !!stream.isTTY && env.TERM !== 'dumb';
}
export function showsPlumbing(stream = process.stdout, env = process.env) {
  return !forPerson(stream, env) || /^(1|true|yes)$/i.test(env.OSTOYAE_VERBOSE ?? '');
}

export function terminal(stream = process.stdout, env = process.env) {
  const width = Math.max(20, Math.min(100, stream.columns || 80));
  const color = !!stream.isTTY && !('NO_COLOR' in env) && env.TERM !== 'dumb';
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : String(text);
  const clean = text => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  const wrap = (text, available = width - 4) => {
    const words = clean(text).split(' '), lines = [];
    let line = '';
    for (let word of words) {
      if (line && line.length + word.length + 1 > available) { lines.push(line); line = ''; }
      while (word.length > available) {
        if (line) { lines.push(line); line = ''; }
        lines.push(word.slice(0, available)); word = word.slice(available);
      }
      if (word) line += (line ? ' ' : '') + word;
    }
    if (line || !lines.length) lines.push(line);
    return lines;
  };
  const dim = value => paint('2', value);
  const accent = value => paint(ACCENT, value);
  const text = value => wrap(value).map(line => `  ${line}`).join('\n');
  // Wrapped first, painted after: paint codes must never be counted or cleaned as text.
  const quiet = value => wrap(value).map(line => `  ${dim(line)}`).join('\n');
  const row = (label, value) => {
    const name = clean(label), content = clean(value);
    const column = width >= 80 ? 16 : 14;
    if (width < 60 || name.length >= column) return `  ${dim(name)}\n${wrap(content, width - 6).map(line => `    ${line}`).join('\n')}`;
    return wrap(content, width - column - 4).map((line, i) => i ? `${' '.repeat(column + 2)}${line}` : `  ${dim(name.padEnd(column))}${line}`).join('\n');
  };
  // A command line to type: the accent marks what to run next.
  const command = (cmd, note = '') => {
    const c = clean(cmd), n = clean(note);
    if (!n) return wrap(c).map(line => `  ${accent(line)}`).join('\n');
    const column = width >= 80 ? 36 : 18;
    if (width < 60 || c.length + 2 > column) return `  ${accent(c)}\n${wrap(n, width - 6).map(line => `    ${dim(line)}`).join('\n')}`;
    return wrap(n, width - column - 4).map((line, i) => i ? `${' '.repeat(column + 2)}${dim(line)}` : `  ${accent(c.padEnd(column))}${dim(line)}`).join('\n');
  };
  // The wordmark in the accent, what this screen is beside it, then the title. No banner, no rule.
  const heading = (title, subtitle) => {
    const top = wrap(`ostoyae${subtitle ? `  ${clean(subtitle)}` : ''}`).map((line, i) =>
      `  ${i === 0 ? paint(`1;${ACCENT}`, 'ostoyae') + dim(line.slice(7)) : dim(line)}`);
    return ['', ...top, '', ...wrap(title).map(line => `  ${paint('1', line)}`), ''].join('\n');
  };
  return { width, color, paint, clean, wrap, text, quiet, row, heading, dim, accent, command,
    section: title => `\n  ${paint('1', clean(title))}` };
}

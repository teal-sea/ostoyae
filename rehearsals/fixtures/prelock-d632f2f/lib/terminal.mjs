// Small terminal vocabulary. Piped output stays plain; narrow terminals keep every value.
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
  const text = value => wrap(value).map(line => `  ${line}`).join('\n');
  const row = (label, value) => {
    const name = clean(label), content = clean(value);
    const column = width >= 80 ? 22 : 18;
    if (width < 60 || name.length >= column) return `  ${paint('38;5;109', name)}\n${wrap(content, width - 6).map(line => `    ${line}`).join('\n')}`;
    return wrap(content, width - column - 4).map((line, i) => i ? `${' '.repeat(column + 2)}${line}` : `  ${paint('38;5;109', name.padEnd(column))}${line}`).join('\n');
  };
  const heading = (title, subtitle) => [
    '', `  ${paint('1;38;5;86', 'O S T O Y A E')}`, text(subtitle),
    `  ${paint('38;5;238', '─'.repeat(width - 4))}`, ...wrap(title).map(line => `  ${paint('1', line)}`), '',
  ].join('\n');
  return { width, color, paint, clean, wrap, text, row, heading,
    section: title => `\n  ${paint('1;38;5;86', clean(title))}` };
}

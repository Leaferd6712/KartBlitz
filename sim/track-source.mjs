/** Locate the authored TRACKS data without executing JavaScript. */
export function trackSourceRanges(html) {
  const declarations = [...html.matchAll(/\bconst TRACKS\s*=\s*\[/g)];
  if (declarations.length !== 1) throw new Error('Expected one TRACKS catalog');
  const arrayStart = declarations[0].index + declarations[0][0].length - 1;
  const stack = ['['], tracks = [];
  let objectStart = -1;
  for (let i = arrayStart + 1; i < html.length; i++) {
    const c = html[i];
    if (c === '/' && html[i + 1] === '/') {
      const end = html.indexOf('\n', i + 2);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (c === '/' && html[i + 1] === '*') {
      const end = html.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let closed = false;
      while (++i < html.length) {
        if (html[i] === '\\') { i++; continue; }
        if (html[i] === quote) { closed = true; break; }
      }
      if (!closed) break;
      continue;
    }
    if (c === '`') throw new Error('Templates are not allowed in the track catalog');
    if (c === '[' || c === '{') {
      if (stack.length === 1) {
        if (c !== '{') throw new Error('Expected a track object');
        objectStart = i;
      }
      stack.push(c);
    } else if (c === ']' || c === '}') {
      const open = stack.pop();
      if (open !== (c === ']' ? '[' : '{')) throw new Error('Invalid track catalog delimiters');
      if (stack.length === 1 && objectStart >= 0) {
        const id = html.slice(objectStart, i + 1).match(/^\{\s*(?:id|"id")\s*:\s*(\d+)\s*,/);
        if (!id || tracks.some(track => track.id === Number(id[1]))) throw new Error('Invalid or duplicate track ID');
        tracks.push({ id: Number(id[1]), start: objectStart, end: i + 1 });
        objectStart = -1;
      }
      if (!stack.length) return { arrayStart, arrayEnd: i, tracks };
    } else if (stack.length === 1 && !/[\s,]/.test(c)) {
      throw new Error('Expected a literal track object');
    }
  }
  throw new Error('Unterminated track catalog');
}

export function replaceTrackSource(html, track) {
  const catalog = trackSourceRanges(html);
  const existing = catalog.tracks.find(entry => entry.id === track.id);
  // IDs also index the training catalog: additions must remain contiguous.
  if (!existing && track.id !== catalog.tracks.length) throw new Error('New tracks must use the next track ID');
  const encoded = JSON.stringify({ id: track.id, ...track }, null, 2)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  if (existing) return html.slice(0, existing.start) + encoded + html.slice(existing.end);
  const last = catalog.tracks.at(-1);
  const comma = last && !html.slice(last.end, catalog.arrayEnd).trimStart().startsWith(',') ? ',' : '';
  return html.slice(0, catalog.arrayEnd) + comma + '\n' + encoded + '\n' + html.slice(catalog.arrayEnd);
}

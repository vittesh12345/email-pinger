const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…' };

/** Good-enough HTML → plain text for reading an email body. Output is only ever shown as text. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name) => {
      const key = name.toLowerCase();
      if (ENTITIES[key] !== undefined) return ENTITIES[key];
      if (key.startsWith('#x')) return safeCodePoint(parseInt(key.slice(2), 16), whole);
      if (key.startsWith('#')) return safeCodePoint(parseInt(key.slice(1), 10), whole);
      return whole;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeCodePoint(n, fallback) {
  try {
    return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : fallback;
  } catch {
    return fallback;
  }
}

const MEETING_LINK =
  /https:\/\/(?:teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet|[\w.-]*zoom\.us\/[jw]|meet\.google\.com|[\w.-]*webex\.com)\/[^\s<>"')]+/i;

/** First video-meeting link found in any of the given strings. */
export function findMeetingLink(...texts) {
  for (const t of texts) {
    const m = MEETING_LINK.exec(String(t || ''));
    if (m) return m[0];
  }
  return null;
}

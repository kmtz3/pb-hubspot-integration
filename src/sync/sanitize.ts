import sanitizeHtml from 'sanitize-html';

// Allowed HTML tags + attributes for Productboard rich-text fields.
// Mirrors PBToolkit/src/services/entities/fieldBuilder.js (SANITIZE_OPTS).
const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'p', 'b', 'i', 'u', 's', 'code', 'pre',
    'ul', 'ol', 'li', 'a', 'hr', 'blockquote', 'span', 'br',
  ],
  allowedAttributes: { a: ['href'] },
};

// Wrap plain text in <p> (with <br/> for newlines) or sanitize HTML through
// the same allowlist PB's web app uses. Returns null for empty input so the
// mapper can drop the field cleanly. Ported verbatim from PBToolkit.
export function sanitizeDescription(html: unknown): string | null {
  if (!html) return null;
  const s = String(html).trim();
  if (!s) return null;
  if (!/<\/?[a-z][\s\S]*>/i.test(s)) {
    const escaped = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<p>${escaped.replace(/\n/g, '<br/>')}</p>`;
  }
  // Escape bare & that aren't already part of an HTML entity reference, so
  // sanitize-html doesn't pass invalid XML downstream to the PB API.
  const preEscaped = s.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;');
  return sanitizeHtml(preEscaped, SANITIZE_OPTS) || null;
}

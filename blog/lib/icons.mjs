/* Tabler outline icons (MIT, tabler.io/icons), the family the main site's
   board already draws with: 24px grid, 1.8 stroke, round caps. Copied as path
   data so the page loads no icon font and no third-party script. */

const P = {
  search: '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/>',
  arrowRight: '<path d="M5 12l14 0"/><path d="M13 18l6 -6"/><path d="M13 6l6 6"/>',
  arrowUpRight: '<path d="M17 7l-10 10"/><path d="M8 7l9 0l0 9"/>',
  link: '<path d="M9 15l6 -6"/><path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464"/><path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463"/>',
  linkedin: '<path d="M8 11v5"/><path d="M8 8v.01"/><path d="M12 16v-5"/><path d="M16 16v-3a2 2 0 1 0 -4 0"/><path d="M3 7a4 4 0 0 1 4 -4h10a4 4 0 0 1 4 4v10a4 4 0 0 1 -4 4h-10a4 4 0 0 1 -4 -4z"/>',
  whatsapp: '<path d="M3 21l1.65 -3.8a9 9 0 1 1 3.4 2.9l-5.05 .9"/><path d="M9 10a.5 .5 0 0 0 1 0v-1a.5 .5 0 0 0 -1 0v1a5 5 0 0 0 5 5h1a.5 .5 0 0 0 0 -1h-1a.5 .5 0 0 0 0 1"/>',
  x: '<path d="M4 4l11.733 16h4.267l-11.733 -16z"/><path d="M4 20l6.768 -6.768m2.46 -2.46l6.772 -6.772"/>',
  rss: '<path d="M4 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M4 4a16 16 0 0 1 16 16"/><path d="M4 11a9 9 0 0 1 9 9"/>',
  menu: '<path d="M4 6l16 0"/><path d="M4 12l16 0"/><path d="M4 18l16 0"/>',
  close: '<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>',
  check: '<path d="M5 12l5 5l10 -10"/>',
  list: '<path d="M9 6l11 0"/><path d="M9 12l11 0"/><path d="M9 18l11 0"/><path d="M5 6l0 .01"/><path d="M5 12l0 .01"/><path d="M5 18l0 .01"/>',
  chevronLeft: '<path d="M15 6l-6 6l6 6"/>',
  chevronRight: '<path d="M9 6l6 6l-6 6"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/>',
};

export function icon(name, size = 18, cls = '') {
  const d = P[name];
  if (!d) throw new Error(`No icon "${name}"`);
  return `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
}

/* The radar mark, the same geometry as the main site's masthead. */
export const MARK = `<svg viewBox="0 0 44 44" aria-hidden="true" focusable="false">
<circle class="s-ring" cx="22" cy="22" r="20"/><circle class="s-ring" cx="22" cy="22" r="13"/><circle class="s-ring" cx="22" cy="22" r="6"/>
<g class="s-sweep"><path d="M22 22 L22 1 A21 21 0 0 1 40 12 Z"/></g><circle class="s-dot" cx="22" cy="22" r="2.8"/>
</svg>`;

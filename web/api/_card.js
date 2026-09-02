/**
 * The Open Graph card as a satori element tree — PURE, and deliberately free of
 * any import from @vercel/og.
 *
 * Split out so the layout can be rendered and LOOKED AT without deploying, and
 * without dragging in a renderer that cannot be loaded outside the edge
 * runtime. Four bugs in the HTML version of this card were found only by
 * extracting a frame and looking at it; none of them would have been found by
 * reading the code.
 */
const BG = '#0a0a0b';
const INK = '#f2f2ec';
const INK_2 = '#9d9d94';
const LIVE = '#c8ff00';
const RULE = '#303036';

/** satori takes plain {type, props} objects; there is no JSX step here. */
const h = (type, props = {}, ...children) => ({
  type,
  props: { ...props, children: children.length === 1 ? children[0] : children },
});

const svgUri = (svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

/** The radar, bleeding off the right edge — the mark as environment. */
const RADAR = svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 720" width="720" height="720">
<circle cx="360" cy="360" r="352" fill="none" stroke="${LIVE}" stroke-width="1.4" opacity=".11"/>
<circle cx="360" cy="360" r="272" fill="none" stroke="${LIVE}" stroke-width="1.4" opacity=".22"/>
<circle cx="360" cy="360" r="192" fill="none" stroke="${LIVE}" stroke-width="1.4" opacity=".11"/>
<circle cx="360" cy="360" r="112" fill="none" stroke="${LIVE}" stroke-width="1.4" opacity=".22"/>
<line x1="8" y1="360" x2="712" y2="360" stroke="${LIVE}" stroke-width="1.4" opacity=".10"/>
<line x1="360" y1="8" x2="360" y2="712" stroke="${LIVE}" stroke-width="1.4" opacity=".10"/>
<defs><linearGradient id="sw" x1="0" y1="1" x2="1" y2="0">
<stop offset="0" stop-color="${LIVE}" stop-opacity="0"/><stop offset="1" stop-color="${LIVE}" stop-opacity=".30"/>
</linearGradient></defs>
<path d="M360 360 L360 88 A272 272 0 0 1 552 168 Z" fill="url(#sw)"/>
<circle cx="360" cy="360" r="7" fill="${LIVE}"/>
<circle cx="486" cy="243" r="6.5" fill="${LIVE}" opacity=".85"/>
<circle cx="424" cy="470" r="5" fill="${LIVE}" opacity=".45"/>
</svg>`);

/** The wordmark's own small scope. */
const MARK = svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44">
<circle cx="22" cy="22" r="20" fill="none" stroke="${LIVE}" stroke-width="1.6" opacity=".34"/>
<circle cx="22" cy="22" r="13" fill="none" stroke="${LIVE}" stroke-width="1.6" opacity=".34"/>
<circle cx="22" cy="22" r="6" fill="none" stroke="${LIVE}" stroke-width="1.6" opacity=".34"/>
<path d="M22 22 L22 1 A21 21 0 0 1 40 12 Z" fill="${LIVE}" opacity=".32"/>
<circle cx="22" cy="22" r="2.9" fill="${LIVE}"/></svg>`);

/**
 * Satori cannot fit text to a box, so the size is chosen from the length.
 *
 * The HTML card measured and shrank in a loop; there is no layout pass to read
 * here. These steps were picked against the real spread of titles — median 34
 * characters, and one real posting at 172 because an employer named fifteen
 * cities in it.
 */
export function roleSize(len) {
  if (len <= 26) return 92;
  if (len <= 44) return 74;
  if (len <= 72) return 58;
  if (len <= 104) return 46;
  return 38;
}

/** Trim at a word boundary; a title is not allowed to become the whole card. */
export function clampTitle(raw, max = 128) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, '');
}

const chip = (text, hot) => h('div', {
  style: {
    display: 'flex', fontFamily: 'JetBrains Mono', fontSize: 19, letterSpacing: '0.1em',
    textTransform: 'uppercase', color: hot ? LIVE : INK_2,
    border: `1px solid ${hot ? 'rgba(200,255,0,0.34)' : RULE}`,
    borderRadius: 4, padding: '10px 16px',
  },
}, text);

/**
 * The card, as a satori element tree. Pure, so it can be rendered and LOOKED at
 * without deploying — which is how four bugs were found in the HTML version.
 */
export function buildCard({ company, title, facts = [], logo = '' }) {
  const role = clampTitle(title);
  return h('div', {
    style: {
      width: 1200, height: 630, display: 'flex', flexDirection: 'column',
      justifyContent: 'space-between', backgroundColor: BG, color: INK,
      padding: '58px 64px', position: 'relative', fontFamily: 'JetBrains Mono',
    },
  },
    h('img', { src: RADAR, width: 720, height: 720,
      style: { position: 'absolute', right: -170, top: -45 } }),

    /* THE EMPLOYER'S MARK IS THE HERO, and ours is attribution.
     *
     * This card is what LinkedIn renders as the preview on his posts, and reach
     * is what the posts are for. At 64px the employer's logo was a detail
     * beside a 42px INTERNDOOR wordmark — so the thing a student recognises at
     * a glance, and the only thing on the card with any brand equity yet, was
     * the smallest element on it. The wordmark is what nobody knows.
     *
     * A COMPANY BANNER WOULD BE BETTER AND WE DO NOT HAVE ONE. 462 logo files,
     * zero banners — LinkedIn company banners are not in the data, and getting
     * them means new scraping plus hosting somebody else's brand art. A large
     * logo is the version of that idea we can actually stand behind: it is
     * nominative use next to a factual "X is hiring, apply here", which is what
     * every job board does. */
    // masthead — ours, deliberately small
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      h('div', { style: { display: 'flex', alignItems: 'center' } },
        h('img', { src: MARK, width: 30, height: 30, style: { marginRight: 11 } }),
        h('div', { style: {
          display: 'flex', fontFamily: 'Archivo', fontSize: 26, letterSpacing: '-0.045em', color: INK,
        } }, 'INTERN'),
        h('div', { style: {
          display: 'flex', fontFamily: 'Archivo', fontSize: 26, letterSpacing: '-0.045em', color: LIVE,
        } }, 'DOOR'),
      ),
      chip('Hiring', true),
    ),

    // the employer, then the role
    h('div', { style: { display: 'flex', flexDirection: 'column', maxWidth: 790 } },
      ...(logo ? [h('div', { style: { display: 'flex', marginBottom: 24 } },
        h('img', { src: logo, width: 132, height: 132,
          style: { borderRadius: 22, objectFit: 'cover' } }),
      )] : []),
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 16 } },
        h('div', { style: {
          display: 'flex', fontFamily: 'JetBrains Mono', fontSize: 30, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: LIVE,
        } }, company),
      ),
      h('div', { style: {
        display: 'flex', fontFamily: 'Archivo', fontSize: roleSize(role.length),
        lineHeight: 1.02, letterSpacing: '-0.035em', color: INK,
      } }, role),
    ),

    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } },
        ...facts.slice(0, 3).map((f, i) => chip(f, i === 0)),
      ),
      h('div', { style: {
        display: 'flex', fontFamily: 'JetBrains Mono', fontSize: 21,
        letterSpacing: '0.08em', color: INK_2,
      } }, 'interndoor.com'),
    ),
  );
}

/**
 * A region's board lives under its own slug and India's is at the root.
 *
 * The three-entry map is a copy of regionPath() from src/regions.js, which an
 * edge function cannot import. It changes only when a region is added, and
 * test/og.test.mjs asserts the two agree so that day is not silent.
 */
export const REGION_PREFIX = { IN: '', US: '/us', GB: '/uk' };

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
/* The site's own tokens (web/public/styles.css, dark theme), by value — an
   edge function cannot read the stylesheet. Kept in step by hand with
   web/og-card.html, the Playwright twin the channels upload. */
const BG = '#070708';
const CARD = '#131316';
const CARD_2 = '#1c1c20';
const RULE = '#26262c';
const RULE_2 = '#393940';
const INK = '#fafafa';
const INK_15 = '#e4e4e7';
const INK_2 = '#b4b4bc';
const INK_3 = '#92929b';
const ACCENT = '#c8ff00';
const ACCENT_INK = '#14170a';

/** satori takes plain {type, props} objects; there is no JSX step here. */
const h = (type, props = {}, ...children) => ({
  type,
  props: { ...props, children: children.length === 1 ? children[0] : children },
});

const svgUri = (svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

/** The site's mark: three rings, the sweep, the dot. */
const MARK = svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44">
<circle cx="22" cy="22" r="20" fill="none" stroke="${ACCENT}" stroke-width="1.1" opacity=".3"/>
<circle cx="22" cy="22" r="13" fill="none" stroke="${ACCENT}" stroke-width="1.1" opacity=".3"/>
<circle cx="22" cy="22" r="6" fill="none" stroke="${ACCENT}" stroke-width="1.1" opacity=".3"/>
<path d="M22 22 L22 1 A21 21 0 0 1 40 12 Z" fill="${ACCENT}" opacity=".3"/>
<circle cx="22" cy="22" r="2.8" fill="${ACCENT}"/></svg>`);

/**
 * Satori cannot fit text to a box, so the size is chosen from the length.
 *
 * The HTML card measures and shrinks in a loop; there is no layout pass to read
 * here. Steps picked against the real spread of titles — median 34 characters,
 * one real posting at 172 — for a 792px column holding three lines at most.
 */
export function roleSize(len) {
  if (len <= 26) return 70;
  if (len <= 44) return 60;
  if (len <= 80) return 52;
  if (len <= 110) return 44;
  return 36;
}

/** Trim at a word boundary; a title is not allowed to become the whole card. */
export function clampTitle(raw, max = 128) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, '');
}

/** Pay is the one fact the site colours (--cash is the accent). */
const PAY = /[₹$€£]|\/\s*(month|year|week|hour)/i;

const pill = (text) => h('div', {
  style: {
    display: 'flex', alignItems: 'center', height: 52, padding: '0 22px', borderRadius: 999,
    backgroundColor: CARD_2, border: `1px solid ${RULE_2}`, color: PAY.test(text) ? ACCENT : INK_15,
    fontFamily: 'Geist', fontWeight: 500, fontSize: 23, letterSpacing: '-0.01em',
  },
}, text);

/** Initials when there is no logo, never an empty box (the site's crest). */
const initials = (company) => String(company ?? '').replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/)
  .filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/**
 * The card, as a satori element tree: the board's role card, scaled. Pure, so
 * it can be rendered and LOOKED at without deploying.
 */
export function buildCard({ company, title, facts = [], logo = '' }) {
  const role = clampTitle(title);
  return h('div', {
    style: {
      width: 1200, height: 630, display: 'flex', flexDirection: 'column',
      backgroundColor: BG, color: INK, padding: '44px 52px 48px', fontFamily: 'Geist',
    },
  },
    // masthead — the site's header
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 30 } },
      h('div', { style: { display: 'flex', alignItems: 'center' } },
        h('img', { src: MARK, width: 40, height: 40, style: { marginRight: 14 } }),
        h('div', { style: { display: 'flex', fontWeight: 600, fontSize: 31, letterSpacing: '-0.03em', color: INK } }, 'InternDoor'),
      ),
      h('div', { style: { display: 'flex', alignItems: 'center' } },
        h('div', { style: { display: 'flex', width: 10, height: 10, borderRadius: 999, backgroundColor: ACCENT, marginRight: 12 } }),
        h('div', { style: { display: 'flex', fontWeight: 500, fontSize: 23, color: INK_2 } }, 'Hiring now'),
      ),
    ),

    // the role card
    h('div', {
      style: {
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between', flexGrow: 1,
        backgroundColor: CARD, border: `1px solid ${RULE}`, borderRadius: 28, padding: '40px 42px',
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'flex-start' } },
        /* CONTAIN ON A WHITE PLATE, NEVER COVER — cropping somebody's trademark
           is the one treatment that is simply wrong. */
        logo
          ? h('div', { style: { display: 'flex', width: 184, height: 184, borderRadius: 26, backgroundColor: '#fff', marginRight: 36 } },
              h('img', { src: logo, width: 184, height: 184, style: { objectFit: 'contain', padding: 18, borderRadius: 26 } }))
          : h('div', { style: {
              display: 'flex', alignItems: 'center', justifyContent: 'center', width: 184, height: 184, borderRadius: 26,
              backgroundColor: CARD_2, border: `1px solid ${RULE_2}`, marginRight: 36,
              fontWeight: 600, fontSize: 64, letterSpacing: '-0.03em', color: INK_2,
            } }, initials(company)),
        h('div', { style: { display: 'flex', flexDirection: 'column', width: 792 } },
          h('div', { style: { display: 'flex', fontWeight: 500, fontSize: 31, letterSpacing: '-0.015em', color: INK_15, marginBottom: 12 } }, company),
          h('div', { style: {
            display: 'flex', fontWeight: 600, fontSize: roleSize(role.length),
            lineHeight: 1.07, letterSpacing: '-0.035em', color: INK,
          } }, role),
        ),
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          ...facts.slice(0, 3).map((f) => pill(f)),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center' } },
          h('div', { style: { display: 'flex', fontSize: 21, color: INK_3, marginRight: 20, letterSpacing: '0.01em' } }, 'interndoor.com'),
          h('div', { style: {
            display: 'flex', alignItems: 'center', height: 60, padding: '0 30px', borderRadius: 999,
            backgroundColor: ACCENT, color: ACCENT_INK, fontWeight: 600, fontSize: 25, letterSpacing: '-0.015em',
          } }, 'View & apply →'),
        ),
      ),
    ),
  );
}

/**
 * A region's board lives under its own slug and India's is at the root.
 *
 * The map is a copy of regionPath() from src/regions.js, which an edge
 * function cannot import. It changes only when a region is added — Canada,
 * 24 Sep 2026 — and test/og.test.mjs asserts the two agree so that day is not
 * silent.
 */
export const REGION_PREFIX = { IN: '', US: '/us', GB: '/uk', CA: '/ca' };

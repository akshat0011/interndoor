/* InternDoor Blog: the few things the pages do once they have loaded.

   Every page reads completely without this file. It adds the theme switch,
   arrivals for what starts below the fold, the contents highlight, the share
   button, the email form's in-page answer and the search filter. */

(() => {
  const root = document.documentElement;
  const reduce = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  /* True when the stylesheet carrying the motion rules is the one loaded and
     the reader has not asked for less motion. */
  const motionOk = () => !reduce() && getComputedStyle(root).getPropertyValue('--fx').trim() === '1';

  /* ------------------------------------------------------------- theme */

  /* Dark unless the reader chose light, exactly as on the board. Inside a view
     transition the new theme grows as a circle from the switch. */
  function switchTheme(origin) {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    const apply = () => {
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch { /* private mode */ }
    };
    if (!origin || typeof document.startViewTransition !== 'function' || !motionOk()) { apply(); return; }
    const run = (switchTheme.run = (switchTheme.run || 0) + 1);
    root.setAttribute('data-theme-switching', '');
    const vt = document.startViewTransition(apply);
    vt.ready.then(() => {
      const { x, y } = origin;
      const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 650, easing: 'cubic-bezier(.65,0,.35,1)', pseudoElement: '::view-transition-new(root)' },
      );
    }, () => {});
    const done = () => { if (run === switchTheme.run) root.removeAttribute('data-theme-switching'); };
    vt.finished.then(done, done);
  }
  const themeBtn = document.getElementById('theme-toggle');
  themeBtn?.addEventListener('click', () => {
    const b = (themeBtn.querySelector('svg') || themeBtn).getBoundingClientRect();
    switchTheme({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
  });

  /* ------------------------------------------------------------ menu */

  document.addEventListener('click', (e) => {
    const open = document.querySelector('details.menu[open]');
    if (open && !open.contains(e.target)) open.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('details.menu[open]');
    if (open) { open.open = false; open.querySelector('summary')?.focus(); }
  });

  /* --------------------------------------------------------- arrivals */

  const canObserve = typeof IntersectionObserver === 'function';
  const fold = () => innerHeight;

  /* A block that starts below the fold waits invisible and arrives once, out
     of a blur, when reached. What is on screen at load is never touched. */
  if (canObserve && motionOk()) {
    const io = new IntersectionObserver((entries) => {
      let k = 0;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const node = e.target;
        io.unobserve(node);
        node.style.animationDelay = `${Math.min(k++, 5) * 60}ms`;
        node.addEventListener('animationend', function settle(ev) {
          if (ev.target !== node) return;
          node.removeEventListener('animationend', settle);
          node.classList.remove('fx-in');
          node.style.animationDelay = '';
        });
        node.classList.remove('fx-wait');
        node.classList.add('fx-in');
      }
    }, { rootMargin: '0px 0px -8% 0px' });
    const nodes = document.querySelectorAll('.block, main > .sub, .related, .pager, .sources, .further, .rows-wide > .row, .findings-list > li');
    for (const node of nodes) {
      if (node.getBoundingClientRect().top < fold()) continue;
      node.classList.add('fx-wait');
      io.observe(node);
    }
  }

  /* Charts below the fold draw their bars when reached; one already on screen
     is left as the server drew it. */
  if (canObserve && motionOk()) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        e.target.classList.add('is-drawn');
        e.target.classList.remove('is-armed');
      }
    }, { rootMargin: '0px 0px -15% 0px' });
    for (const chart of document.querySelectorAll('[data-chart]')) {
      if (chart.getBoundingClientRect().top < fold() * 0.85) continue;
      chart.classList.add('is-armed');
      io.observe(chart);
    }
  }

  /* ---------------------------------------------------------- contents */

  /* The heading being read is the last one whose top has passed 30% of the
     window. Worked out when a heading crosses that line, never on scroll. */
  const toc = document.querySelector('.toc nav');
  const prose = document.querySelector('.prose');
  if (toc && prose && canObserve) {
    const links = new Map([...toc.querySelectorAll('a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]));
    const heads = [...prose.querySelectorAll('h2[id], h3[id]')].filter((h) => links.has(h.id));
    const ind = document.createElement('span');
    ind.className = 'toc-ind';
    ind.setAttribute('aria-hidden', 'true');
    toc.append(ind);
    let current = null;
    const mark = () => {
      const line = innerHeight * 0.3;
      let active = null;
      for (const h of heads) { if (h.getBoundingClientRect().top - line <= 0) active = h; else break; }
      const a = active ? links.get(active.id) : null;
      if (a === current) return;
      current?.removeAttribute('aria-current');
      current = a;
      if (!a) { ind.style.opacity = '0'; return; }
      a.setAttribute('aria-current', 'true');
      ind.style.opacity = '1';
      ind.style.height = `${a.offsetHeight}px`;
      ind.style.transform = `translateY(${a.offsetTop}px)`;
    };
    const io = new IntersectionObserver(mark, { rootMargin: '0px 0px -70% 0px' });
    for (const h of heads) io.observe(h);
    mark();
  }
  for (const d of document.querySelectorAll('details.toc-m')) {
    d.addEventListener('click', (e) => { if (e.target.closest('a')) d.open = false; });
  }

  /* ------------------------------------------------------------- share */

  for (const btn of document.querySelectorAll('button[data-share]')) {
    const label = btn.querySelector('span');
    const native = typeof navigator.share === 'function' && window.matchMedia?.('(pointer: coarse)').matches;
    if (native && label) label.textContent = 'Share';
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      const url = btn.dataset.share;
      if (native) {
        try { await navigator.share({ title: btn.dataset.title, url }); } catch { /* dismissed */ }
        return;
      }
      try {
        await navigator.clipboard.writeText(url);
        if (label) label.textContent = 'Link copied';
        btn.classList.add('is-done');
        setTimeout(() => { if (label) label.textContent = 'Copy link'; btn.classList.remove('is-done'); }, 2200);
      } catch {
        if (label) label.textContent = 'Copy failed';
      }
    });
  }

  /* -------------------------------------------------------- email form */

  /* The form works without this: it posts to the endpoint and the reader sees
     its plain answer. Here the answer stays on the page. Only a 200 with
     ok:true is a subscription; anything else shows the endpoint's own words,
     and a second press while one is in flight does nothing. */
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  for (const form of document.querySelectorAll('form[data-sub]')) {
    const input = form.querySelector('input[type="email"]');
    const msg = form.querySelector('.sub-msg');
    const btn = form.querySelector('button[type="submit"]');
    const say = (text, kind) => {
      msg.textContent = text;
      msg.classList.remove('is-ok', 'is-err');
      if (kind) { void msg.offsetWidth; msg.classList.add(kind); }
    };
    form.noValidate = true;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (form.dataset.state === 'busy') return;
      const email = input.value.trim();
      if (!EMAIL.test(email)) {
        input.setAttribute('aria-invalid', 'true');
        say('That does not look like an email address.', 'is-err');
        input.focus();
        return;
      }
      input.removeAttribute('aria-invalid');
      form.dataset.state = 'busy';
      btn.disabled = true;
      say('Adding you…');
      try {
        const res = await fetch(form.dataset.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, region: form.elements.region.value, company: form.elements.company.value }),
        });
        let body = {};
        try { body = await res.json(); } catch { /* not JSON */ }
        if (res.ok && body.ok === true) {
          say('You are on the list. Expect at most one email a day, and only on days with new roles.', 'is-ok');
          input.value = '';
          form.dataset.state = 'done';
          return;
        }
        say(body.error || 'Could not add you just now. Please try again in a minute.', 'is-err');
      } catch {
        say('Could not reach InternDoor. Check your connection and try again.', 'is-err');
      } finally {
        if (form.dataset.state === 'busy') form.dataset.state = '';
        btn.disabled = false;
      }
    });
  }

  /* ------------------------------------------------------------ search */

  const q = document.getElementById('q');
  const results = document.getElementById('results');
  if (q && results) {
    const rows = [...results.querySelectorAll('li[data-text]')];
    const count = document.getElementById('search-count');
    const empty = document.getElementById('no-results');
    let timer = 0;
    const run = () => {
      const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const r of rows) {
        const hit = words.every((w) => r.dataset.text.includes(w));
        r.hidden = !hit;
        if (hit) shown++;
      }
      count.textContent = words.length
        ? `${shown} of ${rows.length} posts match`
        : `${rows.length} posts`;
      empty.hidden = shown > 0;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const u = new URL(location.href);
        if (words.length) u.searchParams.set('q', q.value.trim()); else u.searchParams.delete('q');
        history.replaceState(null, '', u);
      }, 300);
    };
    q.value = new URL(location.href).searchParams.get('q') ?? '';
    q.addEventListener('input', run);
    q.form?.addEventListener('submit', (e) => { e.preventDefault(); run(); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape' && q.value) { q.value = ''; run(); } });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== q && !e.metaKey && !e.ctrlKey) { e.preventDefault(); q.focus(); }
    });
    run();
    if (!q.value) q.focus({ preventScroll: true });
  }
})();

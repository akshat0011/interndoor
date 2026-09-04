/**
 * The daily digest: what it may send, when, and to whom.
 *
 * This is the only thing in the repo that mails a stranger, and it went in
 * while /alerts had been promising a mail that did not exist for weeks — so the
 * assertions here are about REFUSING, not about composing.
 *
 * Run under several timezones, because "today" is the whole gate: TZ=UTC,
 * America/New_York, Asia/Kolkata and Pacific/Kiritimati all reach this file.
 */
import { buildDigest, digestDue, dayKey, sendStatus, digestRoles } from '../src/digest.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const cfg = { digest: { enabled: true, hour: 9, region: 'IN', windowHours: 24 } };
const now = Date.parse('2026-09-04T05:00:00Z');          // 10:30 IST, past the hour
const row = (over = {}) => ({
  job_id: '900001', company: 'Kepler Systems', title: 'Backend Intern',
  location: 'Bengaluru, Karnataka, India', is_tech: 1, suppressed_reason: null,
  first_seen_at: now - 3_600_000, posted_at: now - 3_600_000,
  bullets: JSON.stringify(['Ship a service behind a flag.', 'Write the tests that gate it.']),
  ...over,
});

/* ---- the line that can mail somebody by accident ---- */
console.log('\n== sendStatus fails toward the outcome that can be undone ==');
check('send -> about_to_send', sendStatus('send'), 'about_to_send');
for (const m of ['draft', '', 'SEND', 'sending', 'about_to_send', 'true'])
  check(`${JSON.stringify(m)} -> draft`, sendStatus(m), 'draft');
check('null -> draft', sendStatus(null), 'draft');
check('undefined -> draft', sendStatus(undefined), 'draft');
check('a number -> draft', sendStatus(1), 'draft');

/* ---- when ---- */
console.log('\n== the once-a-day gate ==');
check('disabled means never', digestDue({ digest: { enabled: false, hour: 9 } }, null, now, 'IN'), false);
check('before the hour, not due', digestDue(cfg, null, Date.parse('2026-09-04T02:00:00Z'), 'IN'), false);
check('after the hour, due', digestDue(cfg, null, now, 'IN'), true);
check('already sent today, not due', digestDue(cfg, dayKey(now, 'Asia/Kolkata'), now, 'IN'), false);
check('sent yesterday, due again', digestDue(cfg, '2026-09-03', now, 'IN'), true);

console.log('\n== "today" is the board\'s day, not the server\'s ==');
/* 20:30 UTC is already tomorrow in Kolkata. Keyed on UTC the mail would fire
   twice on some days and not at all on others. */
const evening = Date.parse('2026-09-04T20:30:00Z');
check('IST rolls over first', dayKey(evening, 'Asia/Kolkata'), '2026-09-05');
check('UTC has not', dayKey(evening, 'UTC'), '2026-09-04');
check('New York has not', dayKey(evening, 'America/New_York'), '2026-09-04');
/* And the answer must not depend on the machine's own zone. */
check('independent of process TZ', dayKey(evening, 'Asia/Kolkata'), '2026-09-05');

/* ---- what ---- */
console.log('\n== nothing to say means no mail ==');
check('no rows at all -> null', buildDigest([], cfg, { region: 'IN', now }), null);
check('nothing new enough -> null',
  buildDigest([row({ first_seen_at: now - 5 * 86_400_000 })], cfg, { region: 'IN', now }), null);
check('non-tech does not count', buildDigest([row({ is_tech: 0 })], cfg, { region: 'IN', now }), null);
check('a suppressed row does not count',
  buildDigest([row({ suppressed_reason: 'pulled by hand' })], cfg, { region: 'IN', now }), null);

console.log('\n== only what publish actually wrote ==');
/* §12: Telegram posted rows publish had held back and 40% of a week's links
   were 404s. A null set means we do not know, and digestRoles must not filter
   on a guess — bin/digest.js refuses to send at all in that case. */
check('unpublished row is dropped',
  buildDigest([row()], cfg, { region: 'IN', now, publishedIds: new Set(['other']) }), null);
check('published row is kept',
  buildDigest([row()], cfg, { region: 'IN', now, publishedIds: new Set(['900001']) })?.count, 1);
check('a null set filters nothing (the caller decides)',
  digestRoles([row()], { sinceMs: 0, publishedIds: null }).length, 1);

console.log('\n== the mail itself ==');
const mail = buildDigest([row(), row({ job_id: '900002', title: 'Data Intern' })], cfg, { region: 'IN', now });
check('a count leads the subject', mail.subject, '2 new engineering internships in India');
check('singular reads correctly',
  buildDigest([row()], cfg, { region: 'IN', now }).subject, '1 new engineering internship in India');
check('the role is linked', /\]\(https:\/\/interndoor\.com\/jobs\/kepler-systems-backend-intern-900001\?/.test(mail.body), true);
/* utm_medium was hardcoded to `social`, which would file every click from every
   subscriber under social traffic — the same mistake as a reel tagged
   utm_source=linkedin, one field over. */
check('tagged as email, not social', /utm_source=email&utm_medium=email/.test(mail.body), true);
check('no social medium anywhere', /utm_medium=social/.test(mail.body), false);
check('bullets are carried', mail.body.includes('Ship a service behind a flag.'), true);

console.log('\n== the two fields that must never be printed ==');
/* §11: stipendStatus is INVENTED — of 47 India rows marked unpaid, zero say so
   — and postedText is frozen at scrape time, so it read "4 minutes ago" on a
   day-old posting. Neither may reach a reader. */
const dirty = buildDigest([row({ stipend_status: 'unpaid', posted_text: '4 minutes ago' })],
  cfg, { region: 'IN', now });
check('stipendStatus never appears', /unpaid/i.test(dirty.body), false);
check('postedText never appears', /4 minutes ago/.test(dirty.body), false);

console.log('\n== a long day is capped, and says so ==');
const many = Array.from({ length: 40 }, (_, i) => row({ job_id: `9${i}`, title: `Intern ${i}` }));
const big = buildDigest(many, cfg, { region: 'IN', now });
check('counts them all in the subject', big.subject, '40 new engineering internships in India');
check('lists at most 25', big.shown, 25);
check('and points at the board for the rest', big.body.includes('and 15 more'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

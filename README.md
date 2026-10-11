# InternDoor

**Be early.**

### 🔗 [interndoor.com](https://interndoor.com)

A free job board for engineering internships and entry-level jobs in India,
built for students and fresh graduates who keep finding the good postings two days late.

---

## The problem

A popular internship or fresher opening collects hundreds of applicants within a day of going
up. By the time a posting reaches you through a WhatsApp group or a weekly newsletter, you're
applicant number four hundred — and at that point your resume matters less than your timing.

Checking LinkedIn ten times a day works. Nobody actually does it.

## What InternDoor does

It checks for you, every 30 minutes, and puts what it finds on one page — newest first, with the
details you actually decide on already pulled out of the posting.

No account. No signup. No email. Open it and read it.

## What's on the site

**Internships and entry-level jobs, kept apart.** Every board has two tabs: internships, and
full-time roles open to freshers and new graduates — *Associate Software Engineer*, *SDE-1*,
*Software Engineer I*, *New Grad*, *Graduate Engineer*. A fresher role is never filed as an
internship, and a role asking for two or more years of experience is never filed as either.

**Fresh listings, clearly labelled.** Every card shows how old the posting is. Under an hour is
marked *just posted*; under a day is *new*. That label is the whole point — it tells you whether
applying is still worth it.

**Engineering roles only.** Around 1,900 companies are watched, from global tech and semiconductors
through Indian fintech, SaaS, banking and deeptech — and everything non-technical is filtered out
before it reaches the site. No sales, no telecalling, no content roles to scroll past.

**The facts up front, not buried in a wall of text.** Each listing shows the stipend or pay, how
long an internship runs, the location and whether it's remote, hybrid or on-site, which degree
it's open to, and the key skills asked for — read out of the description, so you don't have to
open five tabs to compare two roles.

**Filter it down.** Narrow by company, location or workplace type. Show only paid roles, or only
Easy Apply ones. Sort by newest, by stipend, or by company.

**Apply at the source.** Every listing links straight to the original posting. InternDoor finds
and summarises — you apply on the real thing.

**A page per listing.** Every internship and entry-level role has its own shareable page, so you
can send someone one job instead of "go look at the site".

**A feed, so you don't have to remember to check.** New roles are published to
[RSS](https://interndoor.com/feed.xml) and
[JSON Feed](https://interndoor.com/feed.json) — point a reader at it and being early stops
depending on your habits.

Works on a phone, has a dark mode, and remembers which one you picked.

## Tailor your resume to a listing

Pick any listing, upload your resume as a PDF, and get a version rewritten for that role, with
the role's own keywords where your work supports them. Then edit any line, compare it with your
original, and download it as a PDF or copy the text. It also works from the card: every listing
has a Tailor button beside Apply.

Three rules it won't break:

- **It never removes anything you wrote.** It may reorder, reword and regroup, but every job,
  project, bullet and skill in your resume is still there afterwards. That is checked in code,
  not left to the model: anything a rewrite drops is put back.
- **Everything it adds is shown to you.** Skills or lines added to fit the role are highlighted in
  the resume and listed beside it, each with one click to remove. It never invents an employer,
  a title, a date, a degree or a number.
- **It never stores your resume.** Your PDF is read inside your own browser and only its text is
  sent, for that one request. Nothing is written down and nothing is logged.

Beside the resume, a count shows how many of the role's keywords it now carries against your
original. Free, with no key and no sign-up: 5 AI uses a day, shared between tailoring and reading
the board with AI. Ranking the board by your skills is unlimited and runs on your own device.

## Right now

| | India |
|---|---|
| Live engineering internships | ~260 |
| Live entry-level jobs | ~690 |
| Companies hiring right now | ~330 |
| Refreshed | every 30 minutes |
| Listings expire after | 30 days |

Counts are from 30 September 2026 and move every half hour. InternDoor listed the US, the UK and
Canada too until 30 September 2026; it is India only now. Postings drop off after 30 days, or
sooner when the employer's own page says the role has closed. A posting older than that is usually
closed or already has hundreds of applicants, and showing it would work against the one thing this
site is for.

## Built with

Node.js, SQLite and Playwright, a local model (Qwen via Ollama) for the summaries, and a serverless
function for the resume tool, on a static site hosted by Vercel with a single production
dependency.

## A note on the data

Every listing links back to the original job posting. InternDoor shows only its own short summary of
a role and deliberately does not republish the employer's job description, which is their
copyrighted text.

## Licence

MIT — see [LICENSE](LICENSE).

Built by [Akshat Saroha](https://github.com/akshat0011).

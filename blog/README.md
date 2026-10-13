# InternDoor Blog

The editorial side of InternDoor, served at `https://blog.interndoor.com` by its
own Vercel project (root directory `blog`). Static HTML, built on this Mac,
committed, and served as files. No framework, no client-side rendering, and no
dependency the main repo does not already have.

```
blog/
  build.mjs            builds content/ into public/, draws share images, verifies the output
  serve.mjs            local preview on :4340 with the production headers and CSP
  vercel.json          written by build.mjs; do not hand-edit
  og-manifest.json     which share images are current (bookkeeping, not published)
  content/posts/*.md   posts (Markdown subset + front matter)
  content/pages/*.md   About, How we count, Privacy
  content/data/*.json  every figure a chart shows, written by scripts/export-data.mjs
  content/months.json  the monthly figures on the homepage
  scripts/export-data.mjs  reads the store and the frozen monthly reports
  lib/                 markdown, content rules, charts, templates, SEO files, verifier
  src/blog.css, src/blog.js
  static/              favicons
  public/              the built site (committed)
```

## Writing a post

Copy an existing file in `content/posts/` and change it. The build refuses a
post that breaks a rule, and says which rule:

- `title`, `slug`, `description` (70 to 165 characters, the search snippet),
  `dek` (the standfirst), `category` (`reports` or `guides`), `published`
  (YYYY-MM-DD). Optional: `seoTitle` (62 characters at most), `updated`,
  `tags`, `figure` + `figureLabel`, `lead` (a chart for the homepage),
  `related`, `further` (links to interndoor.com), `sources`, `draft`,
  `noindex`, `featured`, `toc`.
- `draft: true` or a `published` date in the future keeps a post off the site.
- No em or en dashes anywhere: use a colon, a comma, a full stop, or a hyphen
  for a range.
- Every figure says how many postings are behind it. Facts not counted by
  InternDoor are cited: `[^source-id]` in the text, with the source in
  `sources:` front matter. Advice is labelled as advice.
- Do not name where listings are collected from.

The Markdown subset: `##` and `###` headings, paragraphs, `-` and `1.` lists
(one level), `>` quotes, pipe tables (`Table: caption` on the line before),
fenced code, `---`, `**bold**`, `*italic*`, `` `code` ``, `[text](link)`, and
three blocks:

```
::: chart sep2026.cities        one line: a chart from content/data/sep2026.json

::: findings                    a numbered list of key findings; start each with **the number**
1. **425** engineering internships ...
:::

::: method                      the "How this was counted" section
...
:::
```

## Building

```bash
node --no-warnings blog/scripts/export-data.mjs   # only when the figures should change
node blog/build.mjs --check-links                  # build, draw changed share images, check links into interndoor.com
node blog/serve.mjs                                # http://localhost:4340
node test/blog.test.mjs
```

The build fails on any verifier error: more or fewer than one `<h1>`, a
canonical that is not the page's own URL, a broken internal link or fragment,
an inline style or an unexpected inline script (the CSP would block it), an
em dash, or a sitemap that lists a page it should not or misses one it should.

## Deploying (first time)

1. **Vercel**: in the `study-usict` team, add a project from the GitHub repo
   `akshat0011/interndoor`, set **Root Directory** to `blog`, framework
   **Other**, and leave the build command empty. `vercel.json` sets the output
   directory, the headers and an ignore step that skips the build when nothing
   under `blog/` changed (the scheduler pushes every 30 minutes).
2. **Domain**: add `blog.interndoor.com` to that project.
3. **DNS** at BigRock: a `CNAME` record for `blog` pointing at the target Vercel
   shows (normally `cname.vercel-dns.com`). The certificate is issued
   automatically once the record resolves.
4. **Web Analytics**: enable it on the new project, or `/_vercel/insights` 404s.
5. **Search Console**: `sc-domain:interndoor.com` is a Domain property, so it
   already covers the subdomain. Submit `https://blog.interndoor.com/sitemap.xml`
   under Sitemaps, and inspect the five post URLs. In Bing Webmaster Tools,
   submit the same sitemap.
6. **Link it from the main site** (footer and `/about`) once it answers 200.

## Measuring it

In Search Console's Performance report, filter **Page** by
`https://blog.interndoor.com/` for the blog, and by URLs not containing it for
the board, over the same dates. Compare clicks, impressions and average
position, and check indexing with URL Inspection on each post. The same split
is available from the API with `dimensions: ["page"]` and `dataState: "all"`.
Expect weeks, not days, before a new host is crawled.

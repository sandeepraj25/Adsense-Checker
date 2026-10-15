// Local test websites for the analysis engine, served over plain HTTP on
// one port. scripts/analysis-test.mjs points made-up *-fixture.com names
// at this server, so the real engine, fetcher and address screening run
// unchanged — no internet, no root, no /etc/hosts edits.
//
//   goodblog-fixture.com  policy pages, real-looking posts, robots, sitemap, ads.txt
//   badblog-fixture.com   a planted problem for every existing check
//   slowblog-fixture.com  inner pages never answer (time-limit tests)
//   softblog-fixture.com  answers every path with an HTML 200 page (soft 404)
//   redirect-fixture.com  /to-private redirects to a private address; /to-ok to a real page;
//                         /slow?ms=N answers after N ms and counts requests in flight
//   robotsblog-fixture.com robots.txt closes /private/ to every crawler
import { createServer } from "node:http";

export const requests = [];

/* ── content ───────────────────────────────────────────────────── */

const POSTS = {
  "dal-tadka": ["How I make dal tadka on a weeknight", "dal", "lentils, cumin, ghee and a hot pan"],
  "sourdough-starter": ["Keeping a sourdough starter alive in Mumbai heat", "sourdough", "flour, water, and patience"],
  "kerala-fish-curry": ["My grandmother's Kerala fish curry", "curry", "kokum, coconut and curry leaves"],
  "pressure-cooker-rice": ["Getting pressure cooker rice right every time", "rice", "rinsing, ratios and resting"],
  "masala-chai": ["The masala chai I drink every morning", "chai", "ginger, cardamom and strong tea"],
};

const OPENERS = [
  "I learned this the hard way, after burning more batches than I care to admit.",
  "My mother never measured anything, so I spent a winter writing down what she actually did.",
  "Last Sunday my neighbour asked for the recipe, and I realised I had never written it down properly.",
  "When we moved to a flat with a tiny two-burner stove, I had to rethink the whole method.",
  "Readers keep emailing me about this one, so here is the long version with every mistake I made.",
];
const MIDDLES = [
  "The %s matters more than people think; buy it from a shop that sells a lot of it, because stale stock tastes flat.",
  "Heat the pan until a drop of water skitters, then lower the flame, otherwise the %s scorches before it softens.",
  "If you are short on time you can skip the soaking, but expect a firmer texture and add ten minutes on the stove.",
  "I tested this four times with a kitchen scale, and the ratio below is the one my family ate without complaint.",
  "Taste as you go. Salt at the end is a rescue, salt at the start is a decision, and they are not the same thing.",
  "My first attempt was watery; the fix was simply to let it bubble uncovered for longer than felt comfortable.",
  "A heavy-bottomed vessel spreads the heat; in a thin steel pot the bottom catches while the top is still raw.",
  "Leftovers keep for two days in the fridge, and honestly the flavour is better on the second day.",
  "Some readers use a non-stick pan; that works, but you lose the browned bits that give the dish its depth.",
  "Do not walk away during the tempering step; it takes about forty seconds and goes from fragrant to bitter quickly.",
  "If your stove runs hot, pull the pan off the flame for a moment rather than adding more oil.",
  "Children in our building like it milder, so I keep a separate bowl aside before the chilli goes in.",
];
const CLOSERS = [
  "If you try it, tell me how it went in the comments — especially if you changed something and it worked better.",
  "That is the whole method. It is not fancy, but it is the version we actually cook on a Tuesday.",
  "Next week I will write about what to serve alongside it, since several of you asked.",
];

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function article(slug, words = 900) {
  const [title, key, about] = POSTS[slug];
  const r = rng(slug.length * 7919 + slug.charCodeAt(0));
  const pick = (list) => list[Math.floor(r() * list.length)];
  const paras = [`<p>${pick(OPENERS)} This post is about ${about}.</p>`];
  let count = 40;
  let i = 0;
  while (count < words) {
    const sentences = [];
    const n = 2 + Math.floor(r() * 4);
    for (let k = 0; k < n; k += 1) sentences.push(pick(MIDDLES).replace("%s", key));
    const text = sentences.join(" ");
    count += text.split(/\s+/).length;
    paras.push(i % 3 === 2 ? `<h2>Step ${Math.ceil(i / 3)}: what to watch for</h2><p>${text}</p>` : `<p>${text}</p>`);
    i += 1;
  }
  paras.push(`<p>${pick(CLOSERS)}</p>`);
  return { title, body: paras.join("\n") };
}

const GOOD_NAV = `<nav><a href="/">Home</a> <a href="/blog/">Recipes</a> <a href="/about/">About</a> <a href="/contact/">Contact</a></nav>`;
const GOOD_FOOTER = `<footer><a href="/privacy-policy/">Privacy Policy</a> · <a href="/terms/">Terms of Use</a> · <a href="/about/">About</a> · © 2026 Goodblog</footer>`;

function goodPage(title, main, { desc = `${title} — home cooking notes from Priya Nair.`, extraHead = "" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | Goodblog Kitchen</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="http://goodblog-fixture.com:8080/">
<meta property="og:title" content="${title}"><meta property="og:description" content="${desc}"><meta property="og:image" content="http://goodblog-fixture.com:8080/img/cover.jpg">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1234567890123456" crossorigin="anonymous"></script>
${extraHead}</head><body><header><a href="/">Goodblog Kitchen</a>${GOOD_NAV}</header>
<main>${main}</main>${GOOD_FOOTER}</body></html>`;
}

function goodPost(slug) {
  const { title, body } = article(slug);
  return goodPage(
    title,
    `<article><h1>${title}</h1><p class="byline">By <a href="/about/">Priya Nair</a> · <time datetime="2026-09-${10 + slug.length}">September ${10 + slug.length}, 2026</time></p>
<img src="/img/${slug}.jpg" alt="${title}" width="800" height="533">${body}</article>`,
  );
}

const PRIVACY_GOOD = `<h1>Privacy Policy</h1><p>This privacy policy explains what Goodblog Kitchen collects when you visit. We use cookies to remember your preferences and to understand which recipes people read.</p>
<h2>Advertising</h2><p>Third party vendors, including Google, use cookies to serve ads based on a user's prior visits to this website or other websites. Google's use of advertising cookies enables it and its partners to serve ads to you based on your visit to this site and/or other sites on the Internet. You may opt out of personalised advertising by visiting Ads Settings.</p>
<h2>Contact</h2><p>Questions about this policy can be sent to privacy@goodblog-fixture.com. We reply within a week.</p>
<p>${"We keep server logs for thirty days to diagnose errors, and we never sell personal information to anyone. ".repeat(6)}</p>`;

const GOOD = {
  "/": () => {
    const cards = Object.keys(POSTS)
      .map((slug) => `<li><a href="/blog/${slug}/">${POSTS[slug][0]}</a></li>`)
      .join("");
    return goodPage(
      "Home cooking that works on a weeknight",
      `<h1>Home cooking that works on a weeknight</h1><p>I am Priya, and I have cooked for a family of five in a small Mumbai kitchen for twelve years. Every recipe here was tested at least three times before it went up.</p>
<h2>Latest recipes</h2><ul>${cards}</ul>${article("dal-tadka", 500).body}`,
    );
  },
  "/about/": () => goodPage("About Priya", `<h1>About Priya</h1><p>I started this blog in 2019 after my children left for college and kept calling to ask how I made things. I am not a trained chef; I am a home cook who writes things down carefully.</p><p>${"Every recipe is cooked in my own kitchen, photographed on my phone, and written in the order I actually do things. ".repeat(8)}</p>`),
  "/contact/": () => goodPage("Contact", `<h1>Contact</h1><p>Write to me at <a href="mailto:hello@goodblog-fixture.com">hello@goodblog-fixture.com</a> or use the form below. I read everything.</p><form action="/contact/send" method="post"><input name="name"><textarea name="message"></textarea><button>Send</button></form><p>${"I usually answer within two or three days, a little longer during festival season. ".repeat(5)}</p>`),
  "/privacy-policy/": () => goodPage("Privacy Policy", PRIVACY_GOOD),
  "/terms/": () => goodPage("Terms of Use", `<h1>Terms of Use</h1><p>${"You may print recipes for your own use. Please do not republish the text or photographs without asking first. ".repeat(10)}</p>`),
  "/blog/": () => goodPage("Recipes", `<h1>Recipes</h1><ul>${Object.keys(POSTS).map((s) => `<li><a href="/blog/${s}/">${POSTS[s][0]}</a></li>`).join("")}</ul><p>${"New recipes go up every Sunday morning. ".repeat(10)}</p>`),
  ...Object.fromEntries(Object.keys(POSTS).map((slug) => [`/blog/${slug}/`, () => goodPost(slug)])),
  "/robots.txt": () => "User-agent: *\nAllow: /\n\nSitemap: http://goodblog-fixture.com:8080/sitemap.xml\n",
  "/sitemap.xml": () =>
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/about/", "/contact/", "/privacy-policy/", "/terms/", "/blog/", ...Object.keys(POSTS).map((s) => `/blog/${s}/`)].map((p) => `<url><loc>http://goodblog-fixture.com:8080${p}</loc><lastmod>2026-09-20</lastmod></url>`).join("")}</urlset>`,
  "/ads.txt": () => "google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n",
};

/* ── the bad site ──────────────────────────────────────────────── */

const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";
const ADS = Array.from({ length: 8 }, (_, i) => `<ins class="adsbygoogle" data-ad-client="ca-pub-9999999999999999" data-ad-slot="${i}"></ins><iframe src="https://ads.example-network.net/slot${i}" width="300" height="250"></iframe>`).join("");
const THIN = "In today's fast-paced world, it is important to note that this topic plays a crucial role. Furthermore, in conclusion, it is worth mentioning that there are many benefits. Moreover, one must delve into the various aspects to unlock the full potential.";

function badPage(title, main, { head = "" } = {}) {
  return `<!doctype html><html><head><title>${title}</title>${head}
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9999999999999999"></script>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8888888888888888"></script>
</head><body><div style="width:1200px">
<a href="/">My Blog</a> <a href="/blog/post-1/">Post 1</a> <a href="/missing-page/">Services</a> <a href="/old-link/">Archive</a> <a href="/privacy/">Privacy</a>
${main}${ADS}</div></body></html>`;
}

const BAD = {
  "/": () => badPage("Home", `<h1>Hello world!</h1><h1>Welcome</h1><p>Just another WordPress site. ${LOREM}</p><p>Coming soon: more posts. Play at the best online casino today!</p><img src="/a.jpg"><img src="/b.jpg">
<p>Please click on the ads to support us.</p><div style="display:none"><a href="https://casino.example.com">casino</a> <a href="https://pills.example.net">pills</a> <a href="https://loans.example.org">loans</a></div><script src="https://c1.popads.net/pop.js"></script>
<a href="/blog/post-1/">Read</a> <a href="/blog/post-2/">Read</a> <a href="/blog/post-3/">Read</a>`),
  "/blog/post-1/": () => badPage("Post", `<h1>Post</h1><p>${THIN}</p><p>${LOREM}</p>`),
  "/blog/post-2/": () => badPage("Post", `<h1>Post</h1><p>${THIN}</p><p>${LOREM}</p>`),
  "/blog/post-3/": () => badPage("Post three", `<h1>Post three</h1><p>${THIN}</p>`, { head: '<meta name="robots" content="noindex">' }),
  "/privacy/": () => badPage("Privacy", `<h1>Privacy</h1><p>We respect your privacy.</p>`),
  "/robots.txt": () => "User-agent: Mediapartners-Google\nDisallow: /\n\nUser-agent: *\nDisallow: /wp-admin/\n",
  "/ads.txt": () => "this is not a valid ads file\n",
};

/* ── the slow site ─────────────────────────────────────────────── */

const SLOW = {
  "/": () => goodPage("Slow site", `<h1>Slow site</h1><p>${"A perfectly ordinary homepage with links to pages that never finish loading. ".repeat(20)}</p><a href="/hang-1/">One</a> <a href="/hang-2/">Two</a> <a href="/hang-3/">Three</a> <a href="/hang-4/">Four</a> <a href="/about/">About</a>`),
  hang: true,
};

/* ── the soft-404 site ─────────────────────────────────────────── */

const SOFT = goodPage("Soft blog", `<h1>Soft blog</h1><p>${"Every address on this site answers with this same page and a 200 status. ".repeat(20)}</p>`);

/* ── serving ───────────────────────────────────────────────────── */

const ROBOTS_HOME = goodPage(
  "Robots blog",
  `<h1>Robots blog</h1><p>${"A site that keeps part of itself out of crawlers' reach. ".repeat(20)}</p>
<a href="/open/one/">Open one</a> <a href="/private/two/">Private two</a> <a href="/open/three/">Open three</a> <a href="/private/four/">Private four</a>`,
);

export async function startSites(port) {
  let secretHits = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^www\./, "");
    const url = new URL(req.url, "http://x");
    requests.push({ host, path: url.pathname, method: req.method, ua: req.headers["user-agent"] ?? "", at: Date.now() });

    if (host === "127.0.0.1" && url.pathname === "/secret") {
      secretHits += 1; // reaching this means a redirect to a private address was followed
      res.writeHead(200);
      return res.end("internal");
    }
    if (host === "robotsblog-fixture.com") {
      if (url.pathname === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("User-agent: *\nDisallow: /private/\n");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(url.pathname === "/" ? ROBOTS_HOME : goodPage("Inner", `<h1>Inner</h1><p>${"Inner page text. ".repeat(40)}</p>`));
    }
    if (host === "redirect-fixture.com") {
      if (url.pathname === "/slow") {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const ms = Math.min(5000, Number(url.searchParams.get("ms") ?? 200));
        setTimeout(() => {
          inFlight -= 1;
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("slow");
        }, ms);
        return;
      }
      if (url.pathname === "/to-private") {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
        return res.end();
      }
      if (url.pathname === "/to-ok") {
        res.writeHead(301, { location: "/landing" });
        return res.end();
      }
      if (url.pathname === "/loop") {
        res.writeHead(302, { location: "/loop" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<h1>ok</h1>");
    }
    if (host === "softblog-fixture.com") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(SOFT);
    }
    const site = host === "goodblog-fixture.com" ? GOOD : host === "badblog-fixture.com" ? BAD : host === "slowblog-fixture.com" ? SLOW : null;
    if (!site) {
      res.writeHead(404);
      return res.end();
    }
    if (site === SLOW && url.pathname !== "/" && url.pathname !== "/robots.txt") return; // never answers
    const page = site[url.pathname];
    if (!page) {
      res.writeHead(404, { "content-type": "text/html" });
      // The clean site has a helpful not-found page; the others the bare default.
      return res.end(site === GOOD ? goodPage("Page not found", "<h1>Page not found</h1><p>Sorry, that page has moved or never existed. Use the menu above or go back to the homepage.</p>") : "<h1>Not found</h1>");
    }
    const type = url.pathname.endsWith(".txt") ? "text/plain" : url.pathname.endsWith(".xml") ? "application/xml" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": type });
    const body = page();
    // Each clean page names itself as canonical.
    res.end(site === GOOD ? body.replace('<link rel="canonical" href="http://goodblog-fixture.com:8080/">', `<link rel="canonical" href="http://goodblog-fixture.com:8080${url.pathname}">`) : body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    secretHits: () => secretHits,
    maxInFlight: () => maxInFlight,
    resetInFlight: () => {
      maxInFlight = 0;
    },
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

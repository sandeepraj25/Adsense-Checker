/**
 * Written content for the homepage: the guides in the Articles section
 * and the questions in the FAQ. Kept apart from the layout so the copy can
 * be edited without touching markup. Nothing here is a price, a plan or a
 * number — those are read from the plan catalogue and the check registry.
 */

export type Article = {
  /** Anchor id, so other pages can link straight to a guide (/#guide-ads-txt). */
  id: string;
  title: string;
  summary: string;
  readingMinutes: number;
  sections: { heading?: string; body: string[] }[];
};

export const ARTICLES: Article[] = [
  {
    id: "guide-rejections",
    title: "Why AdSense applications get rejected",
    summary: "The usual reasons behind a “site isn't ready” email, and the order to fix them in.",
    readingMinutes: 3,
    sections: [
      {
        body: [
          "Google rarely says exactly what was wrong. The rejection email usually points to a broad category — low-value content, a site that isn't ready, a policy problem, or a site that couldn't be reached — and leaves you to work out the rest.",
        ],
      },
      {
        heading: "The common causes",
        body: [
          "Not enough useful, original content: a handful of short posts, pages copied from elsewhere, or text produced in bulk with little added value.",
          "A site that looks unfinished: empty categories, “coming soon” pages, broken links or navigation that doesn't lead anywhere.",
          "Missing information about who runs the site: no privacy policy, no way to get in touch, no about page.",
          "The reviewer couldn't get in: pages blocked by robots.txt, a login wall, a site that is down or very slow.",
          "Content that breaks the AdSense program policies, such as copyrighted material or restricted topics.",
        ],
      },
      {
        heading: "Fix them in this order",
        body: [
          "Make sure the site can be reached and crawled first — nothing else matters if the reviewer sees an error. Then add the required pages, then work on content depth, and finish with technical polish such as ads.txt and mobile layout. Re-check after each round of changes before you apply again.",
        ],
      },
    ],
  },
  {
    id: "guide-required-pages",
    title: "The pages reviewers look for first",
    summary: "Privacy policy, contact, about and terms — what each one needs to say.",
    readingMinutes: 2,
    sections: [
      {
        heading: "Privacy policy",
        body: [
          "AdSense publishers must have a privacy policy. It should explain that third parties, including Google, use cookies to serve ads based on a visitor's earlier visits, and how visitors can opt out of personalised advertising. Link to it from every page, usually in the footer.",
        ],
      },
      {
        heading: "Contact page",
        body: [
          "A real way to reach you — a form or an email address that someone reads. A page that only says “contact us” with nothing on it counts against you.",
        ],
      },
      {
        heading: "About page",
        body: [
          "Who is behind the site and what it is for. A few honest paragraphs are enough; it shows a reviewer the site has an owner and a purpose.",
        ],
      },
      {
        heading: "Terms or disclaimer",
        body: [
          "Not strictly required, but common on approved sites, especially those giving advice or using affiliate links.",
        ],
      },
    ],
  },
  {
    id: "guide-ads-txt",
    title: "ads.txt in plain English",
    summary: "What the file is, where it goes and the one line most AdSense sites need.",
    readingMinutes: 2,
    sections: [
      {
        body: [
          "ads.txt (Authorized Digital Sellers) is a public text file that lists who is allowed to sell ad space on your site. It helps stop others from selling fake inventory in your name.",
        ],
      },
      {
        heading: "Where it goes",
        body: [
          "At the root of your domain, so it opens at yourdomain.com/ads.txt. A file in a sub-folder is ignored.",
        ],
      },
      {
        heading: "What it contains",
        body: [
          "For AdSense, one line: google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0 — with your own publisher ID in place of the zeros. Your exact line is shown in your AdSense account under Sites.",
          "Without the file you can still be approved, but AdSense shows a warning and earnings can be affected once ads are live, so it's worth adding early.",
        ],
      },
    ],
  },
  {
    id: "guide-content",
    title: "How much content is enough?",
    summary: "Google publishes no minimum page count or word count. Here is what matters instead.",
    readingMinutes: 2,
    sections: [
      {
        body: [
          "There is no official number of posts or words. Reviewers judge whether the site offers something useful that a visitor couldn't get elsewhere, and whether it looks like a working site rather than a placeholder.",
        ],
      },
      {
        heading: "What helps",
        body: [
          "Pages that answer a question properly, written by someone who knows the subject.",
          "A clear topic, with posts that belong together and categories that aren't empty.",
          "Regular publishing, so the site doesn't look abandoned.",
        ],
      },
      {
        heading: "What hurts",
        body: [
          "Very short pages, near-duplicate posts, scraped or spun text, and pages stuffed with keywords. This checker flags pages it finds thin or duplicated so you know which ones to expand, merge or remove.",
        ],
      },
    ],
  },
];

export type Faq = { q: string; a: string };

/** Answers that need live values (check counts, payment methods) are built in the FAQ component. */
export const STATIC_FAQS: Faq[] = [
  {
    q: "Is this an official Google service?",
    a: "No. AdSense Eligibility Checker is an independent pre-review tool. It helps you find likely problems before you apply; the approval decision is always made by Google.",
  },
  {
    q: "Does a good score guarantee approval?",
    a: "No. The report shows the issues that most often lead to a rejection and how to fix them, which improves your chances — but no tool can promise an approval.",
  },
  {
    q: "Do I need an account to scan my site?",
    a: "Yes, a free account. Enter your domain above and you'll be asked to sign up (or log in); the scan starts as soon as you're in. The free plan is included with every account.",
  },
  {
    q: "What counts as one scan?",
    a: "Each website analysis counts as one scan. You can scan again after making changes to confirm the issues are fixed.",
  },
  {
    q: "Do unused scans carry forward?",
    a: "No. Your scan allowance resets each billing month, and unused scans do not carry over.",
  },
  {
    q: "Can I change or upgrade my plan?",
    a: "Yes. Upgrade whenever you need more scans or more checks. The new plan's features become available once your payment is verified.",
  },
  {
    q: "Do I need to install anything on my website?",
    a: "No. There's no plugin, script or DNS change. The checker reads your public pages the way a visitor or reviewer would.",
  },
];

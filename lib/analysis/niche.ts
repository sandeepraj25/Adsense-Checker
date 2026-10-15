/**
 * Which broad niche a site is about — a local keyword classifier, used to
 * compare a site only with sites on the same kind of subject
 * (similar_sites_comparison). No outside service.
 *
 * Each niche has a list of characteristic words. A page's title and
 * headings count three times, its body once; the niche with the most hits
 * per 1,000 words wins if it is clearly ahead of the runner-up. Otherwise
 * the site is "general" — better unclassified than mislabelled.
 *
 * Version the list when it changes (NICHE_VERSION) so comparisons never
 * mix two classifications of the same name.
 */

export const NICHE_VERSION = "2026-10";

export const NICHES = {
  food: { label: "Food & recipes", words: ["recipe", "recipes", "cook", "cooking", "bake", "baking", "ingredients", "kitchen", "dinner", "breakfast", "dessert", "flour", "sugar", "oven", "chicken", "curry", "masala", "vegetarian", "vegan", "minutes", "tablespoon", "teaspoon", "cup", "cups", "sauce", "spices"] },
  technology: { label: "Technology", words: ["software", "app", "apps", "android", "iphone", "windows", "laptop", "smartphone", "computer", "code", "coding", "programming", "developer", "javascript", "python", "tech", "gadget", "gadgets", "device", "browser", "update", "ai", "chip", "processor", "linux", "server"] },
  finance: { label: "Finance & money", words: ["money", "finance", "invest", "investing", "investment", "stock", "stocks", "loan", "loans", "credit", "bank", "banking", "tax", "taxes", "mutual", "fund", "funds", "insurance", "budget", "savings", "interest", "crypto", "trading", "income", "salary", "emi"] },
  health: { label: "Health & fitness", words: ["health", "healthy", "fitness", "workout", "exercise", "diet", "weight", "symptoms", "doctor", "disease", "treatment", "yoga", "nutrition", "protein", "calories", "sleep", "mental", "skin", "pain", "medicine", "vitamin", "body", "muscle", "wellness"] },
  travel: { label: "Travel", words: ["travel", "trip", "tour", "tourist", "visit", "destination", "destinations", "hotel", "hotels", "flight", "flights", "beach", "itinerary", "places", "temple", "mountains", "trek", "visa", "airport", "resort", "backpacking", "sightseeing"] },
  education: { label: "Education & careers", words: ["exam", "exams", "study", "students", "student", "syllabus", "course", "courses", "university", "college", "school", "learn", "learning", "notes", "questions", "answers", "class", "admission", "career", "jobs", "job", "recruitment", "result", "teacher"] },
  entertainment: { label: "Entertainment", words: ["movie", "movies", "film", "films", "series", "episode", "season", "actor", "actress", "celebrity", "music", "song", "songs", "album", "trailer", "netflix", "bollywood", "hollywood", "web", "show", "tv", "anime", "review", "cast"] },
  sports: { label: "Sports", words: ["cricket", "football", "match", "matches", "team", "teams", "player", "players", "score", "league", "tournament", "goal", "wicket", "ipl", "fifa", "tennis", "olympics", "coach", "squad", "innings", "stadium", "championship"] },
  gaming: { label: "Gaming", words: ["game", "games", "gaming", "gamer", "playstation", "xbox", "nintendo", "steam", "level", "levels", "mod", "mods", "weapon", "weapons", "quest", "boss", "multiplayer", "esports", "minecraft", "pubg", "fortnite", "cheats"] },
  fashion: { label: "Fashion & beauty", words: ["fashion", "style", "outfit", "outfits", "dress", "dresses", "wear", "clothing", "makeup", "beauty", "skincare", "hair", "hairstyle", "lipstick", "jewellery", "jewelry", "shoes", "saree", "trends", "look", "brand", "collection"] },
  home: { label: "Home & garden", words: ["home", "garden", "gardening", "plants", "plant", "decor", "interior", "furniture", "room", "bedroom", "kitchen", "diy", "cleaning", "paint", "flowers", "soil", "seeds", "house", "design", "renovation", "lighting"] },
  automotive: { label: "Automotive", words: ["car", "cars", "bike", "bikes", "vehicle", "vehicles", "engine", "mileage", "suv", "sedan", "motorcycle", "scooter", "ev", "electric", "price", "variant", "launch", "tyres", "driving", "road", "speed"] },
  news: { label: "News & current affairs", words: ["news", "breaking", "government", "minister", "election", "elections", "police", "court", "report", "reported", "said", "according", "state", "city", "policy", "parliament", "president", "today", "latest", "official", "officials"] },
  business: { label: "Business & marketing", words: ["business", "marketing", "startup", "startups", "company", "companies", "customers", "sales", "seo", "brand", "branding", "strategy", "ecommerce", "entrepreneur", "growth", "leads", "advertising", "social", "management", "product"] },
  parenting: { label: "Parenting & family", words: ["baby", "babies", "kids", "child", "children", "parent", "parents", "parenting", "mom", "mother", "pregnancy", "pregnant", "toddler", "family", "school", "newborn", "feeding", "diaper"] },
  pets: { label: "Pets & animals", words: ["dog", "dogs", "cat", "cats", "pet", "pets", "puppy", "kitten", "breed", "breeds", "vet", "animal", "animals", "fish", "bird", "birds", "aquarium", "grooming", "training"] },
} as const satisfies Record<string, { label: string; words: readonly string[] }>;

export type NicheId = keyof typeof NICHES | "general";

export type NicheResult = { niche: NicheId; label: string; confidence: "high" | "medium" | "low"; share: number };

const LOOKUP = (() => {
  const map = new Map<string, Array<keyof typeof NICHES>>();
  for (const [id, { words }] of Object.entries(NICHES) as Array<[keyof typeof NICHES, { words: readonly string[] }]>) {
    for (const word of words) map.set(word, [...(map.get(word) ?? []), id]);
  }
  return map;
})();

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+/g) ?? [];
}

export function classifyNiche(pages: Array<{ title: string; headings: string[]; text: string }>): NicheResult {
  const hits = new Map<keyof typeof NICHES, number>();
  let total = 0;
  const count = (words: string[], weight: number) => {
    for (const word of words) {
      total += weight;
      for (const id of LOOKUP.get(word) ?? []) hits.set(id, (hits.get(id) ?? 0) + weight);
    }
  };
  for (const page of pages) {
    count(tokens([page.title, ...page.headings].join(" ")), 3);
    count(tokens(page.text.slice(0, 20_000)), 1);
  }
  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [best, second] = ranked;
  const general: NicheResult = { niche: "general", label: "General / mixed", confidence: "low", share: 0 };
  if (!best || total < 150) return general;
  const share = best[1] / total;
  const lead = second ? best[1] / second[1] : Infinity;
  if (share < 0.012 || lead < 1.3) return { ...general, share: Math.round(share * 1000) / 1000 };
  return {
    niche: best[0],
    label: NICHES[best[0]].label,
    confidence: share >= 0.03 && lead >= 2 ? "high" : "medium",
    share: Math.round(share * 1000) / 1000,
  };
}

export function nicheLabel(id: string | null | undefined): string {
  if (!id || id === "general") return "General / mixed";
  return (NICHES as Record<string, { label: string }>)[id]?.label ?? id;
}

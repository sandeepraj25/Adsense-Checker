/**
 * A small, local language detector. No service, no model download.
 *
 *  1. Script first: Devanagari, Bengali, Tamil, Arabic, Cyrillic, CJK and
 *     other scripts identify a language family by their Unicode ranges.
 *  2. Latin-script text is scored against character-trigram models of
 *     eight languages (en, es, fr, de, pt, it, nl, id), built at load time
 *     from the sample texts below — naive Bayes over trigrams with add-one
 *     smoothing. Confidence is the margin between the best and second-best
 *     language per trigram.
 *
 * It is reliable for a few hundred words of ordinary prose in those eight
 * languages. Short text, code-mixed text and other Latin-script languages
 * come back with low confidence or as "unknown", and callers say so.
 */

export type Detection = {
  /** ISO 639-1 code, or a script family such as "devanagari"; "unknown" when unsure. */
  language: string;
  name: string;
  confidence: "high" | "medium" | "low";
  script: string;
  /** Share of letters in the dominant script. */
  scriptShare: number;
};

const SCRIPTS: Array<{ script: string; re: RegExp; language: string; name: string }> = [
  { script: "Devanagari", re: /\p{Script=Devanagari}/u, language: "hi", name: "Hindi (or another Devanagari language)" },
  { script: "Bengali", re: /\p{Script=Bengali}/u, language: "bn", name: "Bengali" },
  { script: "Gurmukhi", re: /\p{Script=Gurmukhi}/u, language: "pa", name: "Punjabi" },
  { script: "Gujarati", re: /\p{Script=Gujarati}/u, language: "gu", name: "Gujarati" },
  { script: "Tamil", re: /\p{Script=Tamil}/u, language: "ta", name: "Tamil" },
  { script: "Telugu", re: /\p{Script=Telugu}/u, language: "te", name: "Telugu" },
  { script: "Kannada", re: /\p{Script=Kannada}/u, language: "kn", name: "Kannada" },
  { script: "Malayalam", re: /\p{Script=Malayalam}/u, language: "ml", name: "Malayalam" },
  { script: "Arabic", re: /\p{Script=Arabic}/u, language: "ar", name: "Arabic-script (Arabic, Urdu or Persian)" },
  { script: "Cyrillic", re: /\p{Script=Cyrillic}/u, language: "ru", name: "Cyrillic-script (Russian, Ukrainian or similar)" },
  { script: "Greek", re: /\p{Script=Greek}/u, language: "el", name: "Greek" },
  { script: "Hebrew", re: /\p{Script=Hebrew}/u, language: "he", name: "Hebrew" },
  { script: "Thai", re: /\p{Script=Thai}/u, language: "th", name: "Thai" },
  { script: "Hangul", re: /\p{Script=Hangul}/u, language: "ko", name: "Korean" },
  { script: "Kana", re: /[\p{Script=Hiragana}\p{Script=Katakana}]/u, language: "ja", name: "Japanese" },
  { script: "Han", re: /\p{Script=Han}/u, language: "zh", name: "Chinese" },
];

const SAMPLES: Record<string, { name: string; text: string }> = {
  en: { name: "English", text: "The best way to learn something new is to start with a small step every day. When we moved into this house, the kitchen was old and the light was poor, but we made it work. I write about the recipes my family actually eats, the mistakes I made along the way, and what I would do differently next time. Most of these dishes take less than an hour, and you will find the ingredients in any local shop. If you have a question, leave a comment below and I will answer as soon as I can. Thank you for reading, and please share this page with a friend who loves to cook at home." },
  es: { name: "Spanish", text: "La mejor manera de aprender algo nuevo es empezar con un pequeño paso cada día. Cuando nos mudamos a esta casa, la cocina era vieja y había poca luz, pero conseguimos que funcionara. Escribo sobre las recetas que mi familia come de verdad, los errores que cometí por el camino y lo que haría de otra forma la próxima vez. La mayoría de estos platos se preparan en menos de una hora, y encontrarás los ingredientes en cualquier tienda del barrio. Si tienes alguna pregunta, deja un comentario abajo y te responderé lo antes posible. Gracias por leer y comparte esta página con un amigo que disfrute cocinando en casa." },
  fr: { name: "French", text: "La meilleure façon d'apprendre quelque chose de nouveau est de commencer par un petit pas chaque jour. Quand nous avons emménagé dans cette maison, la cuisine était vieille et la lumière était faible, mais nous nous sommes débrouillés. J'écris sur les recettes que ma famille mange vraiment, les erreurs que j'ai faites en chemin et ce que je ferais autrement la prochaine fois. La plupart de ces plats se préparent en moins d'une heure, et vous trouverez les ingrédients dans n'importe quel magasin du quartier. Si vous avez une question, laissez un commentaire ci-dessous et je vous répondrai dès que possible. Merci de votre lecture et partagez cette page avec un ami qui aime cuisiner chez lui." },
  de: { name: "German", text: "Der beste Weg, etwas Neues zu lernen, ist jeden Tag mit einem kleinen Schritt anzufangen. Als wir in dieses Haus gezogen sind, war die Küche alt und das Licht schlecht, aber wir haben das Beste daraus gemacht. Ich schreibe über die Rezepte, die meine Familie wirklich isst, über die Fehler, die ich dabei gemacht habe, und darüber, was ich beim nächsten Mal anders machen würde. Die meisten dieser Gerichte sind in weniger als einer Stunde fertig, und die Zutaten findest du in jedem Geschäft in der Nähe. Wenn du eine Frage hast, schreib unten einen Kommentar und ich antworte so schnell wie möglich. Danke fürs Lesen und teile diese Seite mit einem Freund, der gern zu Hause kocht." },
  pt: { name: "Portuguese", text: "A melhor maneira de aprender algo novo é começar com um pequeno passo todos os dias. Quando nos mudamos para esta casa, a cozinha era velha e a luz era fraca, mas conseguimos fazer funcionar. Eu escrevo sobre as receitas que a minha família realmente come, os erros que cometi pelo caminho e o que faria de forma diferente da próxima vez. A maioria destes pratos fica pronta em menos de uma hora, e você vai encontrar os ingredientes em qualquer loja do bairro. Se tiver alguma pergunta, deixe um comentário abaixo e eu respondo assim que puder. Obrigado pela leitura e compartilhe esta página com um amigo que gosta de cozinhar em casa." },
  it: { name: "Italian", text: "Il modo migliore per imparare qualcosa di nuovo è cominciare con un piccolo passo ogni giorno. Quando ci siamo trasferiti in questa casa, la cucina era vecchia e la luce era scarsa, ma siamo riusciti a farla funzionare. Scrivo delle ricette che la mia famiglia mangia davvero, degli errori che ho fatto lungo la strada e di cosa farei diversamente la prossima volta. La maggior parte di questi piatti è pronta in meno di un'ora, e troverai gli ingredienti in qualsiasi negozio del quartiere. Se hai una domanda, lascia un commento qui sotto e ti risponderò appena possibile. Grazie per aver letto e condividi questa pagina con un amico che ama cucinare a casa." },
  nl: { name: "Dutch", text: "De beste manier om iets nieuws te leren is elke dag met een kleine stap te beginnen. Toen we in dit huis kwamen wonen, was de keuken oud en het licht slecht, maar we hebben er het beste van gemaakt. Ik schrijf over de recepten die mijn familie echt eet, de fouten die ik onderweg heb gemaakt en wat ik de volgende keer anders zou doen. De meeste van deze gerechten zijn in minder dan een uur klaar, en de ingrediënten vind je in elke winkel in de buurt. Als je een vraag hebt, laat dan hieronder een reactie achter en ik antwoord zo snel mogelijk. Bedankt voor het lezen en deel deze pagina met een vriend die graag thuis kookt." },
  id: { name: "Indonesian", text: "Cara terbaik untuk mempelajari sesuatu yang baru adalah memulai dengan langkah kecil setiap hari. Ketika kami pindah ke rumah ini, dapurnya sudah tua dan cahayanya kurang, tetapi kami tetap bisa memakainya. Saya menulis tentang resep yang benar-benar dimakan keluarga saya, kesalahan yang saya buat selama ini, dan apa yang akan saya lakukan dengan cara berbeda lain kali. Sebagian besar hidangan ini selesai dalam waktu kurang dari satu jam, dan bahan-bahannya bisa kamu temukan di toko mana pun di sekitar rumah. Jika kamu punya pertanyaan, tinggalkan komentar di bawah dan saya akan menjawab secepat mungkin. Terima kasih sudah membaca dan bagikan halaman ini kepada teman yang suka memasak di rumah." },
};

function trigrams(text: string): string[] {
  const clean = ` ${text.toLowerCase().replace(/[^\p{L}\s']+/gu, " ").replace(/\s+/g, " ").trim()} `;
  const out: string[] = [];
  for (let i = 0; i + 3 <= clean.length; i += 1) out.push(clean.slice(i, i + 3));
  return out;
}

type Model = { name: string; counts: Map<string, number>; total: number; vocab: number };

const MODELS: Record<string, Model> = Object.fromEntries(
  Object.entries(SAMPLES).map(([code, { name, text }]) => {
    const counts = new Map<string, number>();
    for (const t of trigrams(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [code, { name, counts, total: [...counts.values()].reduce((a, b) => a + b, 0), vocab: counts.size }];
  }),
);
const VOCAB = new Set(Object.values(MODELS).flatMap((m) => [...m.counts.keys()])).size + 1;

export const LATIN_LANGUAGES = Object.keys(SAMPLES);

/** Scores Latin-script text; returns languages best first with a per-trigram margin. */
export function scoreLatin(text: string): Array<{ language: string; name: string; score: number }> {
  const grams = trigrams(text).slice(0, 4000);
  if (grams.length === 0) return [];
  return Object.entries(MODELS)
    .map(([language, model]) => {
      let logp = 0;
      for (const g of grams) logp += Math.log(((model.counts.get(g) ?? 0) + 1) / (model.total + VOCAB));
      return { language, name: model.name, score: logp / grams.length };
    })
    .sort((a, b) => b.score - a.score);
}

export function detectLanguage(text: string): Detection {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 40) return { language: "unknown", name: "unknown", confidence: "low", script: "unknown", scriptShare: 0 };
  const sample = letters.slice(0, 20_000);
  let best: { script: string; language: string; name: string; count: number } | null = null;
  for (const s of SCRIPTS) {
    const count = sample.filter((ch) => s.re.test(ch)).length;
    if (!best || count > best.count) best = { script: s.script, language: s.language, name: s.name, count };
  }
  const latin = sample.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  if (best && best.count > latin) {
    const share = best.count / sample.length;
    // Japanese mixes Kana with Han; Kana present at all decides it.
    const kana = sample.filter((ch) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)).length;
    const pick = best.script === "Han" && kana > sample.length * 0.05 ? { script: "Kana", language: "ja", name: "Japanese" } : best;
    return { language: pick.language, name: pick.name, confidence: share >= 0.6 ? "high" : "medium", script: pick.script, scriptShare: share };
  }
  const scores = scoreLatin(text);
  const [first, second] = scores;
  const share = latin / sample.length;
  if (!first || !second) return { language: "unknown", name: "unknown", confidence: "low", script: "Latin", scriptShare: share };
  const margin = first.score - second.score;
  const words = text.split(/\s+/).length;
  // Measured on held-out prose: correct languages win by 0.11–0.42 per
  // trigram; code-mixed text by ~0.00. Below 0.08 we do not name a language.
  const confidence = margin >= 0.2 && words >= 80 ? "high" : margin >= 0.08 && words >= 40 ? "medium" : "low";
  return { language: confidence === "low" ? "unknown" : first.language, name: confidence === "low" ? `possibly ${first.name}` : first.name, confidence, script: "Latin", scriptShare: share };
}

/**
 * Languages Google lists as supported by AdSense — a local copy (version
 * 2026-10) that may lag behind Google's own list; check it before acting.
 */
export const ADSENSE_LANGUAGES_VERSION = "2026-10";
export const ADSENSE_LANGUAGES = new Set([
  "ar", "bn", "bg", "ca", "zh", "hr", "cs", "da", "nl", "en", "et", "fil", "tl", "fi", "fr", "de", "el", "gu", "he", "iw", "hi", "hu", "id", "it", "ja", "kn", "ko", "lv", "lt", "ms", "ml", "mr", "no", "nb", "fa", "pl", "pt", "pa", "ro", "ru", "sr", "sk", "sl", "es", "sv", "ta", "te", "th", "tr", "uk", "ur", "vi",
]);

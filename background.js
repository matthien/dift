// Background script: runs inside the extension, outside any web page.
// Jobs: react to the shortcut, talk to the dictionary APIs, play audio.

const WIKTIONARY_API = "https://en.wiktionary.org/api/rest_v1/page/definition/";
const DICTIONARY_API = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const TIMEOUT_MS = 5000; // a service that hasn't answered by now counts as down

// --- 1. Shortcut pressed -> put the content script into the current tab ---

browser.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "define-selection") return;

  // Older Firefox versions don't pass `tab`, so look it up if needed.
  if (!tab) {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  }

  try {
    // Pressing the shortcut grants "activeTab", which allows this injection.
    // content.js runs immediately and shows the box.
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (err) {
    // Firefox doesn't let extensions into some pages (about:, addons.mozilla.org, PDFs).
    console.warn("dift can't run on this page:", err.message);
  }
});

// --- 2. Messages from the content script ---

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "lookup") {
    // Returning a Promise sends its result back as the reply.
    return lookup(message.word, message.sentenceStart);
  }
  if (message.type === "play") {
    playAudio(message.url);
  }
});

// --- 3. Lookup: ask both dictionaries at once, then combine ---
//
// Every lookup function returns either
//   { ok: true, entry: { word, audio, meanings, forms } }   or   { ok: false, error: "not-found" | "network" }
// lookup() replies with the same shape plus:
//   entry.notes   e.g. ["plural of leaf", "plural of leave"]  (shown under the title)
//   entry.forms   base words with their meanings: [{ word: "leaf", meanings }]
//   entry.sources where everything came from (shown in the box footer)

const MAX_BASE_WORDS = 3;

async function lookup(word, sentenceStart) {
  // Wiktionary treats "Paris" and "paris" as different pages, so we may ask for both.
  // Preferred spelling first: at a sentence start the capital is just grammar, so
  // prefer lowercase; mid-sentence the writer chose the capital, so keep it.
  const lower = word.toLowerCase();
  const spellings = word === lower ? [lower]
    : sentenceStart ? [lower, word]
    : [word, lower];

  // Start dictionaryapi.dev now, but don't wait for it yet: it can be slow, and the
  // base-word lookups below only need Wiktionary's answer.
  const dictPromise = lookupDictionaryApi(lower);
  const wikis = await Promise.all(spellings.map(lookupWiktionary));

  // First spelling (in preference order) that Wiktionary has.
  const found = wikis.findIndex((result) => result.ok);
  const wiki = found >= 0 ? wikis[found]
    : { ok: false, error: wikis.some((r) => r.error === "not-found") ? "not-found" : "network" };

  // "foxes" -> "plural of fox": look up the base words (all at once), alongside dictionaryapi.dev.
  const [dict] = await Promise.all([dictPromise, wiki.ok && addBaseWords(wiki.entry, spellings)]);

  // Wiktionary has it: its definitions, plus dictionaryapi.dev's audio if available.
  if (wiki.ok) {
    const spelling = spellings[found];
    const entry = wiki.entry;
    entry.sources = [{ label: "Definitions", name: "Wiktionary", url: wiktionaryPage(spelling) }];
    // dictionaryapi.dev only knows lowercase words. Pairs like "Polish"/"polish" are
    // pronounced differently, so only borrow its audio for the same word.
    const sameWord = spelling === lower || dict.entry?.word === spelling;
    if (dict.ok && dict.entry.audio && sameWord) {
      entry.audio = dict.entry.audio;
      entry.sources.push({ label: "Audio", name: "dictionaryapi.dev", url: "https://dictionaryapi.dev" });
    }
    return { ok: true, entry };
  }

  // Wiktionary down or missing the word: use dictionaryapi.dev for everything.
  if (dict.ok) {
    const entry = dict.entry;
    entry.sources = [{
      label: entry.audio ? "Definitions & audio" : "Definitions",
      name: "dictionaryapi.dev",
      url: "https://dictionaryapi.dev",
    }];
    return { ok: true, entry };
  }

  // Neither has it. If at least one actually answered "not found", say so.
  const error = wiki.error === "not-found" || dict.error === "not-found" ? "not-found" : "network";
  return { ok: false, error };
}

// Replace entry.forms ([{ word, note }] from trimWiktionary) with the base words'
// meanings, and collect the notes. One level only: a base word's own forms are ignored.
async function addBaseWords(entry, spellings) {
  entry.notes = [...new Set(entry.forms.map((form) => form.note))];

  const bases = [...new Set(entry.forms.map((form) => form.word))]
    .filter((base) => !spellings.includes(base)) // never "follow" back to the same word
    .slice(0, MAX_BASE_WORDS);

  const results = await Promise.all(bases.map(lookupWiktionary));
  // A base word that failed to load is skipped; its note still shows.
  entry.forms = bases
    .map((base, i) => ({ word: base, meanings: results[i].ok ? results[i].entry.meanings : [] }))
    .filter((form) => form.meanings.length > 0);
}

// fetch with a time limit. Throws on no connection or timeout.
function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// Shared by both lookups: turn the HTTP outcome into ok / not-found / network.
async function request(url, options, trim) {
  let response;
  try {
    response = await fetchWithTimeout(url, options);
  } catch {
    return { ok: false, error: "network" }; // no connection or took too long
  }
  if (response.status === 404) return { ok: false, error: "not-found" };
  if (!response.ok) return { ok: false, error: "network" }; // e.g. 522 = service down

  const entry = trim(await response.json());
  // Nothing to show: no meanings and no base words to follow ("foxes" has only base words).
  if (entry.meanings.length === 0 && !entry.forms?.length) return { ok: false, error: "not-found" };
  return { ok: true, entry };
}

function wiktionaryPage(word) {
  return "https://en.wiktionary.org/wiki/" + encodeURIComponent(word);
}

// --- 3a. Wiktionary ---

function lookupWiktionary(word) {
  return request(
    WIKTIONARY_API + encodeURIComponent(word),
    // Wikimedia asks API users to identify themselves.
    { headers: { "Api-User-Agent": "dift/0.4 (personal Firefox extension)" } },
    (data) => trimWiktionary(word, data)
  );
}

// Raw format: { en: [{ partOfSpeech, language, definitions: [{ definition, examples }] }], fr: [...], ... }
// Definitions and examples contain HTML (links, bold), and "en" also includes
// "Translingual" entries, so: keep English only and convert HTML to plain text.
// Bare "plural of fox"-style lines are removed from the meanings and returned
// as entry.forms ([{ word: "fox", note: "plural of fox" }]) for lookup() to follow.
function trimWiktionary(word, data) {
  const byPartOfSpeech = new Map();
  const forms = [];

  for (const section of data.en ?? []) {
    if (section.language !== "English") continue;
    const pos = section.partOfSpeech.toLowerCase(); // "Noun" -> "noun", to match the other source
    for (const def of section.definitions ?? []) {
      const body = parseHtml(def.definition);
      // "This term needs a definition…" is a placeholder for editors, not a meaning.
      if (body.querySelector('a[title="Template:rfdef"]')) continue;
      const found = readForms(body, pos);
      forms.push(...found);
      // A line that's nothing but "plural of fox" is replaced by following the link.
      if (found.length > 0 && isOnlyForms(body)) continue;

      const text = tidy(body.textContent);
      if (!text) continue; // Wiktionary includes some empty definitions
      if (!byPartOfSpeech.has(pos)) byPartOfSpeech.set(pos, []);
      const example = def.examples?.[0];
      byPartOfSpeech.get(pos).push({ text, example: example ? htmlToText(example) : null });
    }
  }

  return { word, audio: null, meanings: groupedToList(byPartOfSpeech), forms };
}

// Wiktionary marks "plural of fox" as <span class="form-of-definition">, with the
// base word as a link inside <span class="form-of-definition-link">.
// Only grammar forms are followed, not e.g. "Alternative spelling of bettor".
// The part of speech goes in the note: "plural of season (noun)" vs "present of season (verb)".
function readForms(body, pos) {
  const forms = [];
  for (const span of body.querySelectorAll(".form-of-definition")) {
    const kind = shortKind(span.textContent.split(" of ")[0]);
    if (!kind) continue;
    for (const link of span.querySelectorAll(".form-of-definition-link a")) {
      const base = link.title || link.textContent.trim();
      if (base) forms.push({ word: base, note: `${kind} of ${base} (${pos})` });
    }
  }
  return forms;
}

// "third-person singular simple present indicative" -> "present", etc.
// Returns null for anything that isn't a grammar form.
function shortKind(text) {
  const t = text.toLowerCase();
  if (t.includes("plural")) return "plural";
  if (t.includes("past participle")) return "past participle";
  if (t.includes("present participle")) return "present participle";
  if (t.includes("past")) return "past";
  if (t.includes("third-person") || t.includes("present")) return "present";
  if (t.includes("comparative")) return "comparative";
  if (t.includes("superlative")) return "superlative";
  return null;
}

// True if the line has no words left once the "plural of fox" parts (and labels
// like "from leave:", which Wiktionary marks the same way) are removed.
function isOnlyForms(body) {
  const copy = body.cloneNode(true);
  copy.querySelectorAll(".use-with-mention").forEach((node) => node.remove());
  return !/\p{L}/u.test(copy.textContent);
}

// DOMParser reads HTML without running it, so this is safe for untrusted text.
// textContent includes the code inside <style>/<script> tags (Wiktionary
// embeds CSS in some definitions), so remove those tags first.
function parseHtml(html) {
  const body = new DOMParser().parseFromString(html ?? "", "text/html").body;
  body.querySelectorAll("style, script, link, meta").forEach((node) => node.remove());
  return body;
}

function htmlToText(html) {
  return tidy(parseHtml(html).textContent);
}

// Some definitions contain nested sub-meanings; keep those on their own lines.
function tidy(text) {
  return text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

// --- 3b. dictionaryapi.dev ---

function lookupDictionaryApi(word) {
  return request(DICTIONARY_API + encodeURIComponent(word), {}, (data) => trimDictionaryApi(word, data));
}

// Raw format: a list of entries, each with its own phonetics and meanings.
function trimDictionaryApi(word, entries) {
  let audio = null;
  const byPartOfSpeech = new Map(); // "noun" -> [definitions...]

  for (const entry of entries) {
    // First non-empty audio link wins (many are empty strings).
    for (const phonetic of entry.phonetics ?? []) {
      if (!audio && phonetic.audio) audio = phonetic.audio;
    }

    // Merge meanings from every entry, grouped by part of speech.
    for (const meaning of entry.meanings ?? []) {
      const pos = meaning.partOfSpeech;
      if (!byPartOfSpeech.has(pos)) byPartOfSpeech.set(pos, []);
      for (const def of meaning.definitions ?? []) {
        byPartOfSpeech.get(pos).push({
          text: def.definition,
          example: def.example ?? null,
        });
      }
    }
  }

  return { word: entries[0]?.word ?? word, audio, meanings: groupedToList(byPartOfSpeech) };
}

// Map { "noun" -> [...] } -> [{ partOfSpeech: "noun", definitions: [...] }]
function groupedToList(byPartOfSpeech) {
  return [...byPartOfSpeech].map(([partOfSpeech, definitions]) => ({ partOfSpeech, definitions }));
}

// --- 4. Audio ---

let currentAudio = null;

function playAudio(url) {
  // Only play real web links; ignore anything else a message might contain.
  if (typeof url !== "string" || !url.startsWith("https://")) return;

  if (currentAudio) currentAudio.pause(); // don't overlap if clicked twice
  currentAudio = new Audio(url);
  currentAudio.play().catch((err) => console.warn("dift audio failed:", err.message));
}

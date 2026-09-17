"use strict";

// ---- vocab-ai.js ----
// Optional, on-demand LIVE Gemini calls for two per-learner features that
// data/ai_signals.json's offline batch script (scripts/generate_ai_signals.py)
// structurally can't cover, because both depend on THIS learner's own
// recorded data at the moment they're used, not just properties of the word
// itself:
//   - Personalized mnemonic (see requestPersonalizedMnemonic): targeted at
//     a word's own recorded wrong-answer PATTERN for this learner, shown in
//     卡片複習模式 for 答錯待複習 words - a generic, same-for-everyone hook
//     (data/ai_signals.json's own static `mnemonic` field, already shown in
//     the quiz's own wrong-answer feedback) can't do this.
//   - Memory-palace story (see requestMemoryPalaceStory): one short story
//     weaving together several of this learner's current 答錯待複習／學習中
//     words as a single group mnemonic, triggered from 複習's own panel.
//
// Reuses Orbit's already-deployed Cloudflare Worker (see that project's
// cloudflare-worker/orbit-worker.js, its `/vocab-ai` path) as shared
// server-side infrastructure - same reuse reasoning as this app's own
// sync.js and its `/vocab-sync` path (see that file's top-of-file comment).
// Unlike `/vocab-sync`, `/vocab-ai` needs no passcode: it isn't tied to any
// one learner's sync pairing, only rate-limited server-side by IP - same
// trust model Orbit's own `/gemini` schedule-photo import already uses.
//
// Loaded as a plain <script> (attaches everything to `window.VocabAi`), same
// as sync.js - the proxy URL below is a placeholder substituted at deploy
// time by .github/workflows/pages.yml, the same sed-based mechanism that
// already stamps __VOCAB_SYNC_PROXY_URL__. Left as the literal placeholder
// (or empty, if the GitHub Actions variable behind it is unset) when running
// locally without that build step - see isVocabAiConfigured() below.
const VOCAB_AI_PROXY_URL = "__VOCAB_AI_PROXY_URL__";

function isVocabAiConfigured() {
  // Same two-case check sync.js's own isSyncProxyConfigured() and app.js's
  // checkForUpdate() already use for their own build-stamped placeholders.
  return !!VOCAB_AI_PROXY_URL && !VOCAB_AI_PROXY_URL.startsWith("__");
}

/* ---------- Personalized mnemonic (cached in localStorage) ---------- */

const MNEMONIC_CACHE_KEY = "vocab_ai_mnemonics_v1";

function loadMnemonicCache() {
  try {
    const raw = localStorage.getItem(MNEMONIC_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}
function saveMnemonicCache(cache) {
  try {
    localStorage.setItem(MNEMONIC_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    /* localStorage full/unavailable - the mnemonic just isn't cached this
       time, same "degrade quietly" reasoning as saveJSON's own callers. */
  }
}

// Order-independent fingerprint of the wrong-answer set a cached mnemonic
// was generated from - a fresh Logic.recentWrongAnswersOf() call can reorder
// the same set without anything having actually changed, so this is what
// decides whether a cached entry is still targeting the CURRENT mistake
// pattern (see requestPersonalizedMnemonic) rather than just comparing
// arrays positionally.
function wrongAnswersFingerprint(wrongAnswers) {
  return (wrongAnswers || []).slice().sort().join("␟");
}

async function vocabAiProxyPost(body) {
  try {
    const response = await fetch(VOCAB_AI_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 429) return { ok: false, error: "請求過於頻繁，請稍後再試。" };
      const errorJson = await response.json().catch(() => ({}));
      return { ok: false, error: errorJson.error?.message || response.statusText || `HTTP ${response.status}` };
    }
    return { ok: true, data: await response.json() };
  } catch (error) {
    return { ok: false, error: `連線失敗：${error.message || error}` };
  }
}

// Returns { ok: true, mnemonic, cached } or { ok: false, error }. A cached
// entry generated from the EXACT SAME wrong-answer set (see
// wrongAnswersFingerprint) is returned immediately with no network call -
// that's the whole point of caching this at all (see README), since the
// mistake pattern it targets hasn't changed. `opts.force` (the flashcard
// UI's own "重新產生" button) bypasses the cache and always asks again.
// Cache-only lookup, no network call - used by the flashcard UI to decide,
// purely from what's already on disk, whether to show a hook immediately on
// render or wait for an explicit tap of "🧠 個人化記憶法" (see app.js's
// renderFlashcardMnemonicSection). Deliberately never triggers a live
// request on its own: auto-firing one for every 答錯待複習 card as a whole
// deck is browsed would burn through the Worker's per-IP rate limit on
// words nobody actually asked a hook for.
function peekCachedMnemonic(word) {
  const cache = loadMnemonicCache();
  const entry = cache[String(word || "").toLowerCase()];
  return entry ? entry.mnemonic : null;
}

async function requestPersonalizedMnemonic(word, pos, meaning, wrongAnswers, opts) {
  const force = !!(opts && opts.force);
  const key = String(word || "").toLowerCase();
  const fingerprint = wrongAnswersFingerprint(wrongAnswers);
  const cache = loadMnemonicCache();
  const cached = cache[key];
  if (!force && cached && cached.fingerprint === fingerprint) {
    return { ok: true, mnemonic: cached.mnemonic, cached: true };
  }
  if (!isVocabAiConfigured()) return { ok: false, error: "個人化記憶法功能尚未設定。" };
  if (!navigator.onLine) return { ok: false, error: "目前離線，無法產生個人化記憶法。" };

  const result = await vocabAiProxyPost({
    kind: "mnemonic",
    word: word,
    pos: pos || "",
    meaning: meaning || "",
    wrongAnswers: wrongAnswers || [],
  });
  if (!result.ok) return { ok: false, error: result.error };
  const mnemonic = typeof result.data.mnemonic === "string" ? result.data.mnemonic.trim() : "";
  if (!mnemonic) return { ok: false, error: "AI 沒有回傳有效的記憶法。" };

  cache[key] = { mnemonic: mnemonic, fingerprint: fingerprint, createdAt: Date.now() };
  saveMnemonicCache(cache);
  return { ok: true, mnemonic: mnemonic, cached: false };
}

/* ---------- Memory-palace story mode (never cached - each batch is a
   fresh, user-triggered request) ---------- */

// Words from `words` that don't actually appear anywhere in `story` (plain
// case-insensitive substring check - a word appearing inside a longer
// inflected form, e.g. "cat" inside "cats", still counts as used). Never
// trusts the model's own claim of which words it used - same defensive
// posture as generate_ai_signals.py's clean_item(), just applied to prose
// instead of a structured list.
function storyMissingWords(story, words) {
  const lowerStory = (story || "").toLowerCase();
  return (words || []).filter((w) => !lowerStory.includes(String(w).toLowerCase()));
}

// `words`: [{word, meaning}], 2-6 entries (see README's 記憶宮殿故事模式).
// Returns { ok: true, story, usedWords } or { ok: false, error } - rejects
// (rather than silently displaying) a story that dropped one of the
// requested words, per storyMissingWords above.
async function requestMemoryPalaceStory(words) {
  if (!isVocabAiConfigured()) return { ok: false, error: "記憶宮殿故事模式尚未設定。" };
  if (!navigator.onLine) return { ok: false, error: "目前離線，無法產生故事。" };
  if (!Array.isArray(words) || words.length < 2) return { ok: false, error: "至少需要 2 個單字才能產生故事。" };

  const result = await vocabAiProxyPost({ kind: "story", words: words });
  if (!result.ok) return { ok: false, error: result.error };
  const story = typeof result.data.story === "string" ? result.data.story.trim() : "";
  if (!story) return { ok: false, error: "AI 沒有回傳有效的故事。" };
  // The Worker echoes back the exact (post-validation) word list it actually
  // sent to the model - falls back to the request's own words only if an
  // older/unexpected response shape omits it.
  const usedWords = Array.isArray(result.data.words) && result.data.words.length ? result.data.words : words.map((w) => w.word);

  const missing = storyMissingWords(story, usedWords);
  if (missing.length) {
    return { ok: false, error: `AI 產生的故事沒有用到「${missing.join("、")}」，請再試一次。` };
  }
  return { ok: true, story: story, usedWords: usedWords };
}

window.VocabAi = {
  isConfigured: isVocabAiConfigured,
  peekCachedMnemonic: peekCachedMnemonic,
  requestPersonalizedMnemonic: requestPersonalizedMnemonic,
  requestMemoryPalaceStory: requestMemoryPalaceStory,
};

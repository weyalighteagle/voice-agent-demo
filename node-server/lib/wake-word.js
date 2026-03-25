/**
 * Wake word detection with Levenshtein distance fuzzy matching.
 *
 * Two matching strategies run in parallel:
 *   1. Word-level — each whitespace-separated token in the transcript
 *      is compared against the wake word.
 *   2. Sliding window — a character window slides over the full normalised
 *      transcript to catch cases where the wake word is merged with
 *      adjacent text or split across tokens.
 *
 * Both strategies use Levenshtein distance with a configurable tolerance
 * ratio so that minor transcription errors don't prevent detection.
 */

// ── Levenshtein distance ────────────────────────────────────────────────────
function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
    }
    return dp[m][n];
}

// ── Turkish-aware normalisation ─────────────────────────────────────────────
function normalise(text) {
    return text
        .toLowerCase()
        // Turkish-specific: İ→i, I→ı handled by toLowerCase in most runtimes,
        // but we also strip common diacritics that ASR may produce inconsistently
        .replace(/[.,!?;:'"()\-–—…\[\]{}]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// ── Basic Latin-script check ────────────────────────────────────────────────
// Reject transcripts that are predominantly non-Latin (Cyrillic, Arabic, CJK…)
// to avoid false wake word triggers from misrecognised languages.
function isPredominantlyLatin(text) {
    if (!text) return false;
    const stripped = text.replace(/[\s\d.,!?;:'"()\-–—…\[\]{}]/g, "");
    if (stripped.length === 0) return false;
    // Latin + Latin Extended + Turkish specific chars
    const latinChars = stripped.match(/[\u0041-\u024F\u00C0-\u00FF\u0100-\u017F]/g);
    const ratio = (latinChars?.length || 0) / stripped.length;
    return ratio >= 0.7;
}

/**
 * Check whether the transcript contains the wake word (fuzzy).
 *
 * @param {string}  transcript         Full transcribed text from OpenAI
 * @param {string}  wakeWord           The configured wake word
 * @param {number}  [maxDistRatio=0.25] Maximum Levenshtein distance as a
 *                                      fraction of wake word length.
 *                                      0.25 means a 4-char word tolerates 1
 *                                      edit — strict enough to avoid "ya"
 *                                      matching "veya" while still catching
 *                                      "weya" → "veya".
 * @returns {boolean}
 */
export function containsWakeWord(transcript, wakeWord, maxDistRatio = 0.25) {
    if (!wakeWord || !transcript) return false;

    // ── Guard: reject non-Latin transcripts (Cyrillic, etc.) ──────────────
    if (!isPredominantlyLatin(transcript)) {
        return false;
    }

    const normTranscript = normalise(transcript);
    const normWake = normalise(wakeWord);
    if (!normWake || !normTranscript) return false;

    const wakeLen = normWake.length;
    const maxDist = Math.max(1, Math.floor(wakeLen * maxDistRatio));

    // ── Strategy 1: word-level comparison ─────────────────────────────────────
    const words = normTranscript.split(/\s+/);
    for (const word of words) {
        // Skip words that are way too short to be a plausible match
        // e.g. "ya" (2 chars) should never match "veya" (4 chars)
        if (word.length < wakeLen - maxDist) continue;
        if (word.length > wakeLen + maxDist) continue;

        if (levenshtein(word, normWake) <= maxDist) {
            return true;
        }
    }

    // ── Strategy 2: sliding window over raw transcript ────────────────────────
    // Catches wake words that are concatenated with neighbours or split oddly.
    const windowMin = Math.max(1, wakeLen - maxDist);
    const windowMax = wakeLen + maxDist;

    // Only run sliding window on a trimmed version without spaces
    // to catch merged words like "hocamveya" → find "veya" inside
    const compactTranscript = normTranscript.replace(/\s+/g, "");

    for (let winSize = windowMin; winSize <= windowMax; winSize++) {
        for (let i = 0; i <= compactTranscript.length - winSize; i++) {
            const slice = compactTranscript.slice(i, i + winSize);
            if (levenshtein(slice, normWake) <= maxDist) {
                return true;
            }
        }
    }

    return false;
}

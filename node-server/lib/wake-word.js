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

// ── Normalise text for comparison ───────────────────────────────────────────
function normalise(text) {
    return text
        .toLowerCase()
        .replace(/[.,!?;:'"()\-–—…\[\]{}]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Check whether the transcript contains the wake word (fuzzy).
 *
 * @param {string}  transcript         Full transcribed text from OpenAI
 * @param {string}  wakeWord           The configured wake word
 * @param {number}  [maxDistRatio=0.4] Maximum Levenshtein distance as a
 *                                     fraction of wake word length.  0.4
 *                                     means a 5-char word tolerates 2
 *                                     edits — intentionally generous so a
 *                                     single misheard letter never blocks.
 * @returns {boolean}
 */
export function containsWakeWord(transcript, wakeWord, maxDistRatio = 0.4) {
    if (!wakeWord || !transcript) return false;

    const normTranscript = normalise(transcript);
    const normWake = normalise(wakeWord);
    if (!normWake || !normTranscript) return false;

    const wakeLen = normWake.length;
    const maxDist = Math.max(1, Math.ceil(wakeLen * maxDistRatio));

    // ── Strategy 1: word-level comparison ─────────────────────────────────────
    const words = normTranscript.split(/\s+/);
    for (const word of words) {
        if (levenshtein(word, normWake) <= maxDist) {
            return true;
        }
    }

    // ── Strategy 2: sliding window over raw transcript ────────────────────────
    // Catches wake words that are concatenated with neighbours or split oddly.
    const windowMin = Math.max(1, wakeLen - maxDist);
    const windowMax = wakeLen + maxDist;
    for (let winSize = windowMin; winSize <= windowMax; winSize++) {
        for (let i = 0; i <= normTranscript.length - winSize; i++) {
            const slice = normTranscript.slice(i, i + winSize);
            if (levenshtein(slice, normWake) <= maxDist) {
                return true;
            }
        }
    }

    return false;
}
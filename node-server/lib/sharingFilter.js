// JS port of src/api/helpers/sharingFilter.ts
// Heuristic: last " — " segment is a name if it has 2+ capitalised words and no digits.
function stripNameFromTitle(title) {
  const segments = title.split(" — ");
  if (segments.length < 2) return title;

  const last = segments[segments.length - 1];
  const words = last.trim().split(/\s+/);
  const looksLikeName =
    words.length >= 2 &&
    words.every((w) => /^[A-ZÇĞİÖŞÜÂ]/.test(w)) &&
    !/\d/.test(last);

  if (!looksLikeName) return title;

  return [...segments.slice(0, -1), "bir takım üyesi"].join(" — ");
}

/**
 * @param {Array<object>} results  - raw RPC rows
 * @param {{ mode: string, requestingUserEmail: string }} config
 * @returns {Array<object>}
 */
export function filterSharedResults(results, config) {
  if (config.mode === "contribution_consent") {
    throw new Error("contribution_consent not implemented — Mod 3");
  }

  return results.map((result) => {
    if (config.mode === "full_access") {
      return { ...result, brokerableConnection: false };
    }

    // attribution_controlled
    const isOwn =
      result.contributor_email == null ||
      result.contributor_email === config.requestingUserEmail;

    if (isOwn) {
      return { ...result, brokerableConnection: false };
    }

    return {
      ...result,
      brokerableConnection: true,
      contributor_email: null,
      document_title: stripNameFromTitle(result.document_title),
      content: result.contributor_email
        ? result.content.replaceAll(result.contributor_email, "[team member]")
        : result.content,
    };
  });
}

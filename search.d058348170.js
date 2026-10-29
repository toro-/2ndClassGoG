"use strict";

// Search for the static copy of the site, which has no server: the same rules
// as queries.search, run in the browser over the exported data file.
//   - Every word of the input must match, as a word prefix, in the title,
//     developer, publisher, issue text or source labels (like the FTS index).
//   - Case and accents are ignored, as by FTS5's unicode61 tokenizer.
//   - Category and unconfirmed filters select issues, as on the server.
// "Best match" is a simpler ranking than SQLite's bm25: title hits first.
// tests/test_static.py checks the results against queries.search under Node.

const SEARCH_FIELDS = ["title", "developer", "publisher", "issues", "sources"];
const FIELD_WEIGHT = { title: 8, developer: 4, publisher: 4, issues: 1, sources: 1 };
const STATIC_TABS = ["active", "removed"];
const STATIC_SORTS = ["rank", "title", "issues"];

// The words of a text, lowercased and without accents.
function foldWords(text) {
  return (text || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

// Like queries.search_terms: the words of the input, as typed (for highlighting).
function searchTerms(text) {
  return (text || "").match(/[\p{L}\p{N}_]+/gu) || [];
}

// Index each game's words once, after the data file loads.
function prepareGames(games) {
  for (const g of games) {
    g.words = {
      title: foldWords(g.title),
      developer: foldWords(g.developer),
      publisher: foldWords(g.publisher),
      issues: foldWords(g.issues.map((i) => i.text).join("\n")),
      sources: foldWords(g.sources.map((s) => s.label || "").join("\n")),
    };
  }
  return games;
}

// How well one term (a run of words; the last one a prefix) matches a list of
// words: 0 for no match, 1 for a prefix match, 2 when the last word is whole.
function termMatch(words, term) {
  const last = term.length - 1;
  let best = 0;
  for (let i = 0; i + last < words.length; i++) {
    let ok = true;
    for (let j = 0; j < last && ok; j++) ok = words[i + j] === term[j];
    if (!ok || !words[i + last].startsWith(term[last])) continue;
    if (words[i + last] === term[last]) return 2;
    best = 1;
  }
  return best;
}

// SQLite's COLLATE NOCASE folds ASCII letters only.
const nocase = (s) => (s || "").replace(/[A-Z]/g, (c) => c.toLowerCase());
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function resolveCategory(name, categories) {
  const wanted = name.trim().toLowerCase();
  const found = categories.find((c) => [wanted, `missing ${wanted}`].includes(c.toLowerCase()));
  if (!found) throw new Error(`unknown category ${JSON.stringify(name)}; choose from: ${categories.join(", ")}`);
  return found;
}

// Answers /api/search from the data file: params as the page sends them, and
// the same reply shape as server.api_search.
function staticSearch(games, categories, params) {
  const tab = (params.get("tab") || "active").trim();
  const tabs = tab === "all" ? STATIC_TABS : [tab];
  if (!STATIC_TABS.includes(tabs[0])) throw new Error(`unknown tab(s) ["${tab}"]; choose from: ${STATIC_TABS.join(", ")}`);
  let sort = (params.get("sort") || "").trim();
  if (sort && !STATIC_SORTS.includes(sort)) throw new Error(`unknown sort "${sort}"; choose from: ${STATIC_SORTS.join(", ")}`);
  const q = (params.get("q") || "").trim();
  const typed = searchTerms(q);
  const terms = typed.map(foldWords).filter((t) => t.length);
  const publisher = (params.get("publisher") || "").trim().toLowerCase();
  const developer = (params.get("developer") || "").trim().toLowerCase();
  const wanted = params.getAll("category").filter((c) => c.trim()).map((c) => resolveCategory(c, categories));
  const unconfirmed = ["1", "true", "yes", "on"].includes((params.get("unconfirmed") || "").toLowerCase());
  const special = ["1", "true", "yes", "on"].includes((params.get("special") || "").toLowerCase());
  const issueFilter = wanted.length || unconfirmed
    ? (i) => (!wanted.length || wanted.includes(i.category)) && (!unconfirmed || i.unconfirmed)
    : null;
  if (q) sort = sort || "rank";
  else if (sort === "rank") sort = "title";

  const hits = [];
  if (!q || terms.length) {
    for (const g of games) {
      if (!tabs.includes(g.tab)) continue;
      if (publisher && !(g.publisher || "").toLowerCase().includes(publisher)) continue;
      if (developer && !(g.developer || "").toLowerCase().includes(developer)) continue;
      if (special && !g.special_mention) continue;
      let score = 0;
      for (const term of terms) {
        let best = 0;
        for (const field of SEARCH_FIELDS) {
          const m = termMatch(g.words[field], term);
          if (m) best = Math.max(best, FIELD_WEIGHT[field] + m - 1);
        }
        if (!best) { score = -1; break; }
        score += best;
      }
      if (score < 0) continue;
      const issues = issueFilter ? g.issues.filter(issueFilter) : g.issues;
      if (issueFilter && !issues.length) continue;
      hits.push({ g, issues, score });
    }
  }

  const byTitle = (a, b) => compareText(nocase(a.g.title), nocase(b.g.title)) || a.g.id - b.g.id;
  hits.sort(sort === "issues" ? (a, b) => b.g.issue_count - a.g.issue_count || byTitle(a, b)
    : sort === "rank" ? (a, b) => b.score - a.score || byTitle(a, b)
    : byTitle);

  const offset = Math.max(parseInt(params.get("offset") || "0", 10) || 0, 0);
  const limit = parseInt(params.get("limit") || "100", 10);
  const page = limit > 0 ? hits.slice(offset, offset + limit) : hits.slice(offset);
  return {
    total: hits.length,
    offset,
    terms: typed,
    games: page.map(({ g, issues }) => {
      const { words, ...game } = g;
      return { ...game, issues };
    }),
  };
}

if (typeof module === "object") module.exports = { foldWords, prepareGames, searchTerms, staticSearch };

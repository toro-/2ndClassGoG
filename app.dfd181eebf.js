"use strict";

// State lives in the URL hash ("#search?q=linux&category=Missing+Builds") so
// back/forward and bookmarks work. Typing replaces the history entry instead
// of pushing one per keystroke.

const PAGE_SIZE = 100;
const DEFAULTS = {
  q: "", raw: false, tab: "active", category: [], publisher: "", developer: "",
  unconfirmed: false, special: false, sort: "",
};
const $ = (id) => document.getElementById(id);

let CATEGORIES = [];
let READ_ONLY = false;   // a public copy: no cover editor, no pages about the sheet's mistakes
let state = { ...DEFAULTS };
let results = { games: [], total: 0, terms: [] };
let searchSeq = 0;
let problemsCache = null;
const PAGES = ["search", "stats", "problems", "titles", "credits"];
let view = "cards";
try { view = localStorage.getItem("view") || "cards"; } catch { /* storage unavailable */ }

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);
const shortCategory = (c) => c.replace(/^Missing /, "");
const catClass = (c) => `cat-${shortCategory(c).toLowerCase().replace(/\s+/g, "-")}`;  // colour, see style.css
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function highlighter(terms) {
  if (!terms.length) return (text) => text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join("|")})[\\p{L}\\p{N}_]*`, "giu");
  return (text) => {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      frag.append(text.slice(last, m.index), h("mark", {}, m[0]));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    return frag;
  };
}

function extLink(url, label = "↗") {
  const href = safeUrl(url);
  return href && h("a", { class: "ext", href, target: "_blank", rel: "noopener noreferrer", title: href }, label);
}

// A static copy (gogsearch export-static) has no server: index.html names a
// data file instead, and the read-only API calls are answered from it here.
const DATA_FILE = document.querySelector('meta[name="gogsearch-data"]')?.content;
let staticData = null;

async function api(path, params = new URLSearchParams()) {
  if (DATA_FILE) return staticApi(path, params);
  const res = await fetch(`${path}?${params}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function loadStaticData() {
  const res = await fetch(DATA_FILE);
  if (!res.ok) throw new Error(`couldn't load the data (${res.status} ${res.statusText})`);
  const data = await res.json();
  prepareGames(data.games);  // search.js
  return data;
}

async function staticApi(path, params) {
  staticData = staticData || loadStaticData().catch((e) => { staticData = null; throw e; });
  const data = await staticData;
  if (path === "/api/meta") return data.meta;
  if (path === "/api/credits") return data.credits;
  if (path === "/api/search") return staticSearch(data.games, data.meta.categories, params);
  if (path === "/api/stats") {
    const stats = data.stats[params.get("tab") || "active"];
    if (!stats) throw new Error("unknown tab");
    return stats;
  }
  throw new Error("not available on this copy of the site");
}

// ---------- URL <-> state ----------

function toParams(s) {
  const p = new URLSearchParams();
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = s[k];
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v !== def) p.set(k, v === true ? "1" : v);
  }
  return p;
}

function fromParams(p) {
  const s = { ...DEFAULTS, category: p.getAll("category") };
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (Array.isArray(def) || !p.has(k)) continue;
    s[k] = typeof def === "boolean" ? p.get(k) === "1" : p.get(k);
  }
  return s;
}

function searchHref(partial) {
  return `#search?${toParams({ ...DEFAULTS, ...partial })}`;
}

function parseHash() {
  const [page, query = ""] = location.hash.replace(/^#/, "").split("?");
  const allowed = READ_ONLY ? PAGES.filter((p) => p !== "problems" && p !== "titles") : PAGES;
  return { page: allowed.includes(page) ? page : "search", params: new URLSearchParams(query) };
}

// ---------- routing ----------

function route() {
  const { page, params } = parseHash();
  for (const name of PAGES) $(`page-${name}`).hidden = name !== page;
  document.querySelectorAll("nav a").forEach((a) => {
    if (a.dataset.page === page) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (page === "search") {
    // "view" is not part of the search state; it only overrides the saved layout.
    if (["cards", "table"].includes(params.get("view"))) setView(params.get("view"));
    state = fromParams(params);
    writeForm();
    runSearch();
  } else if (page === "stats") {
    $("stats-tab").value = params.get("tab") === "removed" ? "removed" : "active";
    loadStats();
  } else if (page === "problems") {
    loadProblems(params.get("kind") || "");
  } else if (page === "titles") {
    loadTitles();
  } else {
    loadCredits();
  }
}

// ---------- search page ----------

function setView(v) {
  view = v;
  try { localStorage.setItem("view", v); } catch { /* storage unavailable */ }
}

function writeForm() {
  for (const id of ["q", "tab", "publisher", "developer", "sort"]) $(id).value = state[id];
  for (const id of ["raw", "unconfirmed", "special"]) $(id).checked = state[id];
  document.querySelectorAll("#categories .chip").forEach((b) => {
    b.setAttribute("aria-pressed", state.category.includes(b.dataset.category));
  });
  $("sort").querySelector("option[value='']").textContent = state.q ? "Best match" : "Title";
}

function readForm() {
  state = {
    q: $("q").value, raw: $("raw").checked, tab: $("tab").value,
    category: [...document.querySelectorAll("#categories .chip[aria-pressed=true]")].map((b) => b.dataset.category),
    publisher: $("publisher").value.trim(), developer: $("developer").value.trim(),
    unconfirmed: $("unconfirmed").checked, special: $("special").checked, sort: $("sort").value,
  };
  history.replaceState(null, "", `#search?${toParams(state)}`);
  $("sort").querySelector("option[value='']").textContent = state.q ? "Best match" : "Title";
  runSearch();
}

let debounce;
function readFormSoon() {
  clearTimeout(debounce);
  debounce = setTimeout(readForm, 150);
}

async function runSearch(append = false) {
  const seq = ++searchSeq;
  const params = toParams(state);
  params.set("offset", append ? results.games.length : 0);
  params.set("limit", PAGE_SIZE);
  try {
    const body = await api("/api/search", params);
    if (seq !== searchSeq) return; // a newer search started meanwhile
    results = {
      games: append ? results.games.concat(body.games) : body.games,
      total: body.total,
      terms: body.terms,
    };
    $("error").hidden = true;
  } catch (e) {
    if (seq !== searchSeq) return;
    results = { games: [], total: 0, terms: [] };
    $("error").textContent = e.message;
    $("error").hidden = false;
  }
  renderResults();
}

function renderResults() {
  const { games, total } = results;
  $("count").textContent = games.length < total
    ? `Showing ${games.length.toLocaleString()} of ${plural(total, "game")}`
    : plural(total, "game");
  $("more").hidden = games.length >= total;
  document.querySelectorAll(".segmented button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === view));
  const hl = highlighter(results.terms);
  $("page-search").classList.toggle("wide", view === "table");
  $("results").replaceChildren(view === "table" ? renderTable(games, hl) : renderCards(games, hl));
  if (view === "table") updateScrollCue();
}

function filterButton(label, field, value, hl, cls) {
  return h("button", {
    type: "button", class: cls, title: `Only games where ${field} contains “${value}”`,
    onclick: () => { location.hash = searchHref({ tab: state.tab, [field]: value }); },
  }, hl(label));
}

function who(g, hl, cls) {
  if (!g.developer && !g.publisher) return null;
  if (g.developer === g.publisher || !g.developer) return filterButton(g.publisher, "publisher", g.publisher, hl, cls);
  if (!g.publisher) return filterButton(g.developer, "developer", g.developer, hl, cls);
  return [filterButton(g.developer, "developer", g.developer, hl, cls), h("span", { class: "sep" }, "·"),
          filterButton(g.publisher, "publisher", g.publisher, hl, cls)];
}

function badges(g) {
  return [
    g.special_mention && h("span", { class: "badge special", title: "Special mention (red in the sheet)" }, "★ special mention"),
    g.tab === "removed" && h("span", { class: "badge removed" }, "removed from GOG"),
  ];
}

const unconfirmedBadge = () => h("span", { class: "badge unconfirmed", title: "Yellow in the sheet" }, "unconfirmed");

// Landscape thumbnail, or a placeholder with initials so rows stay aligned.
// Clicking it opens the cover editor.
function cover(g, cls = "cover") {
  if (READ_ONLY) {
    if (!g.cover) return h("div", { class: `${cls} none` }, initials(g.title));
    // A static copy links to the stores' images, which can disappear: fall back to the placeholder.
    const img = h("img", { src: g.cover, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    const box = h("div", { class: cls }, img);
    img.addEventListener("error", () => box.replaceWith(h("div", { class: `${cls} none` }, initials(g.title))));
    return box;
  }
  const attrs = { type: "button", onclick: () => openEditor(g.title) };
  if (g.cover) {
    return h("button", { ...attrs, class: cls, title: "Change cover", "aria-label": `Change cover for ${g.title}` },
      h("img", { src: g.cover, alt: "", loading: "lazy", decoding: "async" }));
  }
  return h("button", { ...attrs, class: `${cls} none`, title: "No cover found. Click to pick one.",
    "aria-label": `Pick a cover for ${g.title}` }, initials(g.title));
}

const initials = (title) =>
  title.split(/\s+/).filter((w) => /\w/.test(w)).slice(0, 2).map((w) => w.match(/\w/)[0]).join("").toUpperCase();

function renderCards(games, hl) {
  return h("div", { class: "cards" }, games.map((g) => h("article", { class: "card" }, cover(g), h("div", { class: "card-body" },
    h("header", {},
      h("div", { class: "title-line" }, h("h2", {}, hl(g.title)), badges(g)),
      h("div", { class: "who" }, who(g, hl))),
    g.issues.length
      ? h("dl", { class: "issues" }, g.issues.map((i) => [
          h("dt", {}, h("span", { class: `tag ${catClass(i.category)}` }, shortCategory(i.category))),
          h("dd", {}, hl(i.text), i.unconfirmed && [" ", unconfirmedBadge()], extLink(i.link)),
        ]))
      : h("p", { class: "hint" }, "No open issues listed."),
    g.sources.length > 0 && h("details", {},
      h("summary", {}, plural(g.sources.length, "source")),
      h("ul", {}, g.sources.map((s) => h("li", {},
        s.label && s.label !== s.url ? [hl(s.label), " "] : null,
        safeUrl(s.url) && h("a", { class: "url", href: safeUrl(s.url), target: "_blank", rel: "noopener noreferrer" }, s.url),
        s.unconfirmed && [" ", unconfirmedBadge()],
      ))),
    ),
  ))));
}

function renderTable(games, hl) {
  // Only the category columns that have something in the current results.
  const used = new Set(games.flatMap((g) => g.issues.map((i) => i.category)));
  const cats = CATEGORIES.filter((c) => used.has(c));
  const head = h("tr", {}, h("th", {}, "Title"), h("th", {}, "Developer · Publisher"),
    h("th", { title: "Issues" }, "#"), cats.map((c) => h("th", { class: catClass(c) }, shortCategory(c))),
    h("th", {}, "Sources"));
  const rows = games.map((g) => {
    const byCat = Object.fromEntries(g.issues.map((i) => [i.category, i]));
    return h("tr", {},
      h("td", { class: g.special_mention ? "title special" : "title" }, h("div", { class: "title-cell" },
        cover(g, "thumb"),
        h("div", {}, hl(g.title), g.special_mention && " ★",
          g.tab === "removed" && h("div", {}, h("span", { class: "badge removed" }, "removed"))))),
      h("td", { class: "company" },
        g.developer && h("div", {}, filterButton(g.developer, "developer", g.developer, hl, "who-link")),
        g.publisher && g.publisher !== g.developer &&
          h("div", { class: "pub" }, filterButton(g.publisher, "publisher", g.publisher, hl, "who-link"))),
      h("td", { class: "num" }, g.issue_count),
      cats.map((c) => {
        const i = byCat[c];
        return i
          ? h("td", { class: i.unconfirmed ? "text unconfirmed" : "text", title: i.unconfirmed ? "Unconfirmed" : null },
              hl(i.text), extLink(i.link))
          : h("td", {});
      }),
      h("td", {}, g.sources.map((s, n) => [n > 0 && " ", extLink(s.url, `[${s.slot}]`)])),
    );
  });
  const wrap = h("div", { class: "table-wrap", onscroll: updateScrollCue },
    h("table", {}, h("thead", {}, head), h("tbody", {}, rows)));
  return h("div", { class: "table-outer" }, wrap);
}

// Fade the right edge while columns are hidden off to the right.
function updateScrollCue() {
  const wrap = document.querySelector("#results .table-wrap");
  if (!wrap) return;
  const hidden = wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft > 2;
  wrap.parentElement.classList.toggle("more-right", hidden);
}

// ---------- stats page ----------

async function loadStats() {
  const tab = $("stats-tab").value;
  let s;
  try {
    s = await api("/api/stats", new URLSearchParams({ tab, top: 15 }));
  } catch (e) {
    $("stats").replaceChildren(h("div", { class: "error" }, e.message));
    return;
  }
  const link = (partial) => searchHref({ tab, ...partial });
  const tile = (value, label, href) => h("div", { class: "tile" },
    h("div", { class: "v" }, href ? h("a", { href }, value) : value), h("div", { class: "k" }, label));

  // Width set through the CSSOM: the content security policy blocks style="" attributes.
  const fill = (fraction) => {
    const el = h("span", { class: "fill" });
    el.style.width = `calc((100% - 3.5em - 16px) * ${fraction})`;
    return el;
  };
  const bars = (title, rows) => {
    const max = Math.max(1, ...rows.map((r) => r.count));
    return h("section", { class: "stat-block" }, h("h2", {}, title), h("div", { class: "bars" },
      rows.map((r) => h("a", { class: "bar", href: r.href, title: `Search: ${r.name}` },
        // The fill spans the name column only, so it never runs under the number.
        fill(r.count / max),
        h("span", { class: "name" }, r.name, r.unconfirmed ? h("span", { class: "u" }, `${r.unconfirmed} unconfirmed`) : null),
        h("span", { class: "n" }, r.count.toLocaleString()),
      )),
    ));
  };

  const buildRows = s.builds.map(([name, count]) => {
    const [kind, platform] = name.split(" ");
    return { name, count, href: link({ q: platform, category: [kind === "Missing" ? "Missing Builds" : "Missing Updates"] }) };
  });

  $("stats").replaceChildren(
    h("div", { class: "tiles" },
      tile(s.games.toLocaleString(), "games listed", link({})),
      tile(s.issues.toLocaleString(), "issues"),
      tile(s.unconfirmed, "unconfirmed issues", link({ unconfirmed: true })),
      tile(s.special_mentions, "special mentions", link({ special: true })),
      s.worst && h("div", { class: "tile" },
        h("div", { class: "v small" }, h("a", { href: link({ q: s.worst[0] }) }, s.worst[0])),
        h("div", { class: "k" }, `worst offender · ${plural(s.worst[1], "issue")}`)),
      s.games_without_issues > 0 && tile(s.games_without_issues, "listed with no issues"),
    ),
    h("div", { class: "stat-grid" },
      bars("Issues by category", s.categories.map(([name, count, unconfirmed]) =>
        ({ name, count, unconfirmed, href: link({ category: [name] }) }))),
      bars("Missing languages", s.languages.filter(([, n]) => n > 0).map(([name, count]) =>
        ({ name, count, href: link({ q: name, category: ["Missing Languages"] }) }))),
      bars("Mac & Linux builds", buildRows),
      bars("Top publishers", s.publishers.map(([name, count]) => ({ name, count, href: link({ publisher: name }) }))),
      bars("Top developers", s.developers.map(([name, count]) => ({ name, count, href: link({ developer: name }) }))),
    ),
  );
}

// ---------- problems page ----------

async function loadProblems(kind) {
  try {
    problemsCache = problemsCache || (await api("/api/problems")).problems;
  } catch (e) {
    $("problems").replaceChildren(h("div", { class: "error" }, e.message));
    return;
  }
  const counts = {};
  problemsCache.forEach((p) => { counts[p.kind] = (counts[p.kind] || 0) + 1; });
  const chip = (k, label, n) => h("a", {
    class: "chip", href: k ? `#problems?kind=${encodeURIComponent(k)}` : "#problems",
    "aria-current": kind === k ? "true" : null,
  }, label, h("span", { class: "n" }, n));
  $("problem-kinds").replaceChildren(
    chip("", "All", problemsCache.length),
    ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => chip(k, k, n)),
  );
  const shown = problemsCache.filter((p) => !kind || p.kind === kind);
  if (!shown.length) {
    $("problems").replaceChildren(h("p", {}, "No problems found."));
    return;
  }
  $("problems").replaceChildren(h("div", { class: "table-wrap problems" }, h("table", {},
    h("thead", {}, h("tr", {}, ["Problem", "Tab", "Sheet row", "Title", "Detail"].map((t) => h("th", {}, t)))),
    h("tbody", {}, shown.map((p) => h("tr", {},
      h("td", { class: "kind" }, p.kind),
      h("td", {}, p.tab),
      h("td", { class: "num" }, p.sheet_row),
      h("td", {}, p.title ? h("a", { href: searchHref({ q: p.title, tab: p.tab }) }, p.title) : "—"),
      h("td", {}, p.detail),
    ))),
  )));
}

// ---------- title checks page ----------

const TAB_NAMES = { active: "Main", removed: "Removed" };

function copyButton(text) {
  const btn = h("button", { type: "button", class: "link copy" }, "Copy as text");
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => { btn.textContent = "Copy as text"; }, 1800);
  });
  return btn;
}

const fixButton = (x) => h("button", { type: "button", class: "link fix", onclick: () => openEditor(x.title) }, "Fix cover");

async function loadTitles() {
  let t;
  try {
    t = await api("/api/titles");  // not cached: covers/index.json can change while the page is open
  } catch (e) {
    $("titles").replaceChildren(h("div", { class: "error" }, e.message));
    return;
  }
  if (!t.checked) {
    $("titles").replaceChildren(h("p", {}, "No titles checked yet. Run ", h("code", {}, "gogsearch covers"), " first."));
    return;
  }
  const where = (x) => `${TAB_NAMES[x.tab]} tab, row ${x.sheet_row}`;
  const ref = (x) => h("span", { class: "ref" }, h("span", { class: "tab-name" }, TAB_NAMES[x.tab]), ` row ${x.sheet_row}`);
  const titleLink = (x, content) => h("a", { href: searchHref({ q: x.title, tab: x.tab }) }, content);
  const parts = (list, tag) => list.map(([text, changed]) => (changed ? h(tag, {}, text) : text));
  const section = (heading, note, items, text, row) => h("section", { class: "title-section" },
    h("div", { class: "section-head" }, h("h2", {}, heading, h("span", { class: "n" }, items.length)),
      items.length ? copyButton(text) : null),
    h("p", { class: "hint" }, note),
    items.length ? h("ul", { class: "title-list" }, items.map(row)) : h("p", {}, "None."),
  );

  $("titles").replaceChildren(
    h("p", { class: "summary" }, `${t.checked.toLocaleString()} of ${plural(t.titles, "title")} checked against GOG, and Steam where GOG doesn't list the game.`),
    section("Named differently on the store",
      "Probably typos in the sheet: a nearly identical title from the same developer or publisher, or a name fixed by hand in overrides.json.",
      t.differ,
      t.differ.map((x) => `${where(x)}: "${x.title}" -> GOG: "${x.store_title}"`).join("\n"),
      (x) => h("li", {}, ref(x), h("span", { class: "pair" },
        titleLink(x, parts(x.sheet_parts, "del")), h("span", { class: "arrow", "aria-label": "store has" }, "→"),
        h("span", {}, parts(x.store_parts, "ins"))), fixButton(x))),
    section("Not found on GOG or Steam",
      "Series or bundle rows, delisted games, or names that differ by more than a typo. They may still be correct as written.",
      t.missing,
      t.missing.map((x) => `${where(x)}: "${x.title}"`).join("\n"),
      (x) => h("li", {}, ref(x), titleLink(x, x.title), fixButton(x))),
  );
}

// ---------- credits page ----------

async function loadCredits() {
  let c;
  try {
    c = await api("/api/credits");
  } catch (e) {
    $("credits").replaceChildren(h("div", { class: "error" }, e.message));
    return;
  }
  const item = (x) => h("li", {}, safeUrl(x.url)
    ? h("a", { href: safeUrl(x.url), target: "_blank", rel: "noopener noreferrer" }, x.label)
    : x.label);
  const section = (heading, note, list, cls = null) => list.length > 0 && h("section", {},
    h("h2", {}, heading), note && h("p", { class: "hint" }, note), h("ul", { class: cls }, list.map(item)));
  $("credits").replaceChildren(...[
    h("section", {},
      h("h2", {}, "The list"),
      h("p", {}, "Everything on this site comes from ",
        h("a", { href: c.sheet_url, target: "_blank", rel: "noopener noreferrer" }, "Games that treat GOG customers as 2nd Class"),
        ", a Google Sheet kept up to date by volunteers from the GOG community. Reports come in through the GOG forum thread linked below."),
      h("p", { class: "hint" }, "This site is an unofficial, personal search tool. It isn't made by or affiliated with GOG or the list's maintainers."),
    ),
    section("Maintainers", "GOG usernames, as credited in the sheet.", c.maintainers, "names"),
    section("Links from the sheet", null, c.links),
    section("Sources the maintainers use", null, c.sources),
    h("section", {},
      h("h2", {}, "Cover art"),
      h("p", {}, "Cover images belong to their publishers. They come from GOG's catalogue, or the Steam store for games GOG doesn't sell, and a few were picked by hand."),
    ),
    !c.maintainers.length && h("p", { class: "hint" }, "No credits in the database yet; run gogsearch fetch or import to read them from the sheet."),
  ].filter(Boolean));
}

// ---------- cover editor ----------

const HOW = {
  "gog-exact": "Matched on GOG",
  "gog-title-only": "Matched on GOG by title only",
  "gog-prefix": "Matched on GOG (store title is longer)",
  "gog-fuzzy": "Matched on GOG (near spelling)",
  "steam-exact": "Matched on Steam",
  override: "Set by hand",
  none: "No cover found",
};

let editing = null;   // { title, pending: { override, label } | null }

function describeOverride(o) {
  if (!o) return null;
  if (o.search) return `Searches the stores for “${o.search}”`;
  if (o.steam) return `Uses Steam app ${o.steam}`;
  if (o.url) return "Uses an image URL";
  return "No cover";
}

function editorStatus(text, isError = false) {
  $("ed-status").textContent = text;
  $("ed-status").classList.toggle("bad", isError);
}

function renderEditorCurrent(c) {
  const how = c.how ? HOW[c.how] || c.how : "Not looked up yet";
  $("ed-current").replaceChildren(
    c.cover ? h("img", { class: "ed-cover", src: c.cover, alt: "Current cover" })
      : h("div", { class: "ed-cover none" }, "No cover"),
    h("div", {},
      h("div", {}, how, c.store_title && c.store_title !== c.title ? [": ", h("b", {}, c.store_title)] : null),
      c.override && h("div", { class: "hint" }, `Override: ${describeOverride(c.override)}`)),
  );
  $("ed-remove").hidden = !c.override;
}

function choose(pending, selected = null) {
  editing.pending = pending;
  document.querySelectorAll(".ed-results .pick").forEach((b) => b.setAttribute("aria-pressed", b === selected));
  $("ed-save").disabled = false;
  editorStatus(pending.label);
}

async function openEditor(title) {
  editing = { title, pending: null };
  $("ed-title").textContent = title;
  $("ed-current").replaceChildren();
  $("ed-results").replaceChildren();
  $("ed-url").value = "";
  $("ed-save").disabled = true;
  editorStatus("");
  if (!$("editor").open) $("editor").showModal();
  try {
    const c = await api("/api/cover", new URLSearchParams({ title }));
    renderEditorCurrent(c);
    $("ed-q").value = c.store_title || title;
  } catch (e) {
    editorStatus(e.message, true);
  }
  $("ed-q").focus();
}

async function storeSearch() {
  const q = $("ed-q").value.trim();
  if (!q) return;
  editorStatus("Searching GOG and Steam…");
  $("ed-results").replaceChildren();
  let body;
  try {
    body = await api("/api/store-search", new URLSearchParams({ q }));
  } catch (e) {
    editorStatus(e.message, true);
    return;
  }
  if (!editing) return;  // closed while searching
  editing.pending = null;
  $("ed-save").disabled = true;
  editorStatus(body.results.length ? "Pick the right game, then Save." : "Nothing found. Try another name.");
  $("ed-results").replaceChildren(...body.results.map((r) => {
    const store = r.store === "gog" ? "GOG" : "Steam";
    const btn = h("button", { type: "button", class: "pick", "aria-pressed": "false" },
      // Candidate images load straight from the store's image server; only the saved one is cached.
      h("img", { src: r.image, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }),
      h("span", { class: "pick-title" }, r.title),
      h("span", { class: "pick-meta" }, h("span", { class: `store ${r.store}` }, store), r.companies && ` ${r.companies}`));
    btn.addEventListener("click", () => choose({ override: r.override, label: `Use ${store}: ${r.title}` }, btn));
    return btn;
  }));
}

async function saveOverride() {
  if (!editing?.pending) return;
  const { title } = editing;
  $("ed-save").disabled = true;
  editorStatus("Saving and fetching the cover…");
  try {
    const res = await fetch("/api/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, override: editing.pending.override }),
    });
    const c = await res.json();
    if (!res.ok) throw new Error(c.error || res.statusText);
    editing.pending = null;
    document.querySelectorAll(".ed-results .pick").forEach((b) => b.setAttribute("aria-pressed", "false"));
    renderEditorCurrent(c);
    editorStatus(c.cover ? "Saved." : "Saved, but that choice gave no cover.", !c.cover && !c.override?.none);
    // Show the new cover wherever this game is on screen.
    results.games.forEach((g) => { if (g.title === title) g.cover = c.cover; });
    const page = parseHash().page;
    if (page === "search") renderResults();
    else if (page === "titles") loadTitles();
  } catch (e) {
    editorStatus(`Not saved: ${e.message}`, true);
    $("ed-save").disabled = false;
  }
}

function setupEditor() {
  $("ed-search").addEventListener("submit", (e) => { e.preventDefault(); storeSearch(); });
  $("ed-url-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = $("ed-url").value.trim();
    if (!/^https:\/\//i.test(url)) { editorStatus("The image URL must start with https://", true); return; }
    choose({ override: { url }, label: "Use this image URL" });
  });
  $("ed-none").addEventListener("click", () => choose({ override: { none: true }, label: "Show no cover for this game" }));
  $("ed-remove").addEventListener("click", () => choose({ override: null, label: "Remove the override and match automatically" }));
  $("ed-save").addEventListener("click", saveOverride);
  $("editor").addEventListener("close", () => { editing = null; });
}

// ---------- setup ----------

async function init() {
  let meta;
  try {
    meta = await api("/api/meta");
  } catch (e) {
    const what = DATA_FILE ? "Could not load the list" : "Could not reach the server";
    document.querySelector("main").prepend(h("div", { class: "error" }, `${what}: ${e.message}`));
    return;
  }
  CATEGORIES = meta.categories;
  READ_ONLY = meta.read_only;
  document.querySelectorAll("[data-editing]").forEach((el) => { el.hidden = READ_ONLY; });
  $("raw").closest("label").hidden = Boolean(DATA_FILE);  // FTS syntax needs the server's SQLite
  $("filters").addEventListener("submit", (e) => e.preventDefault());
  const m = meta.meta;
  $("sheet-date").textContent = [m.last_update && `Sheet updated ${m.last_update}`,
    m.last_reviewed_post && `forum post ${m.last_reviewed_post}`].filter(Boolean).join(" · ");
  $("sheet-date").title = `Imported ${m.imported_at || "?"} from ${m.source_file || "?"}`;

  $("categories").replaceChildren(...CATEGORIES.map((c) => h("button", {
    type: "button", class: `chip ${catClass(c)}`, "data-category": c, "aria-pressed": "false",
    onclick: (e) => {
      const b = e.currentTarget;
      b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true");
      readForm();
    },
  }, shortCategory(c))));

  for (const id of ["q", "publisher", "developer"]) $(id).addEventListener("input", readFormSoon);
  for (const id of ["raw", "tab", "unconfirmed", "special", "sort"]) $(id).addEventListener("change", readForm);
  $("clear").addEventListener("click", () => { location.hash = "#search"; });
  $("more").addEventListener("click", () => runSearch(true));
  $("stats-tab").addEventListener("change", () => { location.hash = `#stats?tab=${$("stats-tab").value}`; });
  document.querySelectorAll(".segmented button").forEach((b) => b.addEventListener("click", () => {
    setView(b.dataset.view);
    renderResults();
  }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !$("editor").open && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      if (parseHash().page !== "search") location.hash = "#search";
      $("q").focus();
    }
  });
  setupEditor();
  window.addEventListener("hashchange", route);
  window.addEventListener("resize", updateScrollCue);
  route();
}

init();

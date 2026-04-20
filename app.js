/* Meal Menu — fetches three published Google Sheets, renders today's
 * breakfast / lunch / dinner with photos and lets you swap day or look
 * the food up on Google Images.
 */
(() => {
  "use strict";

  const SHEETS = {
    breakfast: {
      label: "Breakfast",
      icon: "\u{1F95E}",
      pubBase:
        "https://docs.google.com/spreadsheets/d/e/2PACX-1vQAlRze_52a3tIEwh7S504rO9dDSpUs8PFo79tiOJxjJQc-nKKAK6MrcCj8_uakl8_MnrujU4aS8bXj",
    },
    lunch: {
      label: "Lunch",
      icon: "\u{1F957}",
      pubBase:
        "https://docs.google.com/spreadsheets/u/2/d/e/2PACX-1vRBl5DZC8B5QifnbVsFQDqZ0pLeoHL-TE2Z_3-WvzLSRtgjUQjn0jmTSI9IUMEqnufxPD7jP7Ky0y0z",
    },
    dinner: {
      label: "Dinner",
      icon: "\u{1F37D}\u{FE0F}",
      pubBase:
        "https://docs.google.com/spreadsheets/u/2/d/e/2PACX-1vSE_IkMGx1BOtazOic5f4Dcy_j6S4h_KSb-gsDNha4wf6wpgmN35aDCytFfD-cOoHpQyIF8f2g5UsQh",
    },
  };

  const CSV_TTL_MS = 30 * 60 * 1000; // 30 minutes
  const PHOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const STORAGE_PREFIX = "mealmenu:";

  const state = {
    week: {}, // { breakfast: parsedSheet, lunch: ..., dinner: ... }
    selectedDateKey: null,
    days: [], // unified list of {dateKey, weekday, label, isToday}
    searchQuery: "",
  };

  /* ----------------------------- DOM helpers ----------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* --------------------------------- CSV --------------------------------- */
  // Parses RFC-4180 style CSV with quoted fields, embedded commas and CRLF.
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
        } else if (c === ",") {
          row.push(field);
          field = "";
        } else if (c === "\n" || c === "\r") {
          if (c === "\r" && text[i + 1] === "\n") i++;
          row.push(field);
          field = "";
          rows.push(row);
          row = [];
        } else {
          field += c;
        }
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  /* ------------------------ Sheet shape -> meals ------------------------- */
  // Each sheet has the same shape:
  //   row 0: title
  //   somewhere in first ~6 rows: weekday row (MONDAY .. SUNDAY) and
  //   a date row (e.g. "April 20" or "April 20, 2026").
  // Subsequent rows are category labels in col 0 with one item per day in cols 1..7.
  const WEEKDAYS = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ];

  function findHeaderRows(rows) {
    let weekdayRow = -1;
    let dateRow = -1;
    for (let i = 0; i < Math.min(rows.length, 12); i++) {
      const upper = rows[i].map((c) => (c || "").trim().toUpperCase());
      const matches = WEEKDAYS.filter((d) => upper.includes(d)).length;
      if (matches >= 5 && weekdayRow === -1) {
        weekdayRow = i;
        dateRow = i + 1;
        break;
      }
    }
    return { weekdayRow, dateRow };
  }

  // Map a "April 20" style header into a real Date in the current year
  // (or following year if the date appears to have already passed by > 6 mo).
  function parseHeaderDate(text, today = new Date()) {
    if (!text) return null;
    const s = text.replace(/\s+/g, " ").trim();
    if (!s) return null;
    // Try Date.parse for "April 20, 2026"
    const explicit = new Date(s);
    if (!isNaN(explicit.getTime()) && /\d{4}/.test(s)) {
      return startOfDay(explicit);
    }
    // Pattern: "April 20" — assume current year, but if that's > 180 days in
    // the past, roll forward to next year.
    const m = s.match(
      /^([A-Za-z]+)[\s.]+([0-9]{1,2})(?:[a-z]{2})?(?:[,\s]+(\d{4}))?$/,
    );
    if (m) {
      const monthName = m[1];
      const day = parseInt(m[2], 10);
      const year = m[3] ? parseInt(m[3], 10) : today.getFullYear();
      const d = new Date(`${monthName} ${day}, ${year}`);
      if (isNaN(d.getTime())) return null;
      const todayMs = startOfDay(today).getTime();
      const diff = todayMs - d.getTime();
      if (!m[3] && diff > 180 * 86400000) d.setFullYear(year + 1);
      else if (!m[3] && diff < -180 * 86400000) d.setFullYear(year - 1);
      return startOfDay(d);
    }
    return null;
  }

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function parseSheet(rows) {
    const { weekdayRow, dateRow } = findHeaderRows(rows);
    if (weekdayRow < 0) return { columns: [], items: [] };

    const today = new Date();
    const weekdays = rows[weekdayRow] || [];
    const dates = rows[dateRow] || [];

    // Build column descriptors for each weekday column.
    const columns = [];
    for (let c = 0; c < weekdays.length; c++) {
      const wd = (weekdays[c] || "").trim();
      if (!WEEKDAYS.includes(wd.toUpperCase())) continue;
      const dateText = (dates[c] || "").trim();
      const date = parseHeaderDate(dateText, today);
      columns.push({
        col: c,
        weekday: capitalize(wd),
        dateText,
        date,
        dateKey: date ? dateKey(date) : null,
      });
    }

    // Body rows: skip header rows.
    const items = [];
    for (let r = dateRow + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((cell) => !cell || !cell.trim())) continue;
      const category = (row[0] || "").trim();
      for (const col of columns) {
        const raw = (row[col.col] || "").trim();
        if (!raw) continue;
        // Some cells contain stray dates left over in admin rows. Skip
        // anything that's just a "Month Day[, Year]" — never a real food.
        if (/^[A-Za-z]+\.?\s+\d{1,2}(?:,?\s+\d{4})?$/.test(raw)) continue;
        // Split items if multiple foods are joined by " / " or " & " — keep simple.
        items.push({
          dateKey: col.dateKey,
          weekday: col.weekday,
          category: cleanCategory(category),
          name: raw,
        });
      }
    }

    return { columns, items };
  }

  function cleanCategory(c) {
    if (!c) return "";
    // collapse multiple spaces and strip trailing markers
    let s = c.replace(/\s+/g, " ").trim();
    // some sheets have e.g. "SOUP         VEGETARIAN"
    s = s.replace(/\b(VEGETARIAN|VEG)$/i, "").trim();
    return s;
  }

  function capitalize(s) {
    if (!s) return s;
    return s[0].toUpperCase() + s.slice(1).toLowerCase();
  }

  /* ------------------------------- Fetching ------------------------------ */
  // Returns { text, fromCache }. If a cached copy exists (within TTL) it's
  // returned immediately; the caller can still request a network refresh via
  // `fetchSheetNetwork`.
  function fetchSheetCached(meal) {
    const cached = readCache(`${STORAGE_PREFIX}csv:${meal}`, CSV_TTL_MS);
    return cached ? { text: cached, fromCache: true } : null;
  }

  async function fetchSheetNetwork(meal) {
    const cacheKey = `${STORAGE_PREFIX}csv:${meal}`;
    const url = `${SHEETS[meal].pubBase}/pub?output=csv`;
    // Default browser cache is fine — the CSV endpoint advertises
    // `cache-control: private, max-age=300`, which skips redundant reloads.
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load ${meal} (${resp.status})`);
    const text = await resp.text();
    writeCache(cacheKey, text);
    return text;
  }

  function readCache(key, maxAgeMs) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.ts !== "number") return null;
      if (Date.now() - obj.ts > maxAgeMs) return null;
      return obj.value;
    } catch (_) {
      return null;
    }
  }

  function writeCache(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), value }));
    } catch (_) {
      /* quota exceeded — silently skip */
    }
  }

  /* ------------------------- Image lookup (Wikipedia) -------------------- */
  // Returns a thumbnail URL (or null) for a given food name. Cached per-name.
  async function lookupPhoto(name, attempt = 0) {
    const key = `${STORAGE_PREFIX}img:${name.toLowerCase()}:${attempt}`;
    const cached = readCache(key, PHOTO_TTL_MS);
    if (cached !== null) return cached || null;

    const candidates = photoCandidates(name);
    const candidate = candidates[attempt % candidates.length];
    const url = await wikipediaImageFor(candidate);
    writeCache(key, url || "");
    return url;
  }

  // Generate progressively simpler search queries to find an image.
  function photoCandidates(name) {
    const cleaned = name.replace(/\s*\([^)]*\)/g, "").trim();
    const list = [cleaned];
    // Drop adjectives we don't want as wiki search terms.
    const noVerbs = cleaned
      .replace(
        /\b(steamed|baked|roasted|grilled|fried|pulled|seared|sauteed|sautéed|stir[- ]fried|chef|hot|cold|cream of|crispy|gluten[- ]free|gf)\b/gi,
        "",
      )
      .replace(/\s+/g, " ")
      .trim();
    if (noVerbs && noVerbs !== cleaned) list.push(noVerbs);

    // Last word(s) — often the most identifiable food noun.
    const tokens = noVerbs.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) list.push(tokens.slice(-2).join(" "));
    if (tokens.length >= 1) list.push(tokens[tokens.length - 1]);
    return Array.from(new Set(list.map((s) => s.trim()).filter(Boolean)));
  }

  // Tiny concurrency limiter — keeps the browser from opening dozens of
  // parallel Wikipedia requests on a large screen.
  const photoQueue = { active: 0, max: 4, pending: [] };
  function runThrottled(fn) {
    return new Promise((resolve) => {
      const task = async () => {
        photoQueue.active++;
        try {
          resolve(await fn());
        } finally {
          photoQueue.active--;
          const next = photoQueue.pending.shift();
          if (next) next();
        }
      };
      if (photoQueue.active < photoQueue.max) task();
      else photoQueue.pending.push(task);
    });
  }

  async function wikipediaImageFor(query) {
    if (!query) return null;
    const url =
      "https://en.wikipedia.org/w/api.php?" +
      new URLSearchParams({
        action: "query",
        format: "json",
        formatversion: "2",
        prop: "pageimages",
        piprop: "thumbnail",
        pithumbsize: "480",
        generator: "search",
        gsrsearch: query + " food",
        gsrlimit: "1",
        gsrnamespace: "0",
        origin: "*",
      }).toString();
    return runThrottled(async () => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const data = await resp.json();
        const pages = data && data.query && data.query.pages;
        if (!pages || !pages.length) return null;
        const thumb = pages[0].thumbnail && pages[0].thumbnail.source;
        return thumb || null;
      } catch (_) {
        return null;
      }
    });
  }

  /* ----------------------------- Theme toggle ---------------------------- */
  const THEME_KEY = `${STORAGE_PREFIX}theme`;
  function applyStoredTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    updateThemeColorMeta();
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme");
    let next;
    if (cur === "dark") next = "light";
    else if (cur === "light") next = null; // back to auto
    else {
      // currently auto — flip relative to current OS preference
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      next = dark ? "light" : "dark";
    }
    if (next) {
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem(THEME_KEY, next);
    } else {
      document.documentElement.removeAttribute("data-theme");
      localStorage.removeItem(THEME_KEY);
    }
    updateThemeColorMeta();
  }
  function updateThemeColorMeta() {
    // matches our CSS values
    const isDark =
      document.documentElement.getAttribute("data-theme") === "dark" ||
      (!document.documentElement.getAttribute("data-theme") &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((m) => m.remove());
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", isDark ? "#0f1115" : "#fffaf3");
    document.head.appendChild(meta);
  }

  /* ----------------------------- iOS install ----------------------------- */
  function maybeShowIosInstall() {
    const ua = navigator.userAgent || "";
    const isIOS =
      /iPhone|iPod/.test(ua) ||
      /iPad/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    let dismissed = false;
    try {
      dismissed = !!localStorage.getItem(`${STORAGE_PREFIX}iosDismissed`);
    } catch (_) { /* private-mode storage: treat as not dismissed */ }
    const el = $("#ios-install");
    if (!el) return;
    if (!isIOS || isStandalone || dismissed) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    const dismiss = () => {
      el.hidden = true;
      try {
        localStorage.setItem(`${STORAGE_PREFIX}iosDismissed`, "1");
      } catch (_) { /* private-mode: just hide for this session */ }
    };

    // Use event delegation on the whole overlay so the tap target is always
    // the element the user sees — never a nested <svg>/<use> that swallows
    // the event. closest() walks up from the true target to the nearest
    // dismiss trigger.
    const onTap = (ev) => {
      const t = ev.target.closest(
        ".ios-close, .ios-dismiss, .ios-backdrop",
      );
      if (!t) return;
      ev.preventDefault();
      dismiss();
    };
    el.addEventListener("click", onTap);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !el.hidden) dismiss();
    });
  }

  /* -------------------------------- Render ------------------------------- */
  function buildDayList() {
    const seen = new Map();
    for (const meal of Object.keys(SHEETS)) {
      const sheet = state.week[meal];
      if (!sheet) continue;
      for (const col of sheet.columns) {
        if (!col.dateKey) continue;
        if (!seen.has(col.dateKey)) {
          seen.set(col.dateKey, {
            dateKey: col.dateKey,
            date: col.date,
            weekday: col.weekday,
          });
        }
      }
    }
    const days = Array.from(seen.values()).sort((a, b) =>
      a.dateKey.localeCompare(b.dateKey),
    );
    const todayKey = dateKey(new Date());
    days.forEach((d) => {
      d.isToday = d.dateKey === todayKey;
      d.isPast = d.dateKey < todayKey;
    });
    return days;
  }

  function renderDayTabs() {
    const tabs = $("#day-tabs");
    tabs.innerHTML = "";
    const todayKey = dateKey(new Date());
    for (const d of state.days) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "day-tab";
      if (d.isToday) btn.classList.add("is-today");
      if (d.dateKey === state.selectedDateKey) btn.classList.add("is-active");
      const label = d.isToday
        ? "Today"
        : d.dateKey === addDays(todayKey, 1)
        ? "Tomorrow"
        : d.weekday;
      btn.innerHTML = `${escapeHtml(label)}<small>${escapeHtml(
        formatShortDate(d.date),
      )}</small>`;
      btn.addEventListener("click", () => {
        state.selectedDateKey = d.dateKey;
        renderDayTabs();
        renderContent();
      });
      tabs.appendChild(btn);
    }
  }

  function addDays(key, n) {
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + n);
    return dateKey(date);
  }

  function formatShortDate(d) {
    if (!d) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function renderContent() {
    const root = $("#content");
    root.innerHTML = "";
    const day = state.days.find((d) => d.dateKey === state.selectedDateKey);
    if (!day) {
      root.innerHTML = `<div class="empty"><strong>No menu found.</strong> The published sheets may be empty.</div>`;
      return;
    }
    updateTodayLabel(day);

    const q = state.searchQuery.trim().toLowerCase();
    let totalRendered = 0;
    for (const meal of Object.keys(SHEETS)) {
      const sheet = state.week[meal];
      if (!sheet) continue;
      let items = sheet.items.filter((it) => it.dateKey === day.dateKey);
      if (q) items = items.filter((it) => it.name.toLowerCase().includes(q));
      if (!items.length) continue;
      totalRendered += items.length;
      root.appendChild(renderMealSection(meal, items));
    }
    if (totalRendered === 0) {
      root.appendChild(renderEmpty(q));
    }
  }

  function renderEmpty(q) {
    const div = document.createElement("div");
    div.className = "empty";
    if (q) {
      div.innerHTML = `<strong>No matches for &ldquo;${escapeHtml(
        q,
      )}&rdquo;</strong>Try a different search, or <a href="${googleImageUrl(
        q,
      )}" target="_blank" rel="noopener">look it up on Google Images</a>.`;
    } else {
      div.innerHTML = `<strong>No items for this day.</strong>The cafeteria may not be serving, or the sheet hasn't been updated yet.`;
    }
    return div;
  }

  function updateTodayLabel(day) {
    const label = $("#today-label");
    const todayKey = dateKey(new Date());
    const friendly = day.date
      ? day.date.toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        })
      : day.weekday;
    if (day.dateKey === todayKey) {
      label.textContent = `Today · ${friendly}`;
    } else if (day.dateKey === addDays(todayKey, 1)) {
      label.textContent = `Tomorrow · ${friendly}`;
    } else {
      label.textContent = friendly;
    }
  }

  function renderMealSection(meal, items) {
    const tpl = $("#tpl-meal-section").content.cloneNode(true);
    const section = tpl.querySelector(".meal-section");
    section.querySelector(".meal-title").textContent = `${SHEETS[meal].icon} ${SHEETS[meal].label}`;
    section.querySelector(".meal-count").textContent = `${items.length} item${
      items.length === 1 ? "" : "s"
    }`;
    const grid = section.querySelector(".meal-grid");
    for (const item of items) {
      grid.appendChild(renderCard(item));
    }
    return section;
  }

  function renderCard(item) {
    const tpl = $("#tpl-meal-card").content.cloneNode(true);
    const card = tpl.querySelector(".card");
    const photoBg = card.querySelector(".card-photo-bg");
    card.querySelector(".card-name").textContent = item.name;
    const cat = card.querySelector(".card-category");
    if (item.category) cat.textContent = item.category;
    else cat.remove();
    const link = card.querySelector(".google-link");
    link.href = googleImageUrl(item.name);
    link.title = `Search Google Images for ${item.name}`;

    const refetchBtn = card.querySelector(".refetch-btn");
    let attempt = 0;
    const loadPhoto = async () => {
      const url = await lookupPhoto(item.name, attempt);
      if (url) {
        photoBg.style.backgroundImage = `url(${JSON.stringify(url)})`;
        card.classList.add("has-photo");
      } else {
        card.classList.remove("has-photo");
      }
    };
    refetchBtn.addEventListener("click", () => {
      attempt += 1;
      loadPhoto();
    });
    // Defer image load until card is on screen.
    queueImage(card, loadPhoto);
    return card;
  }

  // Lazy-load image when card scrolls into view.
  const imgObserver =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries, obs) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                const fn = entry.target.__loadPhoto;
                if (fn) fn();
                obs.unobserve(entry.target);
              }
            }
          },
          { rootMargin: "200px" },
        )
      : null;

  function queueImage(el, fn) {
    if (imgObserver) {
      el.__loadPhoto = fn;
      imgObserver.observe(el);
    } else {
      fn();
    }
  }

  function googleImageUrl(name) {
    return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(
      name,
    )}`;
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c]),
    );
  }

  /* ---------------------------------- Boot ------------------------------- */
  async function load(force = false) {
    const root = $("#content");
    if (force) {
      for (const m of Object.keys(SHEETS)) {
        localStorage.removeItem(`${STORAGE_PREFIX}csv:${m}`);
      }
    }

    // 1. Render instantly from cache when we have one (stale-while-revalidate).
    let renderedFromCache = false;
    if (!force) {
      const cached = {};
      let have = 0;
      for (const m of Object.keys(SHEETS)) {
        const c = fetchSheetCached(m);
        if (c) {
          cached[m] = parseSheet(parseCSV(c.text));
          have++;
        }
      }
      if (have) {
        applyWeek(cached);
        renderedFromCache = true;
      }
    }

    if (!renderedFromCache) {
      root.innerHTML = `<div class="loader"><div class="spinner"></div><p>Fetching today's menu…</p></div>`;
    }

    // 2. Refresh over the network in parallel; swap each sheet in as it lands.
    try {
      const pending = Object.keys(SHEETS).map(async (m) => {
        try {
          const text = await fetchSheetNetwork(m);
          state.week[m] = parseSheet(parseCSV(text));
          state.days = buildDayList();
          if (!state.selectedDateKey) {
            state.selectedDateKey = pickDefaultDay();
          }
          renderDayTabs();
          renderContent();
        } catch (e) {
          console.warn("Failed to load", m, e);
          if (!state.week[m]) state.week[m] = null;
        }
      });
      await Promise.all(pending);
      if (!state.days.length) {
        root.innerHTML = `<div class="error"><h2>No data found.</h2><p>The published menu sheets are empty or unreachable.</p></div>`;
      }
    } catch (err) {
      if (!renderedFromCache) {
        root.innerHTML = `<div class="error"><h2>Couldn't load menu.</h2><p>${escapeHtml(
          err.message || String(err),
        )}</p></div>`;
      }
    }
  }

  function applyWeek(week) {
    state.week = Object.assign({}, state.week, week);
    state.days = buildDayList();
    if (!state.days.length) return;
    if (!state.selectedDateKey) state.selectedDateKey = pickDefaultDay();
    renderDayTabs();
    renderContent();
  }

  function pickDefaultDay() {
    const todayKey = dateKey(new Date());
    const today = state.days.find((d) => d.dateKey === todayKey);
    const fallback = state.days.find((d) => !d.isPast) || state.days[0];
    return (today || fallback).dateKey;
  }

  function wireUp() {
    $("#theme-toggle").addEventListener("click", toggleTheme);
    $("#refresh-btn").addEventListener("click", () => load(true));
    const search = $("#search");
    let t;
    search.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.searchQuery = search.value;
        renderContent();
      }, 120);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && search.value.trim()) {
        window.open(googleImageUrl(search.value.trim()), "_blank", "noopener");
      }
    });
    $("#google-search-btn").addEventListener("click", () => {
      const q = search.value.trim();
      if (q) {
        window.open(googleImageUrl(q), "_blank", "noopener");
      } else {
        search.focus();
      }
    });
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", updateThemeColorMeta);

    const sourceLink = $("#open-source");
    if (sourceLink) {
      // links to the dinner sheet by default; user can navigate to others
      sourceLink.href = `${SHEETS.dinner.pubBase}/pubhtml`;
    }
  }

  applyStoredTheme();
  wireUp();
  maybeShowIosInstall();
  load();

  // Register service worker for offline / installability.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
})();

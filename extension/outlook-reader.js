// Pinger — reads Outlook on the web as you use it and hands what is on screen to the Pinger app
// running on this computer (http://localhost:4317). Nothing is sent anywhere else.
//
// It reads only what Outlook has already drawn: the message-list rows that are loaded and the
// conversation you have open. It never opens a message itself (that would mark it as read).
// When you ask Pinger to "Scan inbox", it scrolls the message list, then scrolls it back.
//
// All interpretation (who sent what, dates, subjects) happens in the Pinger app; this file only
// collects text, so it stays small and survives Outlook redesigns as well as possible.

(() => {
  if (window.top !== window || window.__pingerOutlookReader) return;
  window.__pingerOutlookReader = true;

  const MAX_ROWS = 250;
  const SETTLE_MS = 1200;
  const HEARTBEAT_MS = 10_000;
  const OFFLINE_RETRY_MS = 30_000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = (s, n) => {
    const t = String(s || '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return t.length > n ? t.slice(0, n) : t;
  };
  const textOf = (el) => (el ? el.innerText || el.textContent || '' : '');

  /* ------------------------------------------------------------- locale */

  function localeInfo() {
    const lang = document.documentElement.lang || navigator.language || undefined;
    const info = { order: 'MDY', weekdays: [], weekdaysLong: [], yesterday: '', today: '' };
    try {
      const parts = new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(2026, 10, 22));
      info.order = parts
        .filter((p) => ['year', 'month', 'day'].includes(p.type))
        .map((p) => p.type[0].toUpperCase())
        .join('');
      const short = new Intl.DateTimeFormat(lang, { weekday: 'short' });
      const long = new Intl.DateTimeFormat(lang, { weekday: 'long' });
      for (let i = 0; i < 7; i++) {
        const d = new Date(2026, 10, 22 + i); // 22 November 2026 is a Sunday
        info.weekdays.push(short.format(d));
        info.weekdaysLong.push(long.format(d));
      }
      const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
      info.yesterday = rtf.format(-1, 'day');
      info.today = rtf.format(0, 'day');
    } catch {
      /* the app falls back to English */
    }
    return info;
  }

  /* ------------------------------------------------------------ finding */

  function readingPane() {
    return (
      document.querySelector(
        '#ReadingPaneContainerId, [id^="ReadingPaneContainer"], [data-app-section="ConversationContainer"], [aria-label="Reading Pane" i]',
      ) || null
    );
  }

  function listRowElements(pane) {
    const found = [];
    const seen = new Set();
    const add = (el) => {
      if (!el || seen.has(el)) return;
      if (el.closest('[role="tree"], [role="menu"], [role="dialog"]')) return;
      if (pane && pane.contains(el)) return;
      seen.add(el);
      found.push(el);
    };
    for (const el of document.querySelectorAll('[data-convid]')) {
      if (el.parentElement && el.parentElement.closest('[data-convid]')) continue; // use the outermost
      add(el.closest('[role="option"], [role="row"]') || el);
    }
    if (!found.length) {
      // No conversation ids: fall back to a list whose items look like message rows.
      for (const box of document.querySelectorAll('[role="listbox"], [role="grid"]')) {
        const opts = [...box.querySelectorAll('[role="option"], [role="row"]')];
        const rowLike = (o) => textOf(o).split('\n').filter((l) => l.trim()).length >= 2;
        if (opts.length >= 3 && opts.slice(0, 3).every(rowLike)) {
          opts.forEach(add);
          break;
        }
      }
    }
    return found.slice(0, MAX_ROWS);
  }

  function rowData(row) {
    const convEl = row.matches('[data-convid]') ? row : row.querySelector('[data-convid]');
    const option = row.matches('[role="option"]') ? row : row.querySelector('[role="option"]');
    return {
      convId: clip(convEl ? convEl.getAttribute('data-convid') : '', 400),
      aria: clip((option || row).getAttribute('aria-label') || '', 1500),
      lines: textOf(row)
        .split('\n')
        .map((l) => clip(l, 600))
        .filter(Boolean)
        .slice(0, 12),
      titles: [...row.querySelectorAll('[title]')]
        .map((e) => clip(e.getAttribute('title'), 300))
        .filter(Boolean)
        .slice(0, 20),
      selected: row.getAttribute('aria-selected') === 'true' || !!row.querySelector('[aria-selected="true"]'),
    };
  }

  function openConversation(pane) {
    const root = pane || document.querySelector('[role="main"]');
    if (!root) return null;
    let bodies = [...root.querySelectorAll('[role="document"], [aria-label="Message body" i]')].filter(
      (b) => !b.querySelector('[data-convid], [role="option"]') && textOf(b).length < 60_000,
    );
    bodies = bodies.filter((b) => !bodies.some((o) => o !== b && o.contains(b)));
    if (!bodies.length) return null;

    const messages = [];
    for (const body of bodies.slice(0, 20)) {
      const bodyText = textOf(body);
      // Climb to the smallest container that also holds this message's header, but no other body.
      let box = body;
      let chosen = null;
      for (let i = 0; i < 10; i++) {
        const up = box.parentElement;
        if (!up || up === root.parentElement) break;
        if (bodies.some((o) => o !== body && up.contains(o))) break;
        box = up;
        if (textOf(box).length - bodyText.length > 20) {
          chosen = box;
          break;
        }
      }
      box = chosen || box;
      const full = textOf(box);
      const at = bodyText ? full.indexOf(bodyText.slice(0, 40)) : -1;
      const header = at > 0 ? full.slice(0, at) : full.replace(bodyText, '');
      const outside = (el) => !body.contains(el);
      messages.push({
        header: clip(header, 2000),
        titles: [...box.querySelectorAll('[title]')]
          .filter(outside)
          .map((e) => clip(e.getAttribute('title'), 300))
          .filter(Boolean)
          .slice(0, 30),
        labels: [...box.querySelectorAll('[aria-label]')]
          .filter(outside)
          .map((e) => clip(e.getAttribute('aria-label'), 300))
          .filter((l) => l && l.length < 300)
          .slice(0, 30),
        body: clip(bodyText, 12_000),
      });
    }
    const heading = root.querySelector('[role="heading"]');
    return { subject: clip(textOf(heading), 500), messages };
  }

  function folder() {
    const sel = document.querySelector('[role="tree"] [role="treeitem"][aria-selected="true"]');
    return { path: clip(location.pathname, 300), label: clip(sel ? sel.getAttribute('title') || textOf(sel) : '', 100) };
  }

  function snapshot() {
    const pane = readingPane();
    return {
      url: clip(location.origin + location.pathname, 500),
      title: clip(document.title, 300),
      folder: folder(),
      locale: localeInfo(),
      rows: listRowElements(pane).map(rowData),
      open: openConversation(pane),
    };
  }

  /* -------------------------------------------------------- diagnostics */

  // An outline of the page for fixing Pinger when Outlook changes: element names, roles and
  // attribute names only. No text and no attribute values that could carry message content.
  function outline(el, depth = 0, budget = { n: 400 }) {
    if (!el || depth > 10 || budget.n-- <= 0) return null;
    const node = {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      id: el.id || '',
      section: el.getAttribute('data-app-section') || '',
      level: Number(el.getAttribute('aria-level')) || undefined,
      attrs: [...el.attributes]
        .map((a) => a.name)
        .filter((n) => n !== 'class' && n !== 'style')
        .slice(0, 20),
      textLen: textOf(el).length,
      kids: [],
    };
    for (const child of el.children) {
      const k = outline(child, depth + 1, budget);
      if (k) node.kids.push(k);
      if (node.kids.length >= 30) break;
    }
    return node;
  }

  function structure() {
    const pane = readingPane();
    const firstRow = listRowElements(pane)[0];
    const landmarks = [...document.querySelectorAll('[role="main"], [role="region"], [role="navigation"], [role="listbox"], [data-app-section]')]
      .slice(0, 40)
      .map((el) => outline(el, 9));
    return {
      tag: 'page',
      kids: [
        { tag: 'first-row', kids: firstRow ? [outline(firstRow)] : [] },
        { tag: 'reading-pane', kids: pane ? [outline(pane)] : [] },
        { tag: 'landmarks', kids: landmarks.filter(Boolean) },
      ],
    };
  }

  /* ---------------------------------------------------------- talking */

  let lastJson = '';
  let lastSentAt = 0;
  let offlineUntil = 0;
  let wantStructure = false;

  async function post(extra) {
    try {
      return await chrome.runtime.sendMessage({ type: 'pinger:outlook', payload: { ext: chrome.runtime.getManifest().version, ...extra } });
    } catch {
      return null; // the extension was reloaded or removed
    }
  }

  async function send(force = false) {
    const now = Date.now();
    if (!force && now < offlineUntil) return null;
    let snap = null;
    try {
      snap = snapshot();
    } catch {
      /* the page is mid-update; try again next time */
    }
    const json = snap ? JSON.stringify(snap) : '';
    const unchanged = json === lastJson;
    if (unchanged && !force && !wantStructure && now - lastSentAt < HEARTBEAT_MS) return null;

    const extra = unchanged ? { unchanged: true } : { snapshot: snap };
    if (wantStructure) {
      try {
        extra.structure = structure();
      } catch {
        /* send what we have */
      }
    }
    lastSentAt = now;
    const res = await post(extra);
    if (!res || res.offline) {
      offlineUntil = now + OFFLINE_RETRY_MS;
      lastJson = '';
      return res;
    }
    lastJson = json;
    wantStructure = !!res.diagnose;
    if (wantStructure) setTimeout(() => send(true), 300);
    if (res.scan) scan();
    return res;
  }

  /* ------------------------------------------------------------- scan */

  function listScroller() {
    const first = listRowElements(readingPane())[0];
    let el = first ? first.parentElement : null;
    while (el && el !== document.body) {
      const overflow = getComputedStyle(el).overflowY;
      if (/(auto|scroll|overlay)/.test(overflow) && el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement;
    }
    return null;
  }

  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    const box = listScroller();
    const start = box ? box.scrollTop : 0;
    let error = null;
    try {
      if (!box) {
        error = 'no-list';
        return;
      }
      box.scrollTop = 0;
      await sleep(700);
      await send(true);
      for (let i = 0; i < 60; i++) {
        const before = box.scrollTop;
        box.scrollTop = before + Math.max(200, Math.floor(box.clientHeight * 0.8));
        await sleep(900); // let Outlook draw the next rows
        const res = await send(true);
        if (!res || res.stopScan || box.scrollTop <= before) break;
      }
    } finally {
      if (box) box.scrollTop = start;
      scanning = false;
      await post({ scanFinished: true, scanError: error });
    }
  }

  /* -------------------------------------------------------------- loop */

  let pending = null;
  const soon = () => {
    if (pending) return; // a fixed delay, so constant small page updates can't starve it
    pending = setTimeout(() => {
      pending = null;
      if (!scanning) send(false);
    }, SETTLE_MS);
  };
  new MutationObserver(soon).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'data-convid'],
  });
  setInterval(() => {
    if (!scanning) send(false);
  }, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !scanning) send(true);
  });
  soon();
})();

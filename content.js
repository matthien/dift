// Content script: injected into the web page each time the shortcut is pressed.
// Jobs: read the highlighted word and where it is, draw the box, ask the
// background script for the definition and for audio playback.

// This file can be injected into the same page many times. Set things up
// only once, then just show the box on every injection (bottom of file).
if (!window.diftShow) {
  let host = null;          // the element we attach to the page
  let removeListeners = null;

  // ---------- Showing the box ----------

  window.diftShow = async function () {
    const selection = window.getSelection();
    const word = cleanWord(selection.toString());
    if (!word || selection.rangeCount === 0) return; // nothing highlighted: do nothing

    const anchor = getSelectionRect(selection);
    const sentenceStart = isSentenceStart(selection);
    closeBox(); // only one box at a time

    const box = createBox();
    box.append(el("div", "status loading", "Loading…"));
    positionBox(box, anchor);

    const reply = await browser.runtime.sendMessage({ type: "lookup", word, sentenceStart });
    if (!host) return; // closed while we were waiting

    box.replaceChildren(...renderReply(reply, word));
    addFade(box);
    positionBox(box, anchor); // height changed, so place it again
  };

  // A faded strip at the bottom of the box while there's more text below.
  // It hides once you've scrolled (inside the box) to the end.
  function addFade(box) {
    const fade = el("div", "fade");
    box.append(fade);
    const update = () => {
      fade.hidden = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
    };
    box.addEventListener("scroll", update, { passive: true });
    update(); // short entries that fit: no fade at all
  }

  // Scrolling with the mouse over the box should never move the page.
  // Long boxes: CSS `overscroll-behavior: contain` stops the scroll at the box's end.
  // Short boxes (nothing to scroll): that CSS doesn't apply, so cancel the wheel here.
  function containScroll(box) {
    box.addEventListener("wheel", (e) => {
      if (box.scrollHeight <= box.clientHeight) e.preventDefault();
    }, { passive: false }); // passive: false is required to be allowed to cancel it
  }

  // Is the highlighted word the first word of a sentence? Then its capital
  // letter is just grammar, and the background script prefers lowercase.
  // Looks at the text before the word, within its paragraph:
  //   ""                     -> start   (first word of the paragraph)
  //   "We walked home. "     -> start   (ends with . ! ? …)
  //   "We flew to "          -> middle  (anything else, including commas)
  function isSentenceStart(selection) {
    const range = selection.getRangeAt(0);

    // A second range from the start of the paragraph to the start of the highlight.
    const before = document.createRange();
    before.setStart(findBlock(range.startContainer), 0);
    before.setEnd(range.startContainer, range.startOffset);

    // If the highlight itself begins with punctuation, e.g. `"Fox`, count that as "before" too.
    const leading = selection.toString().match(/^[^\p{L}\p{N}]*/u)[0];

    // Ignore trailing spaces, quotes and brackets: `home." Fox` -> looks at the "."
    const text = (before.toString() + leading).replace(/[\s"'“”‘’«»()[\]{}]+$/u, "");
    return text === "" || /[.!?…]$/.test(text);
  }

  // The nearest paragraph-like element (p, li, h1, td, div…) around a node:
  // walk up past inline elements such as <b>, <a>, <span>.
  function findBlock(node) {
    let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (element && element !== document.body &&
           getComputedStyle(element).display.startsWith("inline")) {
      element = element.parentElement;
    }
    return element ?? document.body;
  }

  // Trim spaces and surrounding punctuation: "fox," -> "fox", "(word)" -> "word"
  function cleanWord(text) {
    return text.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  }

  // Where the highlighted text is on screen. Text inside <input>/<textarea>
  // has no usable rectangle, so fall back to the input box itself.
  function getSelectionRect(selection) {
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && document.activeElement) {
      return document.activeElement.getBoundingClientRect();
    }
    return rect;
  }

  // ---------- Building the box ----------

  function createBox() {
    host = document.createElement("div");
    // Shadow DOM: a walled-off area the page's CSS can't reach into.
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    const box = el("div", "box");
    containScroll(box);
    shadow.append(style, box);
    document.documentElement.append(host);
    addCloseListeners();
    return box;
  }

  function renderReply(reply, word) {
    if (!reply.ok) {
      const message = reply.error === "not-found"
        ? `No definition found for “${word}”.`
        : "Couldn't reach the dictionary. Check your connection.";
      return [el("div", "status", message)];
    }

    const { entry } = reply;
    const header = el("div", "header");
    header.append(el("span", "word", entry.word));

    if (entry.audio) {
      const play = el("button", "play", "▶");
      play.title = "Play pronunciation";
      play.addEventListener("click", () => {
        // Ask the background script to play it, where site rules can't block it.
        browser.runtime.sendMessage({ type: "play", url: entry.audio });
      });
      header.append(play);
    }

    const parts = [header];

    // "plural of leaf · plural of leave" under the title
    if (entry.notes?.length) parts.push(el("div", "note", entry.notes.join(" · ")));

    // The highlighted word's own meanings first, then each base word's.
    parts.push(...renderMeanings(entry.meanings));
    for (const form of entry.forms ?? []) {
      parts.push(el("div", "base", form.word));
      parts.push(...renderMeanings(form.meanings));
    }

    // Footer: where each part came from, e.g. "Definitions: Wiktionary"
    const footer = el("div", "sources");
    entry.sources.forEach((source, i) => {
      if (i > 0) footer.append(" · ");
      const link = el("a", null, source.name);
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener";
      footer.append(`${source.label}: `, link);
    });
    parts.push(footer);
    return parts;
  }

  // noun / 1. … 2. …  verb / 1. …
  function renderMeanings(meanings) {
    const parts = [];
    for (const meaning of meanings) {
      parts.push(el("div", "pos", meaning.partOfSpeech));
      const list = el("ol", "defs");
      for (const def of meaning.definitions) {
        const item = el("li", null, def.text);
        if (def.example) item.append(el("div", "example", `“${def.example}”`));
        list.append(item);
      }
      parts.push(list);
    }
    return parts;
  }

  // Small helper. Uses textContent (never innerHTML) so text from the API
  // is always shown as plain text and can't inject HTML into the page.
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---------- Placement ----------

  const GAP = 8;    // space between word and box
  const MARGIN = 8; // minimum space from the screen edges

  // Below the word; flip above if it would run off the bottom of the screen.
  function positionBox(box, anchor) {
    const { width, height } = box.getBoundingClientRect();
    let top = anchor.bottom + GAP;
    if (top + height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, anchor.top - GAP - height);
    }
    const left = Math.min(
      Math.max(MARGIN, anchor.left),
      window.innerWidth - width - MARGIN
    );
    box.style.top = `${top}px`;
    box.style.left = `${Math.max(MARGIN, left)}px`;
  }

  // ---------- Closing ----------

  function closeBox() {
    if (removeListeners) removeListeners();
    if (host) host.remove();
    host = null;
    removeListeners = null;
  }

  function addCloseListeners() {
    const isInsideBox = (event) => event.composedPath().includes(host);
    const onKey = (e) => { if (e.key === "Escape") closeBox(); };
    const onMouseDown = (e) => { if (!isInsideBox(e)) closeBox(); };
    const onScroll = (e) => { if (!isInsideBox(e)) closeBox(); }; // scrolling inside the box is fine

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("scroll", onScroll, true);
    removeListeners = () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }

  // ---------- Styles (live inside the Shadow DOM) ----------

  const STYLES = `
    .box {
      --bg: #ffffff; --text: #1f2328; --muted: #656d76; --border: #d0d7de; --accent: #e8590c;
      position: fixed;
      z-index: 2147483647;
      width: 340px;
      max-width: calc(100vw - 16px);
      max-height: 320px;
      overflow-y: auto;
      overscroll-behavior: contain; /* reaching the end doesn't scroll the page */
      box-sizing: border-box;
      padding: 12px 14px;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      text-align: left;
    }
    @media (prefers-color-scheme: dark) {
      .box { --bg: #1c2128; --text: #e6edf3; --muted: #9198a1; --border: #3d444d; --accent: #ff8a3d; }
    }
    .header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .word { font-size: 18px; font-weight: 600; }
    .play {
      border: 1px solid var(--border); background: transparent; color: var(--accent);
      border-radius: 50%; width: 26px; height: 26px; cursor: pointer; font-size: 11px; padding: 0;
    }
    .play:hover { border-color: var(--accent); }
    .pos { margin-top: 10px; font-style: italic; color: var(--accent); }
    .defs { margin: 4px 0 0; padding-left: 20px; }
    .defs li { margin-bottom: 4px; white-space: pre-line; } /* show line breaks between sub-meanings */
    .example { color: var(--muted); font-style: italic; }
    .status { color: var(--muted); }

    /* Spinning ring before "Loading…". Most lookups finish in a blink, so it fades
       in after a short delay instead of flashing on and off. */
    .loading { display: flex; align-items: center; gap: 8px; }
    .loading::before {
      content: ""; width: 12px; height: 12px; flex: none;
      border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%;
      opacity: 0;
      animation: dift-spin 0.7s linear infinite, dift-appear 0.2s ease-out 0.15s forwards;
    }
    @keyframes dift-spin { to { transform: rotate(360deg); } }
    @keyframes dift-appear { to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      .loading::before { animation: dift-appear 0.2s ease-out 0.15s forwards; }
    }
    .note { color: var(--muted); font-size: 13px; font-style: italic; }

    /* ─── leaf ───  header before each base word's meanings */
    .base {
      display: flex; align-items: center; gap: 8px;
      margin-top: 14px; font-weight: 600; color: var(--text);
    }
    .base::before, .base::after { content: ""; flex: 1; border-top: 1px solid var(--border); }
    .sources {
      margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border);
      font-size: 11px; color: var(--muted);
    }
    .sources a { color: inherit; text-decoration: underline; }
    .sources a:hover { color: var(--accent); }

    /* Sticks to the bottom edge of the box while scrolling. The negative margins
       stretch it over the box's padding and stop it from adding any height. */
    .fade {
      position: sticky;
      bottom: -12px;
      height: 44px;
      margin: -44px -14px 0;
      background: linear-gradient(to bottom, transparent, var(--bg) 85%);
      backdrop-filter: blur(1.5px);
      mask-image: linear-gradient(to bottom, transparent, black 60%);
      pointer-events: none; /* clicks pass through to the text underneath */
    }
    .fade[hidden] { display: none; }
  `;
}

window.diftShow();

# dift

Highlight a word on any page, press **Alt+Shift+D** (Option+Shift+D on Mac), and a box
with its definitions and a pronunciation button appears next to the word.

Definitions come from [Wiktionary](https://en.wiktionary.org); audio comes from
[dictionaryapi.dev](https://dictionaryapi.dev). If Wiktionary is down or doesn't have the
word, dictionaryapi.dev supplies the definitions too. Both are free and need no account.
Looked-up words are sent to both services. The box footer shows which source was used.

## Load it in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this folder.
3. After editing any file, click **Reload** on the dift card.

Temporary add-ons are removed when Firefox restarts; repeat step 2 to load it again.

To change the shortcut: `about:addons` → gear icon → **Manage Extension Shortcuts**.

## How it works

```
highlight word + press shortcut
  -> background.js   (commands.onCommand) injects content.js into the tab
  -> content.js      reads the word, its position, and whether it starts a sentence;
                     draws "Loading…" box
  -> content.js  --{type:"lookup", word, sentenceStart}-->  background.js
  -> background.js   asks Wiktionary (both "Paris" and "paris" if capitalized) +
                     dictionaryapi.dev, all at the same time (5 s limit each),
                     trims each response to one clean shape; for word forms ("foxes" =
                     "plural of fox") also looks up the base words; combines, replies
  -> content.js      fills the box
  -> click ▶  --{type:"play", url}-->  background.js plays the audio
```

| File | Job |
| --- | --- |
| `manifest.json` | Shortcut, permissions, which file is the background script |
| `background.js` | Shortcut handling, dictionary lookups (only file that knows the APIs' formats), combining sources, audio |
| `content.js` | Reads the selection, draws/positions/closes the box (inside a Shadow DOM) |

## Manual test checklist

- [ ] Common word (e.g. "fox"): box appears under the word, meanings grouped by part of speech, ▶ plays audio.
- [ ] Footer shows "Definitions: Wiktionary · Audio: dictionaryapi.dev"; links open in a new tab.
- [ ] Sentence start → lowercase preferred: "Fox tracks…" shows the animal; "The end." is found.
- [ ] Mid-sentence capital → kept: "flew to Paris" shows the city; "on Monday" is found.
- [ ] Acronym at sentence start ("NASA launched…") falls back to "NASA".
- [ ] Word forms: "foxes" shows note "plural of fox" and a ─── fox ─── section; "leaves" shows both leaf and leave; "running" shows its own meanings first, then run.
- [ ] dictionaryapi.dev down: Wiktionary definitions still appear within ~5 s, no ▶, footer shows only Wiktionary.
- [ ] Word with punctuation highlighted (e.g. `fox,`): looks up "fox".
- [ ] Rare word with no audio: no ▶ button.
- [ ] Made-up word ("blorptastic"): "No definition found".
- [ ] Nothing highlighted: shortcut does nothing.
- [ ] Word near the bottom of the screen: box flips above the word.
- [ ] Long entry (e.g. "set"): fade at the bottom; scrolling inside the box reveals more, doesn't close it, and the fade disappears at the end.
- [ ] Short entry: no fade; source footer fully visible.
- [ ] Scrolling with the mouse over the box never moves the page (long: stops at the end; short: nothing happens). Scrolling with the mouse outside the box scrolls the page and closes it.
- [ ] Escape, clicking outside, and scrolling the page each close the box.
- [ ] Wi-Fi off: "Couldn't reach the dictionary" message.
- [ ] Strict site (e.g. github.com): box looks normal and ▶ still plays.
- [ ] Dark mode: box uses dark colors.

Known limits: doesn't run on `about:` pages, addons.mozilla.org, or PDFs (Firefox blocks
extensions there). Multi-word phrases are sent as-is and usually aren't found.
Capitalization is guessed from position: a name at the start of a sentence ("Apple announced…")
or a heading that is only a name will show the lowercase word.

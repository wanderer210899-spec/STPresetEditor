# Testing guide — `claude/preset-editor-improvements-l6p4ug`

A step-by-step walkthrough for trying everything on this branch **without
deploying anything**. You only need to copy-paste the commands; each step says
what you should see. Three test setups, from simplest to most complete:

1. **The web app alone** — no cloud, 2 commands.
2. **A sandbox Cloudflare Worker on your own machine** — cloud sync, accounts,
   and API keys, all local; nothing touches the internet.
3. **The VS Code / Cursor extension** — installed from the prebuilt `.vsix`
   committed on this branch, optionally synced against the sandbox from step 2.

Plus an optional step 4: **deploy a real test Worker to Cloudflare straight
from this folder** — no "Deploy" button, no new GitHub repo.

---

## 0. One-time setup

You need two things installed:

- **Node.js** (LTS version, 20 or newer) — from <https://nodejs.org>. This gives
  you the `npm` and `npx` commands.
- **Git** — from <https://git-scm.com> (or use GitHub Desktop).

Check they work — open a terminal (on Windows: "Terminal" or "PowerShell") and
run:

```bash
node --version
git --version
```

Both should print a version number.

### Get this branch onto your computer

If you don't have the repository yet:

```bash
git clone https://github.com/wanderer210899-spec/STPresetEditor.git
cd STPresetEditor
git checkout claude/preset-editor-improvements-l6p4ug
npm install
```

If you already have it:

```bash
cd STPresetEditor
git fetch origin
git checkout claude/preset-editor-improvements-l6p4ug
git pull origin claude/preset-editor-improvements-l6p4ug
npm install
```

`npm install` takes a minute the first time. Warnings are fine; errors are not.

---

## 1. Test the web app (no cloud)

```bash
npm run dev
```

Open <http://localhost:5173> in your browser. Everything is stored in the
browser only — no account, no server. Press `Ctrl+C` in the terminal when done.

### What to try (the new features, phase by phase)

**Autosave + snapshots**

- Edit any prompt, then just close the tab and reopen — your edit is still
  there; autosave means you never lose work. A **Save** button in the toolbar is
  there when you want an explicit "saved ✓" (and, in the extension, to flush the
  file to disk now).
- Click **Snapshot** in the top toolbar (or press `Ctrl+S`) to freeze the
  current state. Open **Presets** (toolbar) — each saved preset shows its
  snapshots with a **Restore** button. Restore one, then press `Ctrl+Z`:
  even a restore is undoable.

**Search**

- The editor search box now matches prompt **content**, not just titles, and
  Enter/arrows step through matches. Typing stays responsive even on large
  presets, and there's an **× clear button** (or press `Esc`) to drop the filter
  and see every prompt again.
- Press `Ctrl+K` anywhere for **global search** across your whole saved-preset
  library; picking a result jumps to that prompt (loading the other preset if
  needed).
- Press `Ctrl+F` to jump into the editor search box.

**Look & feel**

- **Settings → Theme**: light / dark / system.
- Prompt cards show a **token estimate**; the toolbar shows the total.
- On desktop the editor uses borderless, Notion-style blocks — **click any title
  or body text to edit it in place**. The left **Prompt Library** and right
  **Details** panels are **collapsible**: use the two panel-toggle buttons in the
  toolbar (far left and far right) to hide either one and give the editor the
  full width — no drag handles.
- The Prompt Library lists prompts **in editor order** (matching the middle
  column), so it works as an overview/jump list rather than an alphabetical
  duplicate.
- On a phone (or a narrow window) the classic mobile layout with slide-in
  drawers still applies — worth checking.

**Variables (hover cards, panel, timeline)**

- Load the bundled example (it's there on first run) and hover any
  `{{setvar ...}}` / `{{getvar ...}}` macro: a card shows the variable's scope,
  operation, its **value at that exact point**, where it's defined, and how
  often it's used.
- Right pane → **Variables** tab: every variable with its **final value**.
  Click a row to highlight its uses; the arrows in the header walk through
  them one by one.
- Click a variable's name to open its details — including an **execution
  timeline** showing every read/write in order, with values, and "skipped"
  tags for disabled prompts.

**Undo/redo + shortcuts**

- Every structural change (add, delete, reorder, rename, enable/disable,
  batch replace, snapshot restore) is undoable: `Ctrl+Z` / `Ctrl+Y`, or the
  ↩ / ↪ toolbar buttons — hover them to see _what_ would be undone.
- Delete a prompt, undo — it returns to the exact same position.
- Press `?` (outside a text field) for the **keyboard shortcuts** overlay;
  also available under Settings → Keyboard shortcuts. Try `Ctrl+E`
  (raw ⇄ preview macros) and `Alt+↑/↓` (move the selected prompt).

---

## 2. Test cloud sync in a local sandbox (no deploy)

This runs the real Cloudflare Worker **on your machine** with a local database
— accounts, API keys, and sync all work, but nothing leaves your computer and
no Cloudflare account is needed.

```bash
npx wrangler d1 migrations apply stpreseteditor-auth --local
npm run cf-preview
```

(The first command creates the local login database — run it once. If wrangler
asks to install itself, answer yes; if it asks you to log in to Cloudflare for
`cf-preview`, there should be a "continue without" / local option — it runs in
local mode.)

Open the URL it prints (usually <http://localhost:8787>) and:

1. **Settings → Cloud sync → Create account** — any email + password (it's
   local; nothing is sent anywhere).
2. Edit something and watch the **sync dot** in the toolbar turn green.
3. Open the same URL in a **second browser** (or private window), sign in with
   the same account — your library is there. Edit on one side, and within ~30s
   (or on tab focus) the other side picks it up.
4. Edit the _same preset differently_ on both sides while one is offline-ish
   (e.g. pause before switching tabs) — you should get a **conflict prompt**
   asking which copy to keep, rather than silent data loss.
5. **Settings → Cloud sync → Generate key** — copy the `stpe_…` key somewhere;
   you'll use it in step 3 to connect the extension. (It's shown only once.)

Keep this terminal running if you're continuing to step 3; the extension can
sync against this same sandbox.

> Deploying for real later: follow **README.md → Private cloud sync
> (Cloudflare)** — the one-click deploy button provisions everything in your
> own Cloudflare account.

---

## 3. Test the VS Code / Cursor extension

### Install the prebuilt `.vsix`

The built extension is committed on this branch at
`extension/stpreseteditor-local-0.7.0.vsix`.

- Easiest: you already cloned the repo in step 0, so the file is on your disk.
- Or download it from GitHub: open the repository page → switch the branch
  dropdown to `claude/preset-editor-improvements-l6p4ug` → `extension` folder →
  click `stpreseteditor-local-0.7.0.vsix` → **Download raw file** (⬇ icon).

Then in VS Code or Cursor:

1. Open the **Extensions** panel (`Ctrl+Shift+X`).
2. Click the **`…`** menu at the top → **Install from VSIX…** → pick the file.
3. **Reload** when prompted.

> If you had an earlier build installed, install over it and Reload so you're
> testing 0.7.0.

### Try the editor (file mode)

- Open any folder containing preset `.json` files (tip: **copy** a few presets
  into a scratch folder first, e.g. from SillyTavern's
  `data/<user>/OpenAI Settings/`).
- Right-click a preset `.json` → **Open in STPresetEditor**. The panel should
  open **that exact file** every time. Open a second preset in the same window
  too — each panel keeps its own file.
- **Uninterrupted, full-width editor (new in 0.7.0)** — the panel opens as a
  single wide editor, even when docked narrow. **Click any title or body to edit
  in place** (this now works on the phone web build too). Clicking a prompt no
  longer makes the Details panel pop open and squish the editor — the editor
  keeps its full width. Open **Details / Variables** only when you want it, with
  the **ⓘ** button (top-right); open the **prompt library** with the **columns**
  button (top-left).
- **Calmer toolbar (new in 0.7.0)** — the top bar shows only the everyday
  controls (Save, undo/redo, the sync dot). Everything else — **Import, Export,
  Snapshot, Presets, Settings** — lives under one **⋯ More** button. In the
  editor header, **New** and **Search** stay out front; the display toggle,
  multi-select, and collapse/expand-all tuck into the **sliders** (View options)
  menu next to New.
- **The open preset now syncs like the web app.** Edits autosave to the file on
  disk **and** to your cloud library (when connected), and changes you make on
  the web / mobile flow back into the open editor (and the `.json` on disk). The
  toolbar's green **sync dot** shows the cloud status, same as the web app.
- **Save** (toolbar or Preset Manager) commits the current preset now (autosave
  already runs; this is the explicit "saved ✓"). **Save as copy** still branches
  off a separate version. **Snapshots** work here too.
- Shortcuts: `Ctrl+F` (find), `Ctrl+K` (global search) and `Ctrl+S` (save) are
  forwarded into the webview; `?`, `n`, `Alt+↑/↓` work as on the web. (Undo/redo
  stay on VS Code so text fields keep native undo — use the ↩/↪ toolbar buttons.)
- Open the **Preset Manager** (bookmark icon) and pick a saved preset: you get
  **Load (replace file)** — overwrites the open file's contents after a confirm,
  writing back to the same file — and **Open as new file** — spins the preset off
  into its own new `.json`. The file you're editing is never clobbered without
  the confirm.

### Try the standalone editor (no file)

- At the top of the **ST Presets** panel, click the **window icon** (or run
  **STPresetEditor: Open editor (no file)** from the Command Palette).
- This opens the editor with **no file attached** — it behaves like the web app:
  **Load** a preset from your library, edit it, and changes autosave into the
  library (and sync to your cloud when connected). Snapshots and library-wide
  global search work here, unlike in a single-file panel.

### Try the new ST Presets panel

In the Explorer sidebar you'll find an **ST Presets** section:

- It lists only files that actually parse as presets — other `.json`s are
  skipped silently.
- Toolbar icons: **open editor (no file)**, **new preset**, **refresh**, **sync**.
  Right-click a preset: **Duplicate / Rename / Delete / Reveal in Explorer**.
  Delete asks first and uses the trash, so it's recoverable.
- **Rename / delete now behave when the preset is open (fixed in 0.7.0):**
  renaming a preset that's open moves the editor to the new name (no ghost copy
  of the old name reappears); deleting one that's open closes its editor so it
  can't be silently recreated. If a preset's file is deleted **outside** the app
  while its cloud copy still exists, it now shows in the list as a **cloud-only**
  entry you can **Download to folder**, instead of vanishing.

### Folder ↔ cloud sync (uses the sandbox from step 2)

With `npm run cf-preview` still running:

1. In the editor webview: **Settings → Cloud sync** → Worker URL
   `http://localhost:8787`, paste the **API key** from step 2.5 → **Connect**.
   It should show "Signed in as \<you\>".
2. ST Presets panel → **`…` menu → Link folder to cloud library**. Every preset
   in the folder is pushed to your (sandbox) cloud library, and a
   `.stpe-library.json` mapping file appears at the folder root.
3. Watch the state badges: ✓ synced, ↑ pending, ⚠ conflict, ☁ cloud-only.
4. Round-trip test: open <http://localhost:8787> in the browser, edit one of
   those presets there, then back in VS Code run **`…` → Sync folder with cloud
   library** — the local file updates. Edit **both** sides differently and sync
   again — you get a per-file **Keep local / Keep cloud** choice.
5. In the browser, create a brand-new preset, then in VS Code run
   **`…` → Download missing presets** — it appears as a new file, already
   linked.
6. Delete a linked file from the panel — after the file confirm you're asked
   separately whether to also remove it **from the cloud** or keep it there.

---

## 4. Deploy a real test Worker from this branch (no new repo)

The one-click **Deploy to Cloudflare** button always copies the repo's
_default_ branch into a new GitHub repo — that's why it can't test this branch.
Deploying with the `wrangler` command instead uses **exactly the code in your
local folder** and creates no repos.

From the project folder (on this branch):

```bash
npx wrangler login       # opens a browser — sign in to Cloudflare and click Allow
npm run deploy           # builds, then uploads the Worker
```

During the first deploy wrangler notices the storage bindings have no ids yet
and **asks whether to create them** (a KV namespace for presets and a D1
database called `stpreseteditor-auth`) — answer **yes** to both. Then create
the login tables once:

```bash
npx wrangler d1 migrations apply stpreseteditor-auth --remote
```

The deploy prints your URL, e.g. `https://stpreseteditor.<your-name>.workers.dev`
— a **separate** Worker from anything the Deploy button made (that one has its
own name), so you can test freely without touching it. Open the URL, create
your account (first visitor claims the instance — do it right away, and
consider setting the `OWNER_EMAIL` Worker variable as described in README.md),
generate an API key, and point the VS Code extension at this URL.

- **Update after new commits:** `git pull`, then `npm run deploy` again.
- **Remove the test Worker:** `npx wrangler delete` (or dashboard → Workers →
  delete). The KV/D1 data stays until you delete those too.

> **About "restricted — Visitors must sign in and match an Access policy":**
> that's **Cloudflare Access**, an optional gate _in front of_ the whole site,
> separate from the app's own login. The app does not need it — it has its own
> accounts and refuses all data requests without a valid sign-in or API key.
> If Access is enabled on your Worker's URL, browsers must pass a Cloudflare
> login first (fine for you), but the **VS Code extension cannot pass it** and
> folder sync will fail. For testing, either leave Access off for the test
> Worker, or keep it web-only and skip the extension against that URL.

---

## If something goes wrong

- **`npm run dev` fails to start** — make sure `npm install` finished without
  red error lines; try deleting the `node_modules` folder and re-running
  `npm install`.
- **`cf-preview` shows login/database errors** — re-run
  `npx wrangler d1 migrations apply stpreseteditor-auth --local`, then restart
  `npm run cf-preview`.
- **The extension panel is empty** — the folder open in VS Code must directly
  contain preset `.json` files (an object with a `prompts` array). Check the
  `stpe.presetGlob` setting if your files live in subfolders you've excluded.
- **Sync stays grey** — the sync dot is grey in local-only mode by design;
  it only lights up once you're signed in (web) or connected with an API key
  (extension).

When reporting a problem, please note: which of the three setups you were in,
what you clicked, what you expected, and what happened instead.

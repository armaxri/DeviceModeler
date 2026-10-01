# Eclipse plugin (prototype)

An editor for `.hsm` files in the Eclipse IDE: the HSM web app (Monaco text editor, diagram editor,
properties, simulation, export) runs in an SWT `Browser` widget inside an Eclipse editor and edits the
workspace file. Nothing of the language is reimplemented in Java – the plugin only hosts the web app.

```
Eclipse editor (HsmDiagramEditor)                 SWT Browser (Edge / WebKit)
  ├─ IFile ↔ text, dirty state, Save      HTTP      ├─ packages/web/dist (the web app, ?host=http)
  └─ WebServer (127.0.0.1, JDK HttpServer) ◄──────► └─ packages/web/src/host.ts: api/document, changed, save, …
```

- **Web server**: the web app is a static bundle (Langium, ELK and the simulator run in the browser, no
  backend). It cannot be opened as `file://` (module scripts and web workers need an HTTP origin), so the
  plugin serves its copy of `packages/web/dist` with the JDK's `com.sun.net.httpserver` on the loopback
  interface (port 47913, or a free port if it is taken; system property `-Dhsm.server.port=…`). Every editor
  has a random token in its URL (`/s/<token>/index.html?host=http`); requests without a known token or with
  a foreign `Host` header are rejected.
- **Embedded mode of the web app** (`?host=http`, see [`packages/web/src/host.ts`](../packages/web/src/host.ts)):
  the page loads the file from `api/document` instead of the browser storage, reports changes
  (`api/changed` → dirty marker), `Ctrl+S` / *Save* call `api/save`, *Export…* stores the SVG / PNG next to
  the model (`api/export`, embedded browsers do not download), double-clicking a submachine state opens its
  model in Eclipse (`api/open`). *Examples*, *New* and *Open…* are hidden. Without the parameter the web app
  behaves as before.
- **Workspace**: *File > Save* (or `Ctrl+S` in the page) writes the text to the `IFile` (with local
  history). Changes of the file by others (another editor, git, *Replace With*) are loaded into the page
  (with a question if the editor has unsaved changes); changes of other models / headers below the folder
  of the model update the imports. Deleting or renaming the file closes the editor.
- **Imports**: `.hsm` models and C/C++ headers in the folder of the model and its subfolders (4 levels)
  are passed to the page (relative paths), so e.g. `import "motor.hsm"` resolves. Paths going up
  (`../x.hsm`) are not supported yet.
- **Browser engine**: Edge (WebView2) on Windows, WebKit (WKWebView) on macOS, WebKitGTK on Linux.
  Override with `-Dhsm.browser=edge|webkit|chromium|default` in `eclipse.ini`.

## Build

Requires Node.js ≥ 20.10, Java ≥ 21 and Maven ≥ 3.9 (the build downloads Tycho and the Eclipse 2025-06
platform; set `-Declipse.repository=…` for another release or a mirror).

```bash
# in the repository root: build the web app (packages/web/dist)
npm install
npm run build            # or: npm run langium:generate && npm run build -w packages/web

# the plugin, its feature and a p2 update site
cd eclipse-plugin
mvn verify
# → hsm.eclipse.site/target/hsm.eclipse.site-0.1.0-SNAPSHOT.zip (update site archive)
```

The Maven build copies `packages/web/dist` into the bundle (`hsm.eclipse/webapp/`, not committed); rebuild
the web app before the plugin to get its latest version.

`mvn verify -Pui-tests` also runs an integration test in a real workbench (a window opens briefly): it
opens a model, waits for the page, edits it in the page, checks the dirty state, saves with *Save* and with
`Ctrl+S` in the page and changes the file from outside.

## Install

*Help > Install New Software… > Add… > Archive…* → `hsm.eclipse.site-0.1.0-SNAPSHOT.zip`, select
*HSM Modeler (prototype)* (uncheck *Group items by category* if the list is empty), accept the unsigned
content warning and restart. Double-click a `.hsm` file in the Project Explorer; *Open With > Text Editor*
still opens the plain text.

Requirements: Java 17+ and an Eclipse release with Edge support in SWT on Windows (2021-03 or newer).
It is built and tested against 2025-06; the plugin only uses old, stable APIs, so older releases (e.g.
2022-03+) should work but are untested. Windows needs the WebView2 runtime (part of Windows 11 and of
current Windows 10).

## Develop in Eclipse (PDE)

1. Build the web app (see above) and run `mvn verify` once (or copy `packages/web/dist` to
   `eclipse-plugin/hsm.eclipse/webapp`).
2. In an *Eclipse IDE for RCP and RAP Developers* (PDE + m2e): *File > Import… > Maven > Existing Maven
   Projects* → `eclipse-plugin` (the projects `hsm.eclipse`, `hsm.eclipse.feature`, `hsm.eclipse.site` and,
   with the profile `ui-tests`, `hsm.eclipse.tests`).
3. *Run As > Eclipse Application* starts an Eclipse with the plugin.

## Verified

- macOS (aarch64), Eclipse 4.36 / WebKit: the UI test above passes; the bundle resolves with
  `Import-Package: com.sun.net.httpserver`.
- The embedded mode of the web app and the HTTP API were also tested in Chrome against the same server
  outside of Eclipse (load, imports, change notifications, `Ctrl+S`, SVG / PNG export, open submachine,
  external reload) and the normal web app is unchanged.
- **Not tested**: Windows (Edge / WebView2) and Linux (WebKitGTK), older Eclipse releases, manual use in a
  full IDE (key bindings, focus, themes).

## Limitations / next steps

- The page is one editor (text + diagram): Eclipse's *Undo*, *Find/Replace*, outline, markers in the
  *Problems* view and the text editor's key bindings do not apply inside it (Monaco has its own `Ctrl+Z`,
  `Ctrl+F`, …). Problems are only shown in the page.
- Eclipse key bindings may not reach Eclipse while the browser has the focus (depends on the engine); the
  page handles `Ctrl+S` itself.
- Imports outside the model's folder (`../`), `hsm.gen.json` header settings (include paths, defines) and
  C++ generation / unit tests are not integrated – use the CLI (`hsm generate`, `hsm test`) or an external
  tool launch configuration meanwhile.
- The settings of the page (theme, layout direction, splitter) are kept per origin, i.e. as long as the
  port stays the same.
- Moving / renaming the file closes the editor instead of following it; no *Save As*.
- Complement for plain text editing: [LSP4E](https://github.com/eclipse/lsp4e) with the language server
  of `packages/vscode` (Node.js, `dist/server.cjs --stdio`) and [TM4E](https://github.com/eclipse/tm4e) with
  its TextMate grammar would give a Generic Editor with validation, completion, hover and markers in the
  *Problems* view. The content type `hsm.eclipse.hsm` is already defined for such bindings.
- Dark Eclipse theme → *Dark* theme of the page; signing of the bundle; a Maven / npm build in CI.

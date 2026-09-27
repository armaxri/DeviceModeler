# Importing itemis CREATE models

Statecharts of itemis CREATE (formerly YAKINDU Statechart Tools) can be converted into `.hsm` models:

```bash
node packages/language/bin/cli.js import TrafficLight.sct -o TrafficLight.hsm   # warnings go to stderr
```

In the web editor, `Open…` accepts `.sct` files as well; warnings are shown in the status bar. From
code, use `importSct(xml)` of `hsm-language`, which returns `{ text, warnings }` (no DOM needed).
Several statecharts are imported together with `hsm import A.sct B.sct` (or several files in `Open…`,
`importSctFiles(files)`): a **submachine state** that references one of the other statecharts becomes a
submachine instance – `import "B.hsm"`, `var b : B` in the internal scope and `state S : b`.

The definition section and all reactions are copied as they are (both languages use the same
syntax); the diagram layout of the `.sct` file is ignored. The structure is mapped as follows:

| itemis CREATE                                   | HSM                                                                 |
|-------------------------------------------------|---------------------------------------------------------------------|
| statechart `specification`                      | definition section (`namespace`, annotations and scopes re-ordered) |
| single top-level region                         | body of the `statemachine`                                          |
| several top-level regions                       | `[*] -> Main` and `state Main { region r1 { … } region r2 { … } }`  |
| region of a composite state                     | dropped if it is the only one, otherwise `region name { … }`        |
| state and its local reactions                   | `state Name { entry / … }`, one reaction per line                   |
| default entry and its transition                | `[*] -> Target`                                                     |
| named entry / exit                              | `entry Name` / `exit Name` (an unnamed exit becomes `exit Exit1`)   |
| shallow / deep history entry                    | `history H` / `deephistory DH` (or the itemis name)                 |
| choice (dynamic / static)                       | `choice Choice1` / `junction Junction1`                             |
| synchronization                                 | `sync Sync1`                                                        |
| final state                                     | `Source -> [*]` in the region of the final state                    |
| transition `spec # >entry` / `# ex1> ex2>`      | `Source -> Target : spec # >entry` / `# ex1> ex2>`                  |
| `active(Statechart.main_region.A.r.B)`          | `active(B)` (shortest unambiguous name, regions are not part of it) |

Details and limitations (each of them is reported as a warning):

- State names that are not valid identifiers or clash with keywords are sanitized (`Door Open` →
  `state Door_Open "Door Open"`, `entry` → `entry_`) and made unique among the vertices of the same
  state (itemis names only need to be unique per region); entry points and exit nodes of different
  regions keep a shared name (`# >failure` enters all of them, like in itemis CREATE).
- Transitions are declared in the innermost container of source and target and keep the order of the
  itemis model, i.e. their priority. Multi-line effects get `;` separators, number suffixes (`1.5f`)
  are removed.
- A transition which handles several exit nodes (`# ex1> ex2>`) is imported as it is; the unnamed
  (default) exits are handled by the transitions without trigger (`# Exit1>`).
- Local reactions of the statechart itself (e.g. `oncycle / x += 1` in the `internal:` scope) are
  placed after the definition section.
- Several final states of one region are merged into the final state `[*]` of the region.
- An entry through a named history (`# >hist`) targets the history pseudo state; an unknown entry
  point name enters by default. Of several entry points (`# >e1 >e2`) the known ones are kept (only
  the first one is used, the validator warns like itemis CREATE).
- Type aliases (`alias inti : integer`) and `null` are copied unchanged; `event e : void` becomes
  `event e`.
- Not supported (kept as `// TODO import: …` comments): submachine states whose statechart is not imported
  together with them, `@SuperSteps` / `@EventBuffering` and the `import:` statements of itemis CREATE (header
  files and statechart references of the definition section). The format of submachine references is
  assumed to be a `referencedStatechart` attribute or element with an `href` (`Motor.sct#…`); every submachine
  state gets its own instance.
- Result for the 215 `.sct` files of the itemis CREATE repository: 213 are imported without syntax or
  linking errors (the other two use outdated syntax or an unqualified member of a named interface, which current
  itemis CREATE rejects as well); the remaining
  validation errors are mostly in itemis validation test models that are invalid on purpose, or in
  features HSM checks more strictly (raising `in` events internally, operations called without
  parentheses, `out` events as triggers, `%` on reals).

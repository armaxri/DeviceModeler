# Unit tests and coverage

## Unit tests

State machines are tested with a small test language modeled after **SCTUnit** of itemis CREATE
(files `*.devmtest`). A test class tests one state machine; every operation annotated with `@Test` is
executed on a fresh instance of the interpreter, after the `@SetUp` operation (if any):

```
testclass CdPlayerTest for statemachine CdPlayer {

    @SetUp
    operation insertDisc() {
        mock discInserted returns (true)        // result of an operation (`mock op(1) returns (x)`: for these arguments)
        enter
        tracks = 3                              // assign variables of the state machine
    }

    @Test
    operation playsWhenDiscInserted() {
        assert active(Closed.Stopped)
        raise play                              // raise in events (`raise level : 4` with a value)
        proceed 1 cycle                         // `proceed 2 cycles`, `proceed 200 ms` (s, ms, us, ns)
        assert active(CdPlayer.Active.Playing) message "the choice selects Active"
        assert called startMotor times 1        // `assert called op with (1, true)`, `assert !called op`
        assert track == 1 && !is_final
        press(2)                                // call helper operations
    }

    operation press(count : integer) {          // operations without @Test are helpers
        var i : integer = 0                     // local variables
        while (i < count) { raise play; proceed 1 cycle; i += 1 }
        if (tracks > 0) { assert active(Playing) } else { assert false }
    }
}
```

- **Statements**: `enter`, `exit`, `raise`, `proceed`, `assert <expr> (message "...")?`,
  `assert (!)called op (with (args))? (times n)?`, `mock op ((args))? returns (value)`, `var` / `const`,
  assignments (`=`, `+=`, …, `++`, `--`), `if` / `else if` / `else`, `while`, calls of helper operations.
  Statements are separated by line breaks or `;`. The keywords of the test language (`enter`, `proceed`,
  `called`, `mock`, `returns`, `times`, `with`, `message`, `if`, `while`, …) cannot be used as names in tests.
- **Expressions** are the expressions of the state machine language. Names are resolved in the tested state machine
  like inside the state machine (`x`, `Iface.x`, states by (partially) qualified name, optionally prefixed
  with the name of the state machine), local variables and parameters shadow them. An **out event** is
  `true` if it was raised by the last `enter` / `raise` (event driven) / `proceed` / `exit`; `valueof(e)`
  is its last value. `is_final` is true if the final state of the top-level region is active.
- **`proceed n cycle(s)`** performs `n` run cycles (event driven: `n` steps without events).
  **`proceed t unit`** advances the virtual clock: cycle based state machines run a cycle whenever the
  clock reaches a multiple of the cycle period (counted from `enter`), event driven ones process the
  time events that expire.
- **`assert called`** counts the calls since the start of the test (including the set up). Operations of the
  state machine cannot be called in tests; unmocked operations return the default value of their type.
- **Submachine instances**: members of instances are used like in the state machine – `assert active(motor.On)`,
  `assert motor.speed == 3`, `motor.maxSpeed = 2`, `assert motor.failed` / `valueof(motor.failed)` (out events
  of the instance raised by the last call), `mock motor.setPwm returns (...)` and `assert called motor.setPwm`
  (see [`examples/door-with-motor/gate.devmtest`](../examples/door-with-motor/gate.devmtest)). Events of
  instances cannot be raised by a test.
- The validator checks the references and the types (asserted expressions and conditions are boolean,
  event values, mocked values and arguments match the declarations, units of `proceed`, `@Test` / `@SetUp`
  operations have no parameters).
- A **failed** assertion reports its line, the message (or the asserted expression with the values of
  the operands of a comparison) and the last lines of the trace; runtime errors of the model (e.g. an event
  raised before `enter`) are reported as **errors**.

```bash
devm test examples/tests/door.devmtest                    # loads the .devm files next to the test file (or in its parent directory)
devm test tests/*.devmtest --machine models/ --junit report.xml -v
```

`--machine` adds `.devm` files or directories, `--junit` writes a JUnit XML report, `-v` prints the trace of
every test. The exit code is 1 if a test failed or a file has errors. The examples in
[`examples/tests/`](../examples/tests) test all example state machines. The runner is available as API
(`runTests`, `HsmTestWorkspace`, `toJUnitXml` in `hsm-language`); it runs in the browser as well.

Not yet supported (compared to SCTUnit): `@Ignore`, `package` / imports, test suites, verifying the
order of calls, mocks with sequences of values, calling operations of the state machine in a test,
`assert` on time (`proceed` is the only way to advance time); the web editor does not run tests yet.

## Coverage

`devm test --coverage` measures which parts of the state machines the unit tests exercise (like the
coverage view of SCTUnit in itemis CREATE). Coverage is aggregated over all tests of all test files:

| Metric | Covered when |
| --- | --- |
| **States** | the state was entered; final states count per region (`[*]`, `Active.[*]`, `S.r1.[*]`) |
| **Transitions** | the transition was taken – every transition of the model, including initial transitions, choice / junction branches, history defaults, entry / exit point transitions and each branch of a fork / join |
| **Reactions** | the local reaction was executed (`entry`, `exit`, `always`, `oncycle`, event and time reactions, also those of the state machine) |
| **Guard decisions** | each guard of a transition or local reaction counts twice: covered once it was evaluated to `true` and once to `false` (guards are evaluated only when a trigger matched) |

```bash
devm test examples/tests/*.devmtest --coverage                          # text summary + coverage/lcov.info + coverage/html/
devm test tests/*.devmtest --coverage-format text,cobertura --coverage-dir build/coverage
devm test tests/*.devmtest --coverage-threshold states=100,transitions=90   # exit code 1 if not reached
```

Any `--coverage-*` option implies `--coverage`. Formats (`--coverage-format`, default `text,lcov,html`):

| Format | Output | Use |
| --- | --- | --- |
| `text` | table per state machine (states, transitions, reactions, guard decisions) and the uncovered elements with line numbers, on stdout | console, CI logs |
| `json` | `coverage.json`: totals and every element with id, kind, name, line, diagram id, hits and the covering tests, every guard with its true / false counts (schema version 1, see `toCoverageJson`) | own tooling |
| `lcov` | `lcov.info`: one record per `.devm` file; lines (`DA`) are the lines of states, transitions and reactions (a line counts as covered only if all its elements are), functions (`FN`) are the states, branches (`BRDA`) the guard decisions | VS Code (e.g. *Coverage Gutters*), GitHub (Codecov, Coveralls), `genhtml` |
| `cobertura` | `cobertura-coverage.xml` with the same lines and branches, paths relative to the working directory | GitLab merge request coverage, Jenkins |
| `html` | `html/index.html` and one self-contained page per state machine with all elements (covered / uncovered, hits, tests) and guards | browsing, CI artifacts |

`--coverage-threshold` takes `states`, `transitions`, `reactions`, `guards` (or `all` / a single number)
in percent and checks the totals over all state machines. Element ids are stable and equal the ids of the
diagram elements (`Closed`, `Active.Playing`, `#machine#initial->Closed`, `Closed->Opened`, `Closed->Opened~1`
for a second transition between the same vertices, `Service#region1#final`, reactions `Opened#reaction2`),
so reports can be mapped onto the diagram.

CI examples:

```yaml
# GitLab: test report and coverage in merge requests
model-tests:
  script:
    - npx devm test tests/*.devmtest --junit report.xml --coverage-format text,cobertura --coverage-threshold transitions=90
  artifacts:
    when: always
    reports:
      junit: report.xml
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml
```

```yaml
# GitHub Actions
- run: npx devm test tests/*.devmtest --junit report.xml --coverage-format text,lcov,html --coverage-threshold states=100
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: model-coverage, path: coverage/ }
- uses: codecov/codecov-action@v5        # optional: coverage/lcov.info
  with: { files: coverage/lcov.info }
```

As API, `runTests(test, machine, { coverage: new CoverageCollector() })` collects the coverage of tests;
a `CoverageCollector` can also be attached to any interpreter –
`new StatechartInterpreter(machine, collector.attach(options))` – e.g. to show the coverage of a
simulation session (`collector.highlight(machine)` returns the diagram element ids with the classes
`hsm-covered` / `hsm-uncovered`). The report functions are `toCoverageText`, `toCoverageJson`, `toLcov`,
`toCobertura` and `toCoverageHtml` (with an optional `renderDiagram(machine, highlight)` hook that embeds the
highlighted diagram).

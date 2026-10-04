# The language

```
// comments like in Java / TypeScript
statemachine CdPlayer "optional description" {
    @CycleBased(200)                              // execution mode (default), or @EventDriven

    interface:                                    // definition section
        in event play
        in event pause
        in event eject
        in event powerOff
        in event trackEnd
        out event finished : integer              // events may carry a value
        var track : integer = 1
        var tracks : integer = 0
        operation discInserted() : boolean        // implemented by the host application
        operation startMotor() : void

    internal:
        const MAX_TRACKS : integer = 99
        event tick

    [*] -> Closed                                 // initial transition of the state machine

    state Closed {
        [*] -> Stopped                            // initial transition of the composite state

        history H                                 // also: deephistory, choice, junction, sync
        state Stopped {
            entry / track = 1                     // local reactions: trigger [guard] / effect
        }
        state Active {
            [*] -> Playing
            state Playing {
                entry / startMotor()
                trackEnd [track < tracks] / track += 1
                every 1 s / raise tick
            }
            state Paused
            Playing -> Paused : pause
            Paused -> Playing : pause, play       // several triggers
            Paused -> Stopped : after 30 s        // time event
        }
        choice HasDisc

        Stopped -> HasDisc : play
        HasDisc -> Active : [discInserted() && tracks > 0]   // guard only
        HasDisc -> Stopped : else                 // taken if no other branch is enabled
    }

    state Open "Tray is open"                     // description shown in the state

    Closed -> Open : eject
    Open -> H : eject                             // re-enter the last active sub state
    Closed -> [*] : powerOff / raise finished : track   // transition to the final state
}
```

- **Definition section**: `interface:`, named interfaces
  (`interface Pedestrian:` – their members are referenced as `Pedestrian.request`) and `internal:`
  with `in event`, `out event`, `event`, `var`, `var readonly`, `const`, `operation` and `alias`
  declarations. Types: `integer`, `real`, `boolean`, `string`, `void` and **type aliases**
  (`alias Speed : integer`, also aliases of aliases; `Iface.Speed` for aliases of a named interface,
  the simple name works if it is unambiguous). An alias has exactly the semantics of its base type;
  the code generators use the base type. It may start with `namespace a.b` and
  annotations: `@CycleBased(period)`, `@EventDriven`, `@ParentFirstExecution`, `@ChildFirstExecution`.
  The **C++ class sections** `public:`, `protected:` and `private:` declare members of the generated C++
  class (see [C++ class sections](#c-class-sections)).
- **Reactions** (transition labels and local reactions of states) have the form
  `trigger, trigger [guard] / effect`; every part is optional (a local reaction needs the effect).
  Triggers: events, `after n unit` / `every n unit` (units `s`, `ms`, `us`, `ns`), `always`,
  `oncycle`, `entry` / `exit` (local reactions only), `else` / `default` (transitions leaving a choice).
  Effects are `;`-separated statements: expressions (assignments, operation calls) and
  `raise event` / `raise event : value`.
- **Expressions**: `=`, `+=`, `-=`, `*=`, `/=`, `%=`, `<<=`, `>>=`, `&=`, `|=`, `^=`, `? :`, `||`,
  `&&`, `|`, `^`, `&`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `<<`, `>>`, `+`, `-`, `*`, `/`, `%`, `!`,
  `~`, `as` casts, literals (`true`, `42`, `0x1F`, `1.5`, `"text"`, `null`), `valueof(event)` and
  `active(State)`. `null` can only be assigned to, passed as or compared with a `string` (and `null`);
  it denotes the empty string (`s == null` is `s == ""`) in the interpreter and in the generated C and
  C++ code (`std::string` cannot be null).
- **States** are referenced by (partially) qualified names: `Playing`, `Active.Playing` or
  `Closed.Active.Playing`. A name is resolved in the scope of the transition first and then outwards,
  so sibling states must have different names, but states in different composite states may share a
  simple name. Transitions may be declared in any scope; `[*]` refers to the initial (as source) or
  final (as target) state of the scope the transition is declared in.
- **Orthogonal regions**: `state S { region A { ... } region B { ... } }` (regions may be unnamed).
- **Entry points and exit nodes** (inside a composite state `C`): `entry E` / `exit X`. A transition
  to `C` ending with `# >E` enters `C` via `E`; when `X` is reached, `C` is left by the transition
  `C -> ... # X>`. As in itemis CREATE, one transition may handle several exit nodes
  (`C -> Done # X1> X2>`), and entry points / exit nodes in different orthogonal regions of `C` may
  have the same name: `# >failure` enters every region that has an entry point `failure` through it
  (the other regions by default), and reaching any exit node `X` takes the `# X>` transition. Of
  several entry points on one transition (`# >E1 >E2`) only the first one is used (warning, like
  itemis CREATE).
- **Synchronization**: `sync S` joins several incoming transitions (from orthogonal regions) and forks
  into several outgoing transitions.
- **Priorities**: the outgoing transitions of a vertex are checked in the order of the text; the first
  enabled one is taken.
- The execution semantics are specified in [`docs/semantics.md`](semantics.md). See
  [`examples/`](../examples) for more: `door.hsm` shows entry points, exit nodes and fork / join,
  `traffic-light.hsm` time events and named interfaces, `keyboard.hsm` orthogonal regions,
  [`door-with-motor/`](../examples/door-with-motor) imports and submachines, [`cpp-types/`](../examples/cpp-types)
  the types and constants of a C++ header, [`cpp-class-sections/`](../examples/cpp-class-sections) the C++ class
  sections.

## Imports and submachines

A state machine can import other state machines and use them as **submachines**: a variable whose type
is an imported state machine is an **instance** of it, a state bound to the instance runs it while the
state is active (the instance is a separate object with its own states and variables – it is not inlined).

```
// motor.hsm                                      // gate.hsm
statemachine Motor {                              statemachine Gate {
    interface:                                        import "motor.hsm"   // relative to this file
        in event start                                interface:
        in event stop                                     in event open
        out event stopped                                 in event fast
        out event failed : integer                    internal:
        var speed : integer = 0                           var motor : Motor  // an instance of Motor
    entry Run   // entry point of the machine         [*] -> Closed
    exit Failed // exit node of the machine           state Closed
    [*] -> Off                                        state Moving : motor   // runs while Moving is active
    Run -> On                                         state Error
    state Off                                         Closed -> Moving : open / raise motor.start
    state On                                          Closed -> Moving : fast # >Run   // via entry point Run
    Off -> On : start / speed = 1                     Moving -> Closed : motor.stopped [motor.speed == 0]
    On -> Off : stop / raise stopped                  Moving -> Error : # Failed>      // exit node reached
    On -> Failed : after 5 s / raise failed : 1   }
}
```

- **Imports**: `import "path"` (several allowed, also the itemis CREATE form `import: "a.hsm" "b.hsm"`) at
  the beginning of the state machine body (before or after `namespace`). Paths are resolved relative to the
  importing file; the name of the imported state machine is a type. Missing files, import cycles, duplicate
  machine names and imports of the importing machine itself are errors. C/C++ headers (`import "types.h"`,
  `.hpp`, …) import types and constants, see [C/C++ header imports](#cc-header-imports).
- **Instances** (`var motor : Motor`, in any scope; no initial value, not `const`) are used only through
  the **interfaces** of their state machine: `raise motor.start` (its `in` events), `motor.stopped` as
  trigger or condition and `valueof(motor.failed)` (its `out` events), `motor.speed` (read and assign its
  interface variables, not constants / `readonly` ones), `motor.Iface.x` for named interfaces and
  `active(motor.On)` / `active(motor.Running.Fast)` for its states. Its internal scope, its operations and its
  own instances are not visible. Instances cannot be assigned, compared or passed around.
- **Binding**: `state Moving : motor` (a simple state – no sub states – may have local reactions). An
  instance can be bound to one state; an unbound instance is a warning (it never runs). A transition to
  the state may select an entry point of the instance's machine (`# >Run`); `Moving -> X : # Failed>` is
  taken when the instance reaches its exit node `Failed`. Entry points and exit nodes may be declared at the
  top level of a state machine for this purpose.
- **Execution** ([docs/semantics.md §9](semantics.md)): the instance is entered after the entry
  reactions of its state and exited before its exit reactions; in each step it is processed like the sub
  region of its state (parent first: after the state's transitions and local reactions, child first: before
  them). Events raised on it are processed in its next processing (cycle based) or in a step of their own
  (event driven); its out events are seen by every reaction of the parent exactly once. It uses the execution
  mode and order of the parent (a warning if its machine declares others), shares the virtual clock and keeps
  its variables when it is entered again. States of instances are reported as `motor.On` (`activeStates`,
  scenarios, traces), their operations are implemented by the host as `motor.setPwm`.
- **Where imports are resolved**: CLI (`hsm validate/simulate/test/render/doc`) and API (`HsmModelLoader`,
  `HsmTestWorkspace`) read imported files transitively from disk (or from given texts); the VS Code language
  server resolves them in the workspace (a change of `motor.hsm` updates the diagnostics of `gate.hsm`, go to
  definition works on `Motor` and on the import path); the diagram webview gets the imported files from the
  extension; the web editor resolves imports against a virtual file list (the examples and the opened files;
  "Open…" accepts several files, the example list also lists the files). Double-clicking a submachine state
  opens the file of its state machine.
- The **C and C++ generators do not support submachine instances yet**; they report
  "Submachine instances are not supported by the C/C++ generator yet".

## C/C++ header imports

A model can import C/C++ headers of the application and use their **types and constants** – enums (also
`enum class`), structs with data members, `typedef` / `using` aliases, `constexpr` / `const` constants in
namespaces. Operations stay callbacks (functions and classes with methods of the headers are not used).
Example: [`examples/cpp-types`](../examples/cpp-types) (a header, a model and its unit tests; it is also part of
the [CMake example](build-integration.md#example)).

```
// motor_types.h                                   // controller.hsm
namespace motor {                                  statemachine Controller {
/// Operating mode.                                    import "motor_types.h"
enum class Mode : std::uint8_t { Off, Slow, Fast };    interface:
struct Position {                                          in event moveTo : motor::Position
    std::int32_t x = 0;                                    in event setMode : motor::Mode
    std::int32_t y = 0;                                    var mode : motor::Mode = motor::Mode::Off
};                                                         var target : motor::Position = motor::kHome
using Rpm = std::uint16_t;                                 var speed : motor::Rpm
constexpr Rpm kMaxSpeed = 3000;                            var small : uint8_t
constexpr Position kHome{10, 20};                          operation drive(p : motor::Position) : boolean
}                                                      [*] -> Idle
                                                       state Idle
                                                       state Moving
                                                       Idle -> Moving : moveTo [valueof(moveTo).x < 500]
                                                           / target = valueof(moveTo); target.y += 1; speed = motor::kMaxSpeed
                                                       Moving -> Idle : setMode [valueof(setMode) == motor::Mode::Off]
                                                   }
```

- **Names**: C++ names are written with `::`, fully qualified from the global namespace: types
  (`motor::Mode`, `motor::Rpm`), enumerators (`motor::Mode::Fast`; enumerators of unscoped enums also as
  `motor::kStall`), constants (`motor::kMaxSpeed`, static members `motor::Limits::kVersion`). Names of the
  global namespace are written `::Color` in expressions (types also `Color`). The `<cstdint>` / `<cstddef>`
  typedefs (`uint8_t`, `std::int32_t`, `size_t`, …) are always known; C++ keywords like `int` or `double`
  are not type names of models (use `integer`, `real` or a typedef).
- **Types**: integer types are `integer`, whose values are converted to the C++ type when they are stored
  (a variable, member, event value or parameter of type `uint8_t` wraps around like in C++; constant values
  out of range are warnings); arithmetic uses 64-bit integers like all HSM integers. `float` / `double` are
  `real` (`float` rounds to single precision), `bool` is `boolean`, `std::string` is `string`
  (`const char*` / `std::string_view` constants can be read). **Enums** are types of their own: values are
  compared with `==` / `!=` and ordered (`<`, `>=`, … between values of the same enum); unscoped enum values
  convert to `integer` (flags: `faults | motor::kJam`), but nothing converts implicitly to an enum (an `integer`
  or a value of another enum is a type error, like in C++); `x as motor::Mode` / `mode as integer` convert. All
  common forms of enum declarations are supported: `enum`, `enum class` / `enum struct` with or without
  underlying type, C style `typedef enum { LED_OFF, LED_ON } led_t;` (type `led_t`, enumerators `::LED_OFF`),
  enums in namespaces (`app::io::Level::Low`) and classes (`app::Sensor::State`, unscoped enumerators
  `app::Sensor::Idle`), opaque declarations (`enum class Handle : std::uint32_t;`, values by cast) and
  C++20 `using enum` (table in [docs/cpp-integration.md §3.4](cpp-integration.md#34-enums)). The values of the
  enumerators are computed like a C++ compiler does (implicit numbering, literals, expressions, macros; see
  [§3.5](cpp-integration.md#35-enumerator-values) and the example
  [`examples/cpp-enum-values`](../examples/cpp-enum-values)). **Structs**: members are read and assigned (`pos.x`,
  `cfg.timing.periodMs = 5`, `valueof(e).x`, `measure().y`), structs are assigned as a whole, not compared
  (no `==`). **Arrays** (`std::array<T, N>`, `T[N]` members): elements `a[i]` (checked: an index out of bounds is
  a runtime error). Unions, pointers, templates (other than `std::array`) and the like are errors where used.
- **Values**: variables of C++ types are initialized like `T{}` (default member initializers, zero otherwise,
  the enumerator with value 0). Hosts, scenarios and operation callbacks exchange plain values: enum values as
  the qualified enumerator name (`"motor::Mode::Fast"`, set also as `"Fast"` or a number), structs as objects
  (members that are not given keep their default), arrays as arrays. Traces show `motor::Mode::Fast` and
  `{x: 1, y: 2}`. The simulation panel of the web app and of VS Code edits enum values with a drop-down and the
  members of structs in expandable editors; the unit test language uses the same names and values
  (`assert mode == motor::Mode::Fast`, `mock measure returns (motor::kHome)`, `p.x = 3` for a local struct).
- **Headers in angle brackets** (`import "<vector>"`) are not analyzed: the generated C++ code `#include`s them
  (`#include <vector>`), their types can only be used by the [C++ class sections](#c-class-sections) for members that
  the model does not use.
- **Headers** are searched relative to the importing model, then in the **include paths**; the headers they
  include (`#include "…"` / `<…>` found in the include paths) are analyzed too and their declarations are
  visible. The settings of the analysis are configured in the `headers` block of `hsm.gen.json` (include
  paths relative to the file, predefined macros for `#if`, the data model of the target, e.g. 32-bit `long`
  on microcontrollers):

  ```json
  { "models": ["models/*.hsm"], "cpp": {},
    "headers": { "includePaths": ["include"], "defines": { "USE_CAN": "1" }, "dataModel": { "longBits": 32, "pointerBits": 32 } } }
  ```

  The nearest `hsm.gen.json` / `*.hsm.gen.json` in the directory of a model or a parent directory applies (CLI,
  language server); `hsm validate|simulate|test|generate|layout` add `-I <dir>`, `-D NAME[=VALUE]` and
  `--data-model lp64|llp64|ilp32`, VS Code the settings `hsm.headers.includePaths` / `hsm.headers.defines` /
  `hsm.headers.dataModel`, CMake `hsm_generate(… INCLUDE_DIRS … DEFINES …)`. A missing header is an error at
  the import, errors in the header are reported there with their location (`motor_types.h:12:5: …`);
  `hsm cpp-header <files>` prints what the analyzer extracts. The supported C++ subset is described in
  [docs/cpp-integration.md](cpp-integration.md).
- **Tools**: hover shows the declaration, value and documentation comment of the header (for enumerators the
  computed value with its derivation, e.g. ``value `3` (`0x3`) = `kPowered | kCalibrated` ``), go to definition
  opens the header (VS Code), completion after `motor::` lists the names of the namespace / enum (only types
  in type positions) and after `pos.` the members; where an enum value is expected (`mode == `, `mode = `,
  `raise setMode : `, operation arguments) the enumerators of the enum are proposed (`motor::Mode::Fast`, with their values), in
  type positions the C++ types. An unqualified enumerator (`Fast`) is an error that suggests the qualified name. The language server re-reads a header when it changes on disk and revalidates the models
  importing it; the web app accepts headers in *Open…* (they are added to its virtual file list).
- **Generated C++** `#include`s the headers and uses the types by their names (`motor::Mode mode`,
  `void raise_moveTo(const motor::Position& value)`, `std::uint8_t get_small() const`), enumerators and
  constants by name, stores with `static_cast` to the declared type. The **C generator** reports
  "C++ header types are not supported by the C generator".

## C++ class sections

The definition section may contain the sections `public:`, `protected:` and `private:`. Their variables,
constants and operations are **members of the generated C++ class** with that access: variables and constants
are data members, operations are member functions that the application implements (in its own `.cpp` file,
see [Code generation (C++)](cpp-generator.md#c-class-sections)). They are used in guards, effects and the unit
tests by their simple names, like the members of the internal scope. The types are **C++ types**, written as in
C++. The types of the application are imported with `import "header.h"` (see
[C/C++ header imports](#cc-header-imports)): the generated header `#include`s them. Headers that are only
needed by the generated code (standard library, system headers) are imported in angle brackets: `import "<vector>"`
becomes `#include <vector>`; such a header is not analyzed (its types can only be used by members that the model
does not use, see below).

```
statemachine Controller {
    import "path/to/header.h"                 // EpicProject::Config, EpicProject::Driver
    import "<vector>"                         // only #include <vector>

    interface:
        in event start
        in event failure

    public:
        /**
         * @brief Config setter.
         */
        operation setConfig(config : const EpicProject::Config&)
        /** @brief Whether the device may be restarted. */
        const operation retryAllowed() : bool
    protected:
        /**
         * @brief Setup function.
         */
        operation setup()
        var shutdowns : std::vector<unsigned int>   // only used by the C++ code
    private:
        var errorCnt : unsigned int = 0
        const maxErrors : unsigned int = 3
        var config : EpicProject::Config
        var driver : EpicProject::Driver&     // bound by the constructor, only used by the C++ code

    [*] -> Off
    state Off
    state Running {
        entry / setup()
    }
    Off -> Running : start [retryAllowed() && errorCnt < maxErrors]
    Running -> Off : failure / errorCnt++
}
```

- **Declarations**: `var name : type = value`, `const name : type = value` (a `const` data member), `var readonly`
  (the model cannot assign it, the C++ code can), `operation name(parameters) : returnType` (default `void`) and
  `const operation name(...)`, a **const member function** (`bool retryAllowed() const;`). Events and type aliases
  belong to the interfaces and the internal scope; `static` members are not supported (an error). Several sections,
  also of the same access, may follow each other; the members keep their order in the generated class. `/** … */`
  documentation comments (with Doxygen commands such as `@brief`) are copied into the generated header. The member
  functions are `virtual` in the generated class (so that subclasses can override them; the generator option
  `virtualMethods: false` turns this off), the model has no syntax for it.
- **Types** are C++ types: fundamental types (`unsigned int`, `long long`, `double`, `bool`, `char`), the types of
  the imported headers (`EpicProject::Config`), `<cstdint>` typedefs, `const`, references (`const T&`, `T&`),
  pointers (`Driver*`, `const char*`) and template arguments (`std::array<int, 4>`, `std::map<int, std::string>`,
  `std::vector<std::vector<int>>`). The HSM types (`integer`, `string`, aliases) can be used as well. Elsewhere in the
  model these C++ forms are reported as errors.
- **Use in the model**: a member can be used in the model if the model knows its types – the types of
  [C/C++ header imports](#cc-header-imports) (integers, reals, `bool`, `std::string`, enums, structs, `std::array`),
  where `const T&` and `T&` are values of type `T`. Members with other types (pointers, other templates, types of
  headers in angle brackets, classes the header analyzer cannot use, non-const reference parameters) are declared in
  the generated class for the C++ code of the application; using them in the model is an error (`The member
  'shutdowns' cannot be used in the model: its type 'std::vector<unsigned int>' is not a type of the model: … It can
  only be used by the C++ code of the application.`).
- **Initialization**: data members are initialized **once, when the object is constructed** (default member
  initializers); unlike the variables of the interfaces, `enter()` does not reset them, so values set by the
  application before `enter()` (`setConfig(...)`) are kept. Their initial values may use literals, C++ constants and
  the members declared before; without initial value the member is value-initialized (`T{}`: `0`, `nullptr`, the
  default constructor). Declare constants with `const name : type` instead of `const` in the type.
- **Reference members** (`var driver : EpicProject::Driver&`, `var settings : const app::Config&`) are bound by the
  **constructor** of the generated class, which takes them as parameters in declaration order
  (`Controller(EpicProject::Driver& driver_)`; without reference members the class has a default constructor). They
  have no initial value; the model reads them like variables and assigns them if they are not references to
  constants. In the simulator and the unit tests they are variables whose value is the referenced object (set by the
  host, also before `enter`).
- **Simulation and unit tests**: member functions are called like operations (the simulator lets the host provide
  their results, unit tests use `mock setup returns (…)` and `assert called setup`); data members are shown and
  edited like variables (`config.maxErrors = 2` in a unit test, also before `enter`). Members the model cannot use
  are not simulated.
- **Names** are the C++ names: they must not be C++ keywords nor names of the generated class (`enter`, `running`,
  …; the generator reports a clash). The C generator does not support the class sections.

## Diagram layout annotations

🧪 Experimental (branch `claude/layout-annotations`). A hand-arranged diagram is stored in the model as
layout annotations; a model without them is laid out automatically. They have no influence on the
semantics or the generated code, and are normally written by the diagram editor (see
[Manual layout](manual-layout.md)).

```
statemachine Door {
    interface:
        in event open
    @definitions(20, 20)
    @initial(330, 24)
    [*] -> Closed
    @at(300, 80)
    state Closed
    @at(300, 220) @size(160, 80)
    state Opened {
        @initial(10, 10)
        [*] -> Idle
        @at(14, 40)
        state Idle
    }
    @via(420, 160) @label(8, 0) @from("bottom", 50) @to("top", 25)
    Closed -> Opened : open
}
```

- Before a state, pseudo state or region: `@at(x, y)` (position relative to the content area of the
  parent), `@size(width, height)` (states and regions), `@regions("vertical" | "horizontal")` (states).
- Before a transition: `@via(x1, y1, x2, y2, …)` (waypoints, relative to the innermost state containing
  both end points), `@label(dx, dy)` (label offset) and `@from(side, position)` / `@to(side, position)`
  (where the transition starts / ends on the border of its source / target state: side `"top"`,
  `"right"`, `"bottom"` or `"left"`, position along the side in percent, 0 to 100).
- In the body of the state machine, a state or a region: `@initial(x, y)` / `@final(x, y)` (its `[*]`
  states); in the body of the state machine also `@definitions(x, y[, width, height])`.
- Arguments are numbers (written as integers, `-` allowed), `@regions` takes a string, `@from` / `@to` a
  string and a number. Other annotations
  of the state machine (`@CycleBased`, …) and the definition section must come before the states and
  transitions.

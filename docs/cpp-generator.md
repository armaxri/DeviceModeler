# Code generation (C++)

C++ is the primary code generation target. `hsm generate cpp model.hsm -o gen` (or
`generateCpp(machine, options)` of `hsm-language`) generates code in the spirit of the itemis CREATE C++
generator: one class per state machine in `<Class>.h` / `<Class>.cpp` (`TrafficLight.h`,
`TrafficLight.cpp`) plus the shared runtime header `sc_statemachine.h` (`sc::integer` = `int64_t`,
`sc::real` = `double`, `sc::boolean` = `bool`, `sc::string` = `std::string`, the interfaces
`sc::StatemachineInterface`, `sc::TimedInterface`, `sc::TimerServiceInterface`, observers and errors).
Options: `--namespace a::b` (default: the `namespace` of the model, `""` for none), `--class-name`,
`--std 11` (the code is written for C++17; with `--std 11` it also compiles as C++11 – the only
difference are nested namespace definitions). Models importing C/C++ headers ([C/C++ header
imports](language.md#cc-header-imports)) get `#include`s of the headers and use their types, enumerators and constants
by name.

The code implements [`docs/semantics.md`](semantics.md) exactly like the interpreter: every scenario
of the conformance suite is compiled with g++ (`-std=c++17 -Wall -Wextra -Wpedantic -Werror -Wshadow
-Wconversion`, checked with clang++ too) and run by `npm test`; the examples are also compiled as C++11
and with `-fno-exceptions`. The class uses no global state and no RTTI; it allocates dynamic memory
only in `std::string` values and, for `@EventDriven` machines, in the `std::deque` event queues. It is readable: private member functions per
state (`enter_…`, `exit_…`, `react_…`), region and transition, with comments naming them. It is not
thread-safe: call it from one thread (or synchronize the calls).

Generated API (for `TrafficLight` of [`examples/traffic-light.hsm`](../examples/traffic-light.hsm)):

| Member | |
|---|---|
| `void enter()`, `void exit()` | enters / exits the state machine (`sc::StatemachineInterface`) |
| `void runCycle()` | one run cycle; call it every `TrafficLight::cyclePeriodMs` ms (`@EventDriven`: each event is processed when it is raised, `runCycle()` performs a step without events) |
| `bool isActive()`, `bool isFinal()`, `bool isStateActive(State s)` | state queries, `enum class State { Off, Operating, Operating_Red, … }` |
| `void raise_powerOn()` | raises an in event of the unnamed interface (typed events take the value) |
| `bool isRaised_lightsChanged()`, `sc::integer get_lightsChanged_value()` | whether an out event was raised in the last call of `enter`, `exit`, `runCycle`, `raiseTimeEvent` or (event driven) `raise_…`, and its value |
| `sc::rx::Observable<sc::integer>& getLightsChanged()` | out event observable: `subscribe(observer)` with an `sc::rx::Observer<T>` (`sc::rx::Observer<void>` for events without value) that is notified immediately; no dynamic memory, an observer observes one observable at a time and unsubscribes itself when it is destroyed |
| `get_x()`, `set_x(v)` | variables and constants of the unnamed interface (no setter for constants and `readonly` variables) |
| `Pedestrian& getPedestrian()` | a named interface: nested class `TrafficLight::Pedestrian` with the same members (`getPedestrian().raise_request()`, `get_waiting()`, …) |
| `setOperationCallback(OperationCallback*)`, `setInternalOperationCallback(InternalOperationCallback*)`, `getPedestrian().setOperationCallback(Pedestrian::OperationCallback*)` | the operations: the host implements the abstract callback classes (like the operation callbacks of itemis CREATE); without a callback an operation returns the default value of its return type |
| `setTimerService(sc::TimerServiceInterface*)`, `raiseTimeEvent(sc::eventid)` | time events (`sc::TimedInterface`, only for machines with time events): the state machine calls `setTimer(machine, event, durationNs, periodic)` / `unsetTimer(machine, event)` of the timer service (durations in nanoseconds), the host calls `raiseTimeEvent(event)` when a timer expires |
| `setErrorHandler(sc::ErrorHandler*)` | runtime errors, see below |

Operations with variable-length parameters receive them as `std::initializer_list<T>` (no allocation).
Strings are passed as `const sc::string&` and returned by value. The internal scope is private; tests can
read and write it through a struct `TrafficLightInternals` (a friend of the class they may define).

**Runtime errors** of the semantics (a choice without enabled branch, a composite state without initial
transition, an exit node without transition, division by zero, a shift out of range, too many transitions
in one step, …) throw an `sc::StatemachineError` (derived from `std::runtime_error`, with `kind()`) whose
message has the format of the interpreter (`Choice 'C' has no enabled outgoing transition (line 12: 'choice C')`).
Like in the interpreter, the step is aborted and the state machine stays usable (its configuration may be
inconsistent). For code without exceptions, set an `sc::ErrorHandler`: it receives the error and the
machine continues with the failed part skipped like the C code (a division yields 0, the choice is not
left). Without handler and without exceptions (`-fno-exceptions`) an error calls `std::abort()`.

A complete host with a timer service based on `std::chrono`, an operation callback and an observer
(compiled and run by `npm test`):

```cpp
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <thread>
#include <vector>
#include "TrafficLight.h"

using Clock = std::chrono::steady_clock;

// Timer service: the host checks the timers before every run cycle.
class TimerService : public sc::TimerServiceInterface {
public:
    void setTimer(sc::TimedInterface* machine, sc::eventid event, sc::integer durationNs, bool periodic) override {
        unsetTimer(machine, event);
        const std::chrono::nanoseconds period(durationNs);
        timers.push_back(Timer{machine, event, Clock::now() + period, period, periodic});
    }

    void unsetTimer(sc::TimedInterface* machine, sc::eventid event) override {
        timers.erase(std::remove_if(timers.begin(), timers.end(), [&](const Timer& timer) {
            return timer.machine == machine && timer.event == event;
        }), timers.end());
    }

    // Raises the time events of all expired timers.
    void raiseExpired() {
        const Clock::time_point now = Clock::now();
        std::vector<Timer> expired;
        for (auto it = timers.begin(); it != timers.end();) {
            if (it->due > now) {
                ++it;
                continue;
            }
            expired.push_back(*it);
            if (it->periodic) {
                it->due += it->period;
                ++it;
            } else {
                it = timers.erase(it);
            }
        }
        for (const Timer& timer : expired) {
            timer.machine->raiseTimeEvent(timer.event);
        }
    }

private:
    struct Timer {
        sc::TimedInterface* machine;
        sc::eventid event;
        Clock::time_point due;
        std::chrono::nanoseconds period;
        bool periodic;
    };
    std::vector<Timer> timers;
};

// Operation switchOn of the internal scope.
class Lights : public TrafficLight::InternalOperationCallback {
public:
    void switchOn(sc::integer mask) override {
        std::printf("lights: %d\n", static_cast<int>(mask));
    }
};

// Observer of the out event lightsChanged.
class LightsChanged : public sc::rx::Observer<sc::integer> {
public:
    void next(const sc::integer& lights) override {
        std::printf("lights changed: %d\n", static_cast<int>(lights));
    }
};

int main() {
    TrafficLight light;
    TimerService timerService;
    Lights lights;
    LightsChanged lightsChanged;
    light.setTimerService(&timerService);
    light.setInternalOperationCallback(&lights);
    light.getLightsChanged().subscribe(lightsChanged);

    try {
        light.enter();
        light.raise_powerOn();
        Clock::time_point next = Clock::now();
        for (int cycle = 0; cycle < 600; cycle++) { // one minute
            next += std::chrono::milliseconds(TrafficLight::cyclePeriodMs);
            std::this_thread::sleep_until(next);
            timerService.raiseExpired();
            if (cycle == 300 && light.isStateActive(TrafficLight::State::Operating_Green)) {
                light.getPedestrian().raise_request(); // a pedestrian presses the button
            }
            light.runCycle();
        }
        light.exit();
    } catch (const sc::StatemachineError& error) {
        std::fprintf(stderr, "state machine error: %s\n", error.what());
        return 1;
    }
    return 0;
}
```

```bash
node packages/language/bin/cli.js generate cpp examples/traffic-light.hsm -o gen
g++ -std=c++17 -Wall -Wextra -Igen -o traffic-light main.cpp gen/TrafficLight.cpp
```

The test harnesses are generated from the scenarios by `generateCppScenarioHarness(api, scenario)`
(mocked operation callbacks with scripted results, a virtual timer service, observers recording the out
events); `HSM_CXXFLAGS='-O1 -fsanitize=address,undefined' npm test` runs them with sanitizers.

[← All state machines](index.md)

# Conveyor

> Belt conveyor using the types of a C++ header

Source: [`examples/cpp-types/conveyor.devm`](../../examples/cpp-types/conveyor.devm)

![Conveyor diagram](Conveyor.svg)

## Execution

| Property | Value |
| --- | --- |
| Execution | cycle based, period `100 ms` |
| Order | parent first (parent states react before their sub states) |
| Namespace | `example` |
| Annotations | `@CycleBased(100)` |

## Interfaces

### Interface

**Events**

| Event | Direction | Type | Description |
| --- | --- | --- | --- |
| `start` | in |   |   |
| `stop` | in |   |   |
| `packageDetected` | in | `conveyor::Package` | A package arrived at the light barrier. |
| `fault` | in | `conveyor::Fault` |   |
| `reset` | in |   |   |
| `modeChanged` | out | `conveyor::Mode` |   |
| `rejected` | out | `conveyor::Package` | A package that is too heavy is pushed off the belt. |

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `mode` | var | `conveyor::Mode` | (default) |   |
| `led` | var | `conveyor_led_t` | `::LED_OFF` | The status LED. |
| `settings` | var | `conveyor::Settings` | `conveyor::kDefaultSettings` |   |
| `faults` | var | `integer` | (default) |   |
| `count` | var | `integer` | (default) |   |
| `last` | var | `conveyor::Package` | (default) |   |

**Operations**

| Operation | Return type | Description |
| --- | --- | --- |
| `setSpeed(speed : integer)` | `void` | Sets the speed of the belt drive. |

## States

| State | Kind | Description | Entry | Exit | Local reactions | Sub states |
| --- | --- | --- | --- | --- | --- | --- |
| `Idle` | state |   | `mode = conveyor::Mode::Stopped; setSpeed(0); raise modeChanged : mode; led = ::LED_OFF` |   |   |   |
| `Operating` | composite state |   | `led = ::LED_GREEN` |   |   | Running<br>Careful |
| `Operating.Running` | state |   | `mode = conveyor::Mode::Normal; setSpeed(settings.normalSpeed); raise modeChanged : mode` |   | `packageDetected [!valueof(packageDetected).fragile && valueof(packageDetected).weightGrams <= settings.maxWeightGrams] / last = valueof(packageDetected); count++` |   |
| `Operating.Careful` | state |   | `mode = conveyor::Mode::Slow; setSpeed(settings.slowSpeed); raise modeChanged : mode` |   |   |   |
| `Clearing` | state |   | `mode = conveyor::Mode::Reverse; setSpeed(conveyor::kReverseSpeed); raise modeChanged : mode; led = ::LED_BLINKING` |   |   |   |
| `Faulted` | state |   | `mode = conveyor::Mode::Stopped; setSpeed(0); raise modeChanged : mode; led = ::LED_RED` |   |   |   |

## Transitions

| Source | Target | Trigger | Guard | Effect | Priority | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `[*]` (initial, Conveyor) | `Idle` |   |   |   |   |   |
| `[*]` (initial, Operating) | `Operating.Running` |   |   |   |   |   |
| `Operating.Running` | `Operating.Running` | `packageDetected` | `valueof(packageDetected).weightGrams > settings.maxWeightGrams` | `raise rejected : valueof(packageDetected)` | 1 |   |
| `Operating.Running` | `Operating.Careful` | `packageDetected` | `valueof(packageDetected).fragile && valueof(packageDetected).weightGrams <= settings.maxWeightGrams` | `last = valueof(packageDetected); count++` | 2 |   |
| `Operating.Careful` | `Operating.Running` | `after 3 s` |   |   |   |   |
| `Idle` | `Operating` | `start` | `count < conveyor::kMaintenanceInterval` |   |   |   |
| `Operating` | `Idle` | `stop` |   |   | 1 |   |
| `Operating` | `Clearing` | `fault` | `valueof(fault) == conveyor::kJam` | `faults = faults \| valueof(fault)` | 2 |   |
| `Operating` | `Faulted` | `fault` | `valueof(fault) != conveyor::kJam` | `faults = faults \| valueof(fault)` | 3 |   |
| `Clearing` | `Operating` | `after 2 s` |   | `faults = faults & ~conveyor::kJam` |   |   |
| `Faulted` | `Idle` | `reset` | `(faults & conveyor::kEmergencyStop) == 0` | `faults = conveyor::kNoFault` |   |   |

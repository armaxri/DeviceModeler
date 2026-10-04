[← All state machines](index.md)

# Sensor

> Temperature sensor using the enum values of a C++ header

Source: [`examples/cpp-enum-values/sensor.hsm`](../../examples/cpp-enum-values/sensor.hsm)

![Sensor diagram](Sensor.svg)

## Execution

| Property | Value |
| --- | --- |
| Execution | event driven |
| Order | parent first (parent states react before their sub states) |
| Namespace | `example` |
| Annotations | `@EventDriven` |

## Interfaces

### Interface

**Events**

| Event | Direction | Type | Description |
| --- | --- | --- | --- |
| `command` | in | `sensor::Command` | A command received over the serial line. |
| `measured` | in | `integer` | A measured temperature in °C. |
| `timeout` | in |   |   |
| `stateChanged` | out | `sensor::State` |   |

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `current` | var | `sensor::State` | `sensor::State::Off` |   |
| `status` | var | `integer` | `sensor::kNone` | Status flags (sensor::Status). |
| `level` | var | `sensor::Level` | `sensor::kZero` |   |
| `result` | var | `sensor_result_t` | `::SENSOR_OK` |   |

## States

| State | Kind | Description | Entry | Exit | Local reactions | Sub states |
| --- | --- | --- | --- | --- | --- | --- |
| `Off` | state |   | `current = sensor::State::Off; status = sensor::kNone; raise stateChanged : current` |   |   |   |
| `On` | composite state |   | `status = sensor::kReady` |   |   | Ready<br>Measuring |
| `On.Ready` | state |   | `current = sensor::State::Ready; raise stateChanged : current` |   |   |   |
| `On.Measuring` | state |   | `current = sensor::State::Measuring; raise stateChanged : current` |   |   |   |

## Transitions

| Source | Target | Trigger | Guard | Effect | Priority | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `[*]` (initial, Sensor) | `Off` |   |   |   |   |   |
| `[*]` (initial, On) | `On.Ready` |   |   |   |   |   |
| `On.Ready` | `On.Measuring` | `command` | `valueof(command) == sensor::Command::Query` |   |   |   |
| `On.Measuring` | `On.Ready` | `measured` | `valueof(measured) <= 80` | `level = sensor::kNormal; result = ::SENSOR_OK` | 1 |   |
| `On.Measuring` | `On.Ready` | `measured` | `valueof(measured) > 80` | `status = status \| sensor::kOverTemperature; level = sensor::kMaxLevel` | 2 |   |
| `On.Measuring` | `On.Ready` | `timeout` |   | `result = ::SENSOR_TIMEOUT` | 3 |   |
| `Off` | `On` | `command` | `valueof(command) == sensor::Command::Start` |   |   |   |
| `On` | `Off` | `command` | `valueof(command) == sensor::Command::Stop` |   |   |   |

[← All state machines](index.md)

# Door

Automatic door with obstacle detection and a service mode.

Source: [`examples/door.devm`](../../examples/door.devm)

![Door diagram](Door.svg)

## Execution

| Property | Value |
| --- | --- |
| Execution | event driven |
| Order | child first (inner states react before their parents) |
| Annotations | `@EventDriven` `@ChildFirstExecution` |

## Interfaces

### Interface

**Events**

| Event | Direction | Type | Description |
| --- | --- | --- | --- |
| `open` | in |   |   |
| `close` | in |   |   |
| `obstacle` | in |   |   |
| `motorStopped` | in |   |   |
| `serviceDone` | in |   |   |
| `maintenance` | in |   |   |
| `lower` | in |   |   |
| `alarm` | out |   | Raised when the door is blocked by an obstacle. |

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `cycles` | var | `integer` | `0` | Number of times the door has been closed. |

## States

| State | Kind | Description | Entry | Exit | Local reactions | Sub states |
| --- | --- | --- | --- | --- | --- | --- |
| `Closed` | state |   | `cycles += 1` |   |   |   |
| `Moving` | composite state | The motor moves the door up (entry point `Opening`) or down (`Closing`). |   |   |   | Opening<br>Closing<br>Blocked<br>Up<br>Down |
| `Moving.Opening` | entry point |   |   |   |   |   |
| `Moving.Closing` | entry point |   |   |   |   |   |
| `Moving.Blocked` | exit node |   |   |   |   |   |
| `Moving.Up` | state |   |   |   |   |   |
| `Moving.Down` | state |   |   |   |   |   |
| `Service` | orthogonal state |   |   |   |   | Lock: Unlocked, Locked<br>Light: Off, On |
| `Service.Unlocked` | state |   |   |   |   |   |
| `Service.Locked` | state |   |   |   |   |   |
| `Service.Off` | state |   |   |   |   |   |
| `Service.On` | state |   |   |   |   |   |
| `Fork` | synchronization | Enters both regions of `Service` at once. |   |   |   |   |
| `Join` | synchronization |   |   |   |   |   |

## Transitions

| Source | Target | Trigger | Guard | Effect | Priority | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `[*]` (initial, Door) | `Closed` |   |   |   |   |   |
| `Moving.Opening` | `Moving.Up` |   |   |   |   |   |
| `Moving.Closing` | `Moving.Down` |   |   |   |   |   |
| `Moving.Up` | `Moving.Blocked` | `obstacle` |   |   | 1 |   |
| `Moving.Down` | `Moving.Blocked` | `obstacle` |   |   | 1 |   |
| `[*]` (initial, Service (region Lock)) | `Service.Unlocked` |   |   |   |   |   |
| `Service.Unlocked` | `Service.Locked` | `close` |   |   |   |   |
| `[*]` (initial, Service (region Light)) | `Service.Off` |   |   |   |   |   |
| `Service.Off` | `Service.On` | `open` |   |   |   |   |
| `Closed` | `Moving` via entry `Opening` | `open` |   |   | 1 |   |
| `Closed` | `Service` | `maintenance` |   |   | 2 |   |
| `Service` | `Moving` via entry `Closing` | `lower` |   |   |   |   |
| `Moving.Up` | `Closed` | `motorStopped` |   |   | 2 |   |
| `Moving.Down` | `Closed` | `motorStopped` |   |   | 2 |   |
| `Moving` via exit `Blocked` | `Fork` |   |   | `raise alarm` |   |   |
| `Fork` | `Service.Locked` |   |   |   |   |   |
| `Fork` | `Service.On` |   |   |   |   |   |
| `Service.Locked` | `Join` | `serviceDone` |   |   |   |   |
| `Service.On` | `Join` | `serviceDone` |   |   |   |   |
| `Join` | `Closed` |   |   |   |   |   |

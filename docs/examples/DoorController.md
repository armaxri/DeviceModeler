[← All state machines](index.md)

# DoorController

Opens and closes the door on request and stops at obstacles.

Source: [`examples/device/controller.devm`](../../examples/device/controller.devm)

![DoorController diagram](DoorController.svg)

## Execution

| Property | Value |
| --- | --- |
| Execution | event driven |
| Order | parent first (parent states react before their sub states) |
| Annotations | `@EventDriven` |

## Interfaces

### Interface `remote`

Commands of the remote control (ports `open`, `close`, `stop`).

**Events**

| Event | Direction | Type | Description |
| --- | --- | --- | --- |
| `open` | in |   |   |
| `close` | in |   |   |
| `stop` | in |   |   |

### Interface `drive`

The drive unit (ports `up`, `down`, `halt`, `stopped`, `blocked`).

**Events**

| Event | Direction | Type | Description |
| --- | --- | --- | --- |
| `up` | out | `integer` | Opens with the given speed in percent. |
| `down` | out | `integer` | Closes with the given speed in percent. |
| `halt` | out |   |   |
| `stopped` | in |   | The drive reached an end position. |
| `blocked` | in |   | The drive detected an obstacle. |

### Interface

**Events**

| Event | Direction | Type | Description |
| --- | --- | --- | --- |
| `alarm` | out |   | Sounds the buzzer (port `alarm`). |

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `position` | var readonly | `door::Position` | (default) | The position of the door, written by the encoder (port `position`). |
| `cycles` | var | `integer` | `0` | Number of completed closing cycles (port `cycles`). |
| `errors` | var | `integer` | `0` | Number of obstacles, shared with the diagnosis (port `errors`). |

## States

| State | Kind | Description | Entry | Exit | Local reactions | Sub states |
| --- | --- | --- | --- | --- | --- | --- |
| `Closed` | state |   |   |   |   |   |
| `Opening` | state |   | `raise drive.up : 100` |   |   |   |
| `Open` | state |   |   |   |   |   |
| `Closing` | state |   | `raise drive.down : 60` |   |   |   |
| `Blocked` | state |   | `errors += 1; raise alarm` |   |   |   |

## Transitions

| Source | Target | Trigger | Guard | Effect | Priority | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `[*]` (initial, DoorController) | `Closed` |   |   |   |   |   |
| `Closed` | `Opening` | `remote.open` |   |   |   |   |
| `Opening` | `Open` | `drive.stopped` |   |   | 1 |   |
| `Opening` | `Open` | `remote.stop` |   | `raise drive.halt` | 2 |   |
| `Opening` | `Blocked` | `drive.blocked` |   |   | 3 |   |
| `Open` | `Closing` | `remote.close` | `position.valid` |   |   |   |
| `Closing` | `Closed` | `drive.stopped` |   | `cycles += 1` | 1 |   |
| `Closing` | `Open` | `remote.stop` |   | `raise drive.halt` | 2 |   |
| `Closing` | `Blocked` | `drive.blocked` |   |   | 3 |   |
| `Blocked` | `Opening` | `remote.open` |   |   |   |   |

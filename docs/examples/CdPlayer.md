[← All state machines](index.md)

# CdPlayer

> Hierarchical CD player

CD player with a history state: after closing the lid the player  
resumes the mode it was in before.

Source: [`examples/cd-player.devm`](../../examples/cd-player.devm)

![CdPlayer diagram](CdPlayer.svg)

## Execution

| Property | Value |
| --- | --- |
| Execution | cycle based, period `200 ms` |
| Order | parent first (parent states react before their sub states) |

## Interfaces

### Interface

**Events**

| Event | Direction | Type | Description |
| --- | --- | --- | --- |
| `play` | in |   | Play button: starts playing (or resumes a paused track). |
| `pause` | in |   |   |
| `stop` | in |   |   |
| `eject` | in |   |   |
| `powerOff` | in |   |   |
| `trackEnd` | in |   | The current track has ended. |

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `track` | var | `integer` | `1` | Number of the current track (1-based). |
| `tracks` | var | `integer` | `0` | Number of tracks of the inserted disc (set by the host). |

**Operations**

| Operation | Return type | Description |
| --- | --- | --- |
| `discInserted()` | `boolean` | Whether a disc is in the tray (implemented by the host). |
| `startMotor()` | `void` |   |
| `stopMotor()` | `void` |   |

## States

| State | Kind | Description | Entry | Exit | Local reactions | Sub states |
| --- | --- | --- | --- | --- | --- | --- |
| `Closed` | composite state |   |   |   |   | H<br>Stopped<br>Active<br>HasDisc |
| `Closed.H` | shallow history | Remembers the last active sub state of `Closed` when the tray is opened. |   |   |   |   |
| `Closed.Stopped` | state |   | `track = 1` |   |   |   |
| `Closed.Active` | composite state |   |   |   |   | Playing<br>Paused |
| `Closed.Active.Playing` | state |   | `startMotor()` | `stopMotor()` | `trackEnd [track < tracks] / track += 1` |   |
| `Closed.Active.Paused` | state |   |   |   |   |   |
| `Closed.HasDisc` | choice | Playing starts only if a disc with tracks is inserted. |   |   |   |   |
| `Open` | state | Tray is open |   |   |   |   |

## Transitions

| Source | Target | Trigger | Guard | Effect | Priority | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `[*]` (initial, CdPlayer) | `Closed` |   |   |   |   |   |
| `[*]` (initial, Closed) | `Closed.Stopped` |   |   |   |   |   |
| `[*]` (initial, Closed.Active) | `Closed.Active.Playing` |   |   |   |   |   |
| `Closed.Active.Playing` | `Closed.Active.Paused` | `pause` |   |   |   |   |
| `Closed.Active.Paused` | `Closed.Active.Playing` | `pause`, `play` |   |   |   |   |
| `Closed.Stopped` | `Closed.HasDisc` | `play` |   |   |   |   |
| `Closed.HasDisc` | `Closed.Active` |   | `discInserted() && tracks > 0` |   | 1 |   |
| `Closed.HasDisc` | `Closed.Stopped` | `else` |   |   | 2 |   |
| `Closed.Active` | `Closed.Stopped` | `stop` |   |   |   |   |
| `Closed` | `Open` | `eject` |   |   | 1 |   |
| `Open` | `Closed.H` | `eject` |   |   | 1 | Closing the tray resumes the previous mode via the history state. |
| `Closed` | `[*]` (final, CdPlayer) | `powerOff` |   |   | 2 |   |
| `Open` | `[*]` (final, CdPlayer) | `powerOff` |   |   | 2 |   |

# Example state machines

| State machine | Description | Source |
| --- | --- | --- |
| [CdPlayer](CdPlayer.md) | Hierarchical CD player<br>CD player with a history state: after closing the lid the player resumes the mode it was in before. | [`examples/cd-player.devm`](../../examples/cd-player.devm) |
| [Door](Door.md) | Automatic door with obstacle detection and a service mode. | [`examples/door.devm`](../../examples/door.devm) |
| [Keyboard](Keyboard.md) | LEDs of a keyboard; suspending the keyboard keeps the lock states. | [`examples/keyboard.devm`](../../examples/keyboard.devm) |
| [TrafficLight](TrafficLight.md) | Traffic light with a pedestrian request button. The lights are switched by the host through the internal operation `switchOn`. | [`examples/traffic-light.devm`](../../examples/traffic-light.devm) |

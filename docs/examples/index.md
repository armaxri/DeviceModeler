# Example state machines

| State machine | Description | Source |
| --- | --- | --- |
| [CdPlayer](CdPlayer.md) | Hierarchical CD player<br>CD player with a history state: after closing the lid the player resumes the mode it was in before. | [`examples/cd-player.hsm`](../../examples/cd-player.hsm) |
| [Door](Door.md) | Automatic door with obstacle detection and a service mode. | [`examples/door.hsm`](../../examples/door.hsm) |
| [Keyboard](Keyboard.md) | LEDs of a keyboard; suspending the keyboard keeps the lock states. | [`examples/keyboard.hsm`](../../examples/keyboard.hsm) |
| [TrafficLight](TrafficLight.md) | Traffic light with a pedestrian request button. The lights are switched by the host through the internal operation `switchOn`. | [`examples/traffic-light.hsm`](../../examples/traffic-light.hsm) |

import type { NavigationLocation, NavigationState } from '../../common/protocol.js';

/** The most entries kept in each direction. */
const HISTORY_LIMIT = 50;

/**
 * The navigation history of the diagrams (Back / Forward), shared by all diagram panels: navigating from a
 * diagram (double-click on an instance, "go to source", "used by", …) records the location it came from;
 * Back returns to it and records the current location for Forward.
 */
export class NavigationHistory {

    private readonly back: NavigationLocation[] = [];
    private readonly forward: NavigationLocation[] = [];

    /** A navigation from `from`: Back returns there, the Forward entries are dropped. */
    record(from: NavigationLocation): void {
        const last = this.back[this.back.length - 1];
        if (!last || !sameLocation(last, from)) {
            this.back.push(from);
            if (this.back.length > HISTORY_LIMIT) {
                this.back.shift();
            }
        }
        this.forward.length = 0;
    }

    /** The location to go back to (undefined: none); `current` becomes the next Forward target. */
    goBack(current: NavigationLocation): NavigationLocation | undefined {
        return this.move(this.back, this.forward, current);
    }

    /** The location to go forward to (undefined: none); `current` becomes the next Back target. */
    goForward(current: NavigationLocation): NavigationLocation | undefined {
        return this.move(this.forward, this.back, current);
    }

    /** Labels of the next Back / Forward targets (for the buttons of the diagrams). */
    get state(): NavigationState {
        const back = this.back[this.back.length - 1];
        const forward = this.forward[this.forward.length - 1];
        return { back: back && locationLabel(back), forward: forward && locationLabel(forward) };
    }

    private move(from: NavigationLocation[], to: NavigationLocation[], current: NavigationLocation): NavigationLocation | undefined {
        const target = from.pop();
        if (target) {
            to.push(current);
        }
        return target;
    }
}

/** Whether two locations show the same element. */
export function sameLocation(a: NavigationLocation, b: NavigationLocation): boolean {
    return a.uri === b.uri && a.element === b.element && a.id === b.id && a.offset === b.offset
        && JSON.stringify(a.context ?? null) === JSON.stringify(b.context ?? null);
}

/** `system.devm – GarageDoor (GarageDoor/door)`: the label of a location (tooltips of Back / Forward). */
export function locationLabel(location: NavigationLocation): string {
    const file = decodeURIComponent(location.uri.replace(/^.*\//, ''));
    const element = location.element ? ` – ${location.element}` : '';
    const id = location.id && location.id !== location.element ? ` (${location.id})` : '';
    return file + element + id;
}

import { describe, expect, it } from 'vitest';
import { locationLabel, NavigationHistory, sameLocation } from '../../src/extension/logic/navigation.js';
import { textHash } from '../../src/common/text-hash.js';

const SYSTEM = { uri: 'file:///w/system.devm', element: 'GarageDoor', id: 'GarageDoor/door' };
const DRIVE = { uri: 'file:///w/drive.devm', element: 'DriveUnit', context: { rootUri: 'file:///w/system.devm', root: 'GarageDoor', path: ['drive'] } };
const MACHINE = { uri: 'file:///w/my%20door.devm', offset: 12 };

describe('navigation history of the diagrams', () => {
    it('goes back and forward through the recorded locations', () => {
        const history = new NavigationHistory();
        expect(history.state).toEqual({ back: undefined, forward: undefined });
        // system -> drive -> state machine
        history.record(SYSTEM);
        history.record(DRIVE);
        expect(history.state.back).toBe('drive.devm – DriveUnit');
        expect(history.goBack(MACHINE)).toEqual(DRIVE);
        expect(history.state).toEqual({ back: 'system.devm – GarageDoor (GarageDoor/door)', forward: 'my door.devm' });
        expect(history.goBack(DRIVE)).toEqual(SYSTEM);
        expect(history.goBack(SYSTEM)).toBeUndefined();
        expect(history.goForward(SYSTEM)).toEqual(DRIVE);
        expect(history.goForward(DRIVE)).toEqual(MACHINE);
        expect(history.goForward(MACHINE)).toBeUndefined();
        // a new navigation drops the forward entries
        history.goBack(MACHINE);
        history.record(DRIVE);
        expect(history.state.forward).toBeUndefined();
    });

    it('records a location once when navigating repeatedly from it', () => {
        const history = new NavigationHistory();
        history.record(SYSTEM);
        history.record({ ...SYSTEM });
        expect(history.goBack(DRIVE)).toEqual(SYSTEM);
        expect(history.goBack(SYSTEM)).toBeUndefined();
        expect(sameLocation(DRIVE, { ...DRIVE, context: { ...DRIVE.context, path: [] } })).toBe(false);
    });

    it('keeps at most 50 locations', () => {
        const history = new NavigationHistory();
        for (let i = 0; i < 60; i++) {
            history.record({ uri: `file:///w/${i}.devm` });
        }
        let count = 0;
        while (history.goBack({ uri: 'file:///w/x.devm' })) {
            count++;
        }
        expect(count).toBe(50);
        expect(locationLabel({ uri: 'file:///w/a.devm', element: 'A', id: 'A' })).toBe('a.devm – A');
    });
});

describe('text hashes of workspace edits', () => {
    it('distinguishes texts', () => {
        expect(textHash('system A {}')).toBe(textHash('system A {}'));
        expect(textHash('system A {}')).not.toBe(textHash('system B {}'));
        expect(textHash('')).toBe(0x811c9dc5);
    });
});

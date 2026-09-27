import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutFileSync, layoutPathOf, layoutWriteAction, moveLayoutFile, type LayoutFileSystem } from '../../src/extension/logic/layout-file.js';

/** An in-memory file system recording the operations. */
class MemoryFs implements LayoutFileSystem {
    readonly files = new Map<string, string>();
    readonly log: string[] = [];

    async read(path: string): Promise<string | undefined> {
        return this.files.get(path);
    }

    async write(path: string, content: string): Promise<void> {
        this.log.push(`write ${path}`);
        this.files.set(path, content);
    }

    async delete(path: string): Promise<void> {
        this.log.push(`delete ${path}`);
        this.files.delete(path);
    }

    async exists(path: string): Promise<boolean> {
        return this.files.has(path);
    }

    async rename(from: string, to: string): Promise<void> {
        this.log.push(`rename ${from} ${to}`);
        this.files.set(to, this.files.get(from)!);
        this.files.delete(from);
    }
}

const MODEL = '/work/lamp.hsm';
const LAYOUT = '/work/lamp.hsm.layout';
const manual = (x: number) => ({ content: JSON.stringify({ version: 1, mode: 'manual', nodes: { A: { x, y: 0 } }, edges: {} }), mode: 'manual' as const });
const auto = { content: JSON.stringify({ version: 1, mode: 'auto', nodes: { A: { x: 1, y: 0 } }, edges: {} }), mode: 'auto' as const };

describe('layoutPathOf', () => {
    it('appends .layout to the model path', () => {
        expect(layoutPathOf(MODEL)).toBe(LAYOUT);
    });
});

describe('layoutWriteAction', () => {
    it('writes manual layouts', () => {
        expect(layoutWriteAction(manual(1), false)).toBe('write');
        expect(layoutWriteAction(manual(1), true, manual(2).content)).toBe('write');
    });

    it('writes layouts in the automatic mode only if the file exists', () => {
        expect(layoutWriteAction(auto, false)).toBe('none');
        expect(layoutWriteAction(auto, true, manual(1).content)).toBe('write');
    });

    it('does not rewrite an unchanged file', () => {
        expect(layoutWriteAction(manual(1), true, manual(1).content)).toBe('none');
    });

    it('deletes the file when the layout is discarded', () => {
        expect(layoutWriteAction(undefined, true)).toBe('delete');
        expect(layoutWriteAction(undefined, false)).toBe('none');
    });
});

describe('LayoutFileSync', () => {
    let fs: MemoryFs;

    beforeEach(() => {
        vi.useFakeTimers();
        fs = new MemoryFs();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('loads the layout file (undefined if there is none)', async () => {
        const sync = new LayoutFileSync(fs, MODEL);
        expect(await sync.load()).toBeUndefined();
        fs.files.set(LAYOUT, manual(3).content);
        expect(await sync.load()).toBe(manual(3).content);
    });

    it('writes changes debounced (the last one wins)', async () => {
        const sync = new LayoutFileSync(fs, MODEL, { debounceMs: 300 });
        sync.update(manual(1));
        sync.update(manual(2));
        await vi.advanceTimersByTimeAsync(299);
        expect(fs.files.has(LAYOUT)).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await sync.flush();
        expect(fs.files.get(LAYOUT)).toBe(manual(2).content);
        expect(fs.log).toEqual([`write ${LAYOUT}`]);
    });

    it('does not create a file for the automatic mode, but keeps an existing one up to date', async () => {
        const sync = new LayoutFileSync(fs, MODEL);
        sync.update(auto);
        await sync.flush();
        expect(fs.files.has(LAYOUT)).toBe(false);
        fs.files.set(LAYOUT, manual(1).content);
        sync.update(auto);
        await sync.flush();
        expect(fs.files.get(LAYOUT)).toBe(auto.content);
    });

    it('deletes the file on reset', async () => {
        fs.files.set(LAYOUT, manual(1).content);
        const sync = new LayoutFileSync(fs, MODEL);
        await sync.load();
        sync.update(undefined);
        await sync.flush();
        expect(fs.files.has(LAYOUT)).toBe(false);
        expect(fs.log).toEqual([`delete ${LAYOUT}`]);
    });

    it('tells external changes apart from its own writes', async () => {
        const sync = new LayoutFileSync(fs, MODEL);
        await sync.load();
        sync.update(manual(1));
        await sync.flush();
        // the watcher reports our own write
        expect(await sync.externalChange()).toBeUndefined();
        // another tool (e.g. git checkout) changes the file
        fs.files.set(LAYOUT, manual(5).content);
        expect(await sync.externalChange()).toEqual({ content: manual(5).content });
        expect(await sync.externalChange()).toBeUndefined();
        // ... and deletes it
        fs.files.delete(LAYOUT);
        expect(await sync.externalChange()).toEqual({ content: undefined });
    });

    it('ignores external changes while an own change is pending', async () => {
        const sync = new LayoutFileSync(fs, MODEL);
        await sync.load();
        sync.update(manual(1));
        fs.files.set(LAYOUT, manual(7).content);
        expect(await sync.externalChange()).toBeUndefined();
        await sync.flush();
        expect(fs.files.get(LAYOUT)).toBe(manual(1).content);
    });

    it('writes to the new path after the model was renamed (pending changes to the old one first)', async () => {
        const sync = new LayoutFileSync(fs, MODEL);
        sync.update(manual(1));
        await sync.modelRenamed('/work/door.hsm');
        expect(fs.files.get(LAYOUT)).toBe(manual(1).content);
        expect(await moveLayoutFile(fs, MODEL, '/work/door.hsm')).toBe(true);
        sync.update(manual(2));
        await sync.flush();
        expect(fs.files.get('/work/door.hsm.layout')).toBe(manual(2).content);
        expect(fs.files.has(LAYOUT)).toBe(false);
    });

    it('writes a pending change when disposed', async () => {
        const sync = new LayoutFileSync(fs, MODEL);
        sync.update(manual(4));
        sync.dispose();
        await vi.runAllTimersAsync();
        expect(fs.files.get(LAYOUT)).toBe(manual(4).content);
    });

    it('reports write errors', async () => {
        const errors: unknown[] = [];
        fs.write = async () => {
            throw new Error('read-only file system');
        };
        const sync = new LayoutFileSync(fs, MODEL, { debounceMs: 10, onError: error => errors.push(error) });
        sync.update(manual(1));
        await vi.advanceTimersByTimeAsync(20);
        expect(errors).toHaveLength(1);
        // later writes are still attempted
        fs.write = MemoryFs.prototype.write.bind(fs);
        sync.update(manual(2));
        await sync.flush();
        expect(fs.files.get(LAYOUT)).toBe(manual(2).content);
    });
});

describe('moveLayoutFile', () => {
    it('moves the layout file along with the model', async () => {
        const fs = new MemoryFs();
        fs.files.set(LAYOUT, 'x');
        expect(await moveLayoutFile(fs, MODEL, '/other/lamp2.hsm')).toBe(true);
        expect(fs.files.get('/other/lamp2.hsm.layout')).toBe('x');
        expect(fs.files.has(LAYOUT)).toBe(false);
    });

    it('does nothing without a layout file, if the layout file was renamed as well, or if the target exists', async () => {
        const fs = new MemoryFs();
        expect(await moveLayoutFile(fs, MODEL, '/work/b.hsm')).toBe(false);
        fs.files.set(LAYOUT, 'x');
        expect(await moveLayoutFile(fs, MODEL, '/work/b.hsm', new Set([LAYOUT]))).toBe(false);
        fs.files.set('/work/b.hsm.layout', 'y');
        expect(await moveLayoutFile(fs, MODEL, '/work/b.hsm')).toBe(false);
        expect(fs.files.get('/work/b.hsm.layout')).toBe('y');
        expect(fs.log).toEqual([]);
    });
});

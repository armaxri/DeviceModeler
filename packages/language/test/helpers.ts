import * as fs from 'node:fs';
import * as path from 'node:path';
import { HsmModelLoader } from '../src/hsm-document.js';

export const loader = new HsmModelLoader();

export function example(name: string): string {
    return fs.readFileSync(path.resolve(__dirname, '../../../examples', name), 'utf-8');
}

/** Parses a model; `files` are further files it may import, by path relative to the model (`motor.hsm`). */
export async function parse(text: string, files?: Record<string, string>) {
    return loader.load(text, undefined, { files });
}

export function errors(parsed: Awaited<ReturnType<typeof parse>>): string[] {
    return parsed.diagnostics.filter(d => d.severity === 1).map(d => d.message);
}

export function warnings(parsed: Awaited<ReturnType<typeof parse>>): string[] {
    return parsed.diagnostics.filter(d => d.severity === 2).map(d => d.message);
}

/**
 * The scenarios of submachine instances (docs/semantics.md §9). The C and C++ generators do not
 * support submachine instances yet: they report the diagnostic `SUBMACHINES_NOT_SUPPORTED`, and the
 * generator conformance tests skip exactly these scenarios (checked by the tests).
 */
export const SUBMACHINE_SCENARIOS: readonly string[] = [
    's9-active-and-valueof.json',
    's9-entry-point.json',
    's9-event-driven.json',
    's9-events-to-inactive-instance-discarded.json',
    's9-exit-node.json',
    's9-final-state-no-completion.json',
    's9-instance-lifecycle.json',
    's9-instance-variables.json',
    's9-nested-instances.json',
    's9-operations-of-instance.json',
    's9-out-event-child-first-transition.json',
    's9-out-event-child-first.json',
    's9-out-event-parent-first.json',
    's9-out-event-seen-once.json',
    's9-raise-into-instance-child-first.json',
    's9-raise-into-instance-next-cycle.json',
    's9-raise-into-instance-same-cycle.json',
    's9-time-events.json',
    's9-two-instances.json'
];

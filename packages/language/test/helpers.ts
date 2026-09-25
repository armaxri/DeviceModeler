import * as fs from 'node:fs';
import * as path from 'node:path';
import { HsmModelLoader } from '../src/hsm-document.js';

export const loader = new HsmModelLoader();

export function example(name: string): string {
    return fs.readFileSync(path.resolve(__dirname, '../../../examples', name), 'utf-8');
}

export async function parse(text: string) {
    return loader.load(text);
}

export function errors(parsed: Awaited<ReturnType<typeof parse>>): string[] {
    return parsed.diagnostics.filter(d => d.severity === 1).map(d => d.message);
}

export function warnings(parsed: Awaited<ReturnType<typeof parse>>): string[] {
    return parsed.diagnostics.filter(d => d.severity === 2).map(d => d.message);
}

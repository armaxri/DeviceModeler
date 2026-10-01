// `hsm validate --json`: the problems of models in a machine readable form (used by the Eclipse plugin's builder
// to validate closed files with the bundled executable).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { URI } from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import { NodeFileSystem } from 'langium/node';
import { createHsmServices } from '../hsm-module.js';
import { HsmModelLoader } from '../hsm-document.js';
import { installNodeHeaderSupport, cliHeaderSettings, type NodeHeaderOptions } from '../node/cpp-headers-node.js';

/** Options of the C/C++ header analysis (`-I`, `-D`, `--data-model`). */
export interface HeaderOptions {
    include?: string[];
    define?: string[];
    dataModel?: string;
}

function nodeHeaderOptions(options: HeaderOptions): NodeHeaderOptions {
    return { settings: cliHeaderSettings(options) };
}

/** A problem in the output of `hsm validate --json`: 1-based lines / columns, UTF-16 offsets into the file. */
export interface JsonProblem {
    /** Absolute path of the file of the problem (the validated model, or a model it imports). */
    path: string;
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    offset: number;
    end: number;
}

/** The result of `hsm validate --json`. */
export interface JsonValidation {
    files: Array<{ file: string, path: string, problems: JsonProblem[] }>;
}

/** Validates models for `hsm validate --json`: their problems and the errors of the models they import. */
export async function validateJson(files: string[], options: HeaderOptions = {}): Promise<JsonValidation> {
    const result: JsonValidation = { files: [] };
    for (const file of files) {
        const absolute = path.resolve(file);
        const problems: JsonProblem[] = [];
        try {
            const services = createHsmServices(NodeFileSystem);
            installNodeHeaderSupport(services.shared, nodeHeaderOptions(options));
            const text = await fs.readFile(file, 'utf-8');
            const parsed = await new HsmModelLoader(services).load(text, URI.file(absolute).toString());
            problems.push(...parsed.diagnostics.map(d => jsonProblem(absolute, text, d)));
            for (const imported of parsed.imported) {
                const importedPath = URI.parse(imported.uri).fsPath;
                const importedText = await fs.readFile(importedPath, 'utf-8').catch(() => '');
                problems.push(...imported.diagnostics.filter(d => d.severity === 1).map(d => jsonProblem(importedPath, importedText, d)));
            }
        } catch (error) {
            problems.push({ path: absolute, severity: 'error', message: error instanceof Error ? error.message : String(error), line: 0, column: 0, endLine: 0, endColumn: 0, offset: -1, end: -1 });
        }
        result.files.push({ file, path: absolute, problems });
    }
    return result;
}

function jsonProblem(file: string, text: string, d: Diagnostic): JsonProblem {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            lineStarts.push(i + 1);
        }
    }
    const offsetOf = (position: { line: number, character: number }) =>
        Math.min(text.length, (lineStarts[position.line] ?? text.length) + position.character);
    return {
        path: file,
        severity: (['error', 'error', 'warning', 'info', 'hint'] as const)[d.severity ?? 1],
        message: typeof d.message === 'string' ? d.message : d.message.value,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        endLine: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        offset: offsetOf(d.range.start),
        end: offsetOf(d.range.end)
    };
}

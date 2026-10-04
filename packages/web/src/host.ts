/**
 * Embedding of the web app in another application (the Eclipse plugin in `eclipse-plugin/`, the JetBrains plugin in
 * `jetbrains-plugin/`, the desktop app).
 *
 * The app is embedded when its URL has the query parameter `?host=http`: the page is then served by a
 * host that holds the edited file and offers a small HTTP API next to the page (relative URLs `api/…`).
 * Paths are relative to the root of the host's workspace boundary (in Eclipse: the project), with `/`.
 *
 * - `GET  api/document` → {@link HostDocument}: the edited file, its text, the files it may import,
 *   generator configurations, C++ settings, stored page settings and the theme of the host
 * - `GET  api/file?path=…` → the text of another file (e.g. a license header file of `devm.gen.json`)
 * - `POST api/changed` (text body): the text was changed (the host updates its dirty state)
 * - `POST api/save` (text body): save the text (`Ctrl+S`, *Save*)
 * - `POST api/model` (JSON {@link HostModelReport}): problems and outline of the model after every validation
 * - `POST api/settings` (JSON body): the page settings (theme, layout, …) to store
 * - `POST api/open?line=…&column=…&endLine=…&endColumn=…` (text body: path): open another file of the root in
 *   the host's editor for its type: a model (double-click on a submachine state, go to definition into an
 *   imported model) or a C/C++ header (go to definition / declaration / type definition of a C++ name,
 *   Ctrl+Click on `import "motor.h"`). The query parameters are optional ({@link HostOpenPosition}, 1-based,
 *   UTF-16 columns as in Monaco; pages before them sent none): the host selects the range and reveals it.
 *   Answers 2xx if it opened the file, 404 if it does not exist or the host cannot open it (the page then
 *   shows a header itself, read-only). Hosts that do not know the parameters ignore them.
 *   A navigation of the diagram to another file also sends `location=<JSON>` (a `DiagramLocation` of
 *   structure-diagram.ts: the structure or component type to show, the element to select and the instance tree
 *   context, i.e. the breadcrumb of a subsystem part): a host that knows it passes it on to the page of the file
 *   (`index.html?host=http&location=…`, or `revealLocation(json)` of a page that is already open).
 * - `POST api/export?fileName=…` (binary body): store an exported diagram; answers `{ message }`
 * - `POST api/generate` (JSON {@link HostGeneratedFiles}): write generated files; answers `{ message }`
 *
 * The host calls functions of the page (`window.devmApp`): `reloadFromHost(replaceText)` after external
 * changes, `hostCommand(name, argument)` for its edit commands (undo, copy, find, …), `revealRange(offset, end)`
 * (problem markers, outline), `revealPosition(line, column, endLine?, endColumn?)` (1-based, like `api/open`:
 * a host opened the model at a position), `revealLocation(json)` (see `api/open`), `generateCpp()`, `getText()` and `setHostTheme('light' | 'dark')`
 * (the theme of the host changed; optional, hosts check that they exist).
 * The page also reveals a position given in its URL at the start: `index.html?host=http&line=…&column=…`
 * (`endLine`, `endColumn`), and `index.html?host=http&view=<path>&line=…` shows another file of the root
 * read-only instead of the editor (the header viewer windows of the desktop app).
 * Without the query parameter nothing of this is used and the app keeps its files in the browser.
 */

export interface HostDocument {
    /** Name of the edited file (shown in the page). */
    fileName: string;
    /** Path of the edited file (imports are resolved against it); default: `fileName`. */
    path?: string;
    text: string;
    /** Files the edited file may import: path → text. */
    files?: Record<string, string>;
    /** Generator configurations (`devm.gen.json`, `*.devm.gen.json`) from the directory of the model upwards, nearest first. */
    configs?: Array<{ path: string, text: string }>;
    /** Settings of the C++ generation if no configuration lists the model (like `devm.cpp.*` in VS Code). */
    cppSettings?: HostCppSettings;
    /** The page settings stored by the host (JSON, see `api/settings`). */
    settings?: string;
    /** Theme of the host: the page follows a dark host theme. */
    theme?: 'light' | 'dark';
}

/** A position or range in a file (1-based lines and columns, UTF-16 code units as in Monaco). */
export interface HostOpenPosition {
    line: number;
    column: number;
    /** End of the range to select (default: the position). */
    endLine?: number;
    endColumn?: number;
}

/** The query of `api/open` for a position (empty without one). */
export function openQuery(position?: HostOpenPosition): string {
    if (!position) {
        return '';
    }
    const parameters = new URLSearchParams({ line: String(position.line), column: String(position.column) });
    if (position.endLine !== undefined && position.endColumn !== undefined) {
        parameters.set('endLine', String(position.endLine));
        parameters.set('endColumn', String(position.endColumn));
    }
    return `?${parameters.toString()}`;
}

/** The position of URL query parameters (`line`, `column`, `endLine`, `endColumn`), undefined without a valid line. */
export function positionOfQuery(parameters: URLSearchParams): HostOpenPosition | undefined {
    const number = (name: string) => {
        const value = Number(parameters.get(name));
        return parameters.has(name) && Number.isInteger(value) && value >= 1 ? value : undefined;
    };
    const line = number('line');
    if (line === undefined) {
        return undefined;
    }
    const endLine = number('endLine');
    const endColumn = number('endColumn');
    return { line, column: number('column') ?? 1, ...endLine !== undefined && endColumn !== undefined ? { endLine, endColumn } : {} };
}

export interface HostCppSettings {
    /** Relative to the model; `${project}` is the root; empty: the directory of the model. */
    outputDirectory?: string;
    /** `null` / absent: the namespace of the model; `''`: the global namespace. */
    namespace?: string | null;
    standard?: '11' | '17';
}

export interface HostProblem {
    severity: 'error' | 'warning' | 'info';
    message: string;
    /** 1-based line and column of the start. */
    line: number;
    column: number;
    /** Offsets (UTF-16 code units) of the range in the text. */
    offset: number;
    end: number;
}

export interface HostOutlineNode {
    label: string;
    /**
     * State machines: `statemachine`, `definitions`, `state`, `region`, `pseudostate`, `transition`, `reaction`;
     * structure files: `struct`, `field`, `component`, `subsystem`, `system`, `behavior`, `port`, `thread`,
     * `instance`, `connection`, `delegation`.
     */
    kind: string;
    offset: number;
    end: number;
    children?: HostOutlineNode[];
}

export interface HostModelReport {
    /** The text the report belongs to has this length (offsets of a newer text may differ). */
    textLength: number;
    problems: HostProblem[];
    outline: HostOutlineNode[];
}

export interface HostGeneratedFiles {
    files: Array<{ path: string, content: string }>;
    /** Problems of the generation, for the log of the host. */
    messages: string[];
}

export class HttpHost {

    /** The host of the page, if it is embedded (`?host=http`). */
    static detect(): HttpHost | undefined {
        try {
            return new URLSearchParams(window.location.search).get('host') === 'http' ? new HttpHost() : undefined;
        } catch {
            return undefined;
        }
    }

    private changeTimer?: ReturnType<typeof setTimeout>;
    private lastReport?: string;

    async load(): Promise<HostDocument> {
        const response = await fetch('api/document', { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`The host did not provide the document (${response.status} ${response.statusText}).`);
        }
        return await response.json() as HostDocument;
    }

    /** The text of another file of the host, undefined if it does not exist. */
    async file(path: string): Promise<string | undefined> {
        const response = await fetch(`api/file?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
        return response.ok ? await response.text() : undefined;
    }

    /** Reports a change of the text (debounced). */
    changed(getText: () => string): void {
        clearTimeout(this.changeTimer);
        this.changeTimer = setTimeout(() => {
            void this.post('api/changed', getText(), 'text/plain;charset=utf-8').catch(error => console.error(error));
        }, 150);
    }

    async save(text: string): Promise<void> {
        clearTimeout(this.changeTimer);
        await this.post('api/save', text, 'text/plain;charset=utf-8');
    }

    /** Reports the problems and the outline of the model (only if they changed). */
    model(report: HostModelReport): void {
        const json = JSON.stringify(report);
        if (json === this.lastReport) {
            return;
        }
        this.lastReport = json;
        void this.post('api/model', json, 'application/json').catch(error => console.error(error));
    }

    settings(settings: object): void {
        void this.post('api/settings', JSON.stringify(settings), 'application/json').catch(error => console.error(error));
    }

    /** Asks the host to open a file of its root (a model or a header), optionally at a position; false if it did not. */
    async open(path: string, position?: HostOpenPosition, location?: object): Promise<boolean> {
        let query = openQuery(position);
        if (location) {
            query += `${query ? '&' : '?'}location=${encodeURIComponent(JSON.stringify(location))}`;
        }
        const response = await fetch(`api/open${query}`, { method: 'POST', body: path, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
        return response.ok;
    }

    /** Stores an exported file (the host decides where); returns the message of the host. */
    async export(fileName: string, content: string | Blob): Promise<string> {
        const response = await this.post(`api/export?fileName=${encodeURIComponent(fileName)}`, content, 'application/octet-stream');
        const result = await response.json() as { message?: string };
        return result.message ?? `Exported ${fileName}.`;
    }

    /** Writes generated files; returns the message of the host. */
    async generated(files: HostGeneratedFiles): Promise<string> {
        const response = await this.post('api/generate', JSON.stringify(files), 'application/json');
        const result = await response.json() as { message?: string };
        return result.message ?? `Generated ${files.files.length} files.`;
    }

    private async post(url: string, body: string | Blob, type: string): Promise<Response> {
        const response = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': type } });
        if (!response.ok) {
            throw new Error(`${url}: ${response.status} ${await response.text()}`);
        }
        return response;
    }
}

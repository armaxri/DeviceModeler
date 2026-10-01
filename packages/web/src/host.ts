/**
 * Embedding of the web app in another application (e.g. the Eclipse plugin in `eclipse-plugin/`).
 *
 * The app is embedded when its URL has the query parameter `?host=http`: the page is then served by a
 * host that holds the edited file and offers a small HTTP API next to the page (relative URLs `api/…`):
 *
 * - `GET  api/document` → `{ fileName, text, files }`: the edited file, its text and the files it may
 *   import (relative paths → texts, e.g. the other models and headers of its folder)
 * - `POST api/changed` (text body): the text was changed (the host updates its dirty state)
 * - `POST api/save` (text body): save the text (`Ctrl+S`, *Save*)
 * - `POST api/open` (text body: path relative to the edited file): open another file (submachine state)
 * - `POST api/export?fileName=…` (binary body): store an exported diagram; answers `{ message }`
 *
 * The host tells the page about external changes of the file by calling `hsmApp.reloadFromHost()`.
 * Without the query parameter nothing of this is used and the app keeps its files in the browser.
 */

export interface HostDocument {
    fileName: string;
    text: string;
    /** Files the edited file may import: path relative to the edited file → text. */
    files?: Record<string, string>;
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

    async load(): Promise<HostDocument> {
        const response = await fetch('api/document', { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`The host did not provide the document (${response.status} ${response.statusText}).`);
        }
        return await response.json() as HostDocument;
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

    async open(fileName: string): Promise<boolean> {
        const response = await fetch('api/open', { method: 'POST', body: fileName, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
        return response.ok;
    }

    /** Stores an exported file (the host decides where); returns the message of the host. */
    async export(fileName: string, content: string | Blob): Promise<string> {
        const response = await this.post(`api/export?fileName=${encodeURIComponent(fileName)}`, content, 'application/octet-stream');
        const result = await response.json() as { message?: string };
        return result.message ?? `Exported ${fileName}.`;
    }

    private async post(url: string, body: string | Blob, type: string): Promise<Response> {
        const response = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': type } });
        if (!response.ok) {
            throw new Error(`${url}: ${response.status} ${await response.text()}`);
        }
        return response;
    }
}

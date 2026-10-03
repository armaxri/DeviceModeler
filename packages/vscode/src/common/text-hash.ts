/**
 * A hash of a text (32 bit FNV-1a of the UTF-16 code units). Workspace edits of the diagram webview are
 * computed on the texts the extension sent to it; the extension applies them only if the files still have
 * these texts (same hash).
 */
export function textHash(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

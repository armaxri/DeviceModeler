import { describe, expect, it } from 'vitest';
import { effectiveTheme, webviewHtml } from '../../src/extension/logic/webview.js';

describe('effectiveTheme', () => {
    it('follows the color theme with auto', () => {
        expect(effectiveTheme('auto', 'classic', false)).toBe('classic');
        expect(effectiveTheme('auto', 'modern', false)).toBe('modern');
        expect(effectiveTheme('auto', 'classic', true)).toBe('dark');
        expect(effectiveTheme('auto', 'bogus', false)).toBe('classic');
    });

    it('uses an explicit theme regardless of the color theme', () => {
        expect(effectiveTheme('modern', 'classic', true)).toBe('modern');
        expect(effectiveTheme('dark', 'classic', false)).toBe('dark');
    });
});

describe('webviewHtml', () => {
    it('loads only the script with the nonce', () => {
        const html = webviewHtml({ cspSource: 'vscode-resource:', nonce: 'abc', script: 'x/webview.js', style: 'x/webview.css' });
        expect(html).toContain(`script-src 'nonce-abc'`);
        expect(html).toContain('<script nonce="abc" src="x/webview.js">');
        expect(html).toContain('href="x/webview.css"');
    });
});

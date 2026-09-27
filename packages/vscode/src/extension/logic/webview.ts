import type { DiagramTheme } from '../../common/protocol.js';

/** The effective diagram theme: `auto` follows the VS Code color theme (dark and high contrast: dark). */
export function effectiveTheme(setting: string, lightTheme: string, darkColorTheme: boolean): DiagramTheme {
    const valid = (value: string): value is DiagramTheme => value === 'classic' || value === 'modern' || value === 'dark';
    if (valid(setting)) {
        return setting;
    }
    return darkColorTheme ? 'dark' : valid(lightTheme) ? lightTheme : 'classic';
}

/** The HTML of the diagram webview (the content is created by the script). */
export function webviewHtml(options: { cspSource: string, nonce: string, script: string, style: string }): string {
    const csp = [
        `default-src 'none'`,
        `img-src ${options.cspSource} data: blob:`,
        `font-src ${options.cspSource}`,
        // sprotty sets inline styles
        `style-src ${options.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${options.nonce}'`,
        // ELK runs in a worker created from a blob
        `worker-src blob:`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${options.style}">
    <title>HSM Diagram</title>
</head>
<body>
    <script nonce="${options.nonce}" src="${options.script}"></script>
</body>
</html>`;
}


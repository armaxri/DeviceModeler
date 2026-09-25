const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

/** Encodes a diagram text for the PlantUML server (deflate + PlantUML's base64 variant). */
export async function encodePlantUml(text: string): Promise<string> {
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let result = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b1 = bytes[i];
        const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        result += ALPHABET[b1 >> 2]
            + ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)]
            + ALPHABET[((b2 & 0xF) << 2) | (b3 >> 6)]
            + ALPHABET[b3 & 0x3F];
    }
    return result;
}

export async function plantUmlServerUrl(text: string, format: 'svg' | 'png' | 'uml' = 'svg'): Promise<string> {
    return `https://www.plantuml.com/plantuml/${format}/${await encodePlantUml(text)}`;
}

/**
 * A small, dependency-free XML parser which is sufficient for EMF XMI files (e.g. itemis CREATE `.sct` files).
 * It runs in Node and in the browser (no DOMParser needed).
 *
 * Supported: elements, attributes (single or double quoted), character and predefined entity references,
 * comments, CDATA sections, processing instructions and a DOCTYPE without internal subset.
 * Namespaces are not resolved: element and attribute names keep their prefix (`xmi:id`, `xsi:type`).
 */

export interface XmlElement {
    name: string;
    attributes: Record<string, string>;
    children: XmlElement[];
    /** Concatenated character data directly inside this element. */
    text: string;
}

export class XmlParseError extends Error {
    constructor(message: string, readonly offset: number) {
        super(message);
    }
}

const NAME = /[A-Za-z_:][-\w.:]*/y;
const WHITESPACE = /\s*/y;

const PREDEFINED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' };

/** Replaces character and predefined entity references. */
export function decodeXmlEntities(text: string): string {
    return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (match, entity: string) => {
        if (entity.startsWith('#x')) {
            return String.fromCodePoint(parseInt(entity.substring(2), 16));
        } else if (entity.startsWith('#')) {
            return String.fromCodePoint(parseInt(entity.substring(1), 10));
        }
        return PREDEFINED_ENTITIES[entity] ?? match;
    });
}

/** Parses the given XML document and returns its root element. */
export function parseXml(xml: string): XmlElement {
    let pos = 0;
    const stack: XmlElement[] = [];
    let root: XmlElement | undefined;

    const fail = (message: string): never => {
        const line = xml.substring(0, pos).split('\n').length;
        throw new XmlParseError(`Invalid XML (line ${line}): ${message}`, pos);
    };
    const skipUntil = (terminator: string): string => {
        const end = xml.indexOf(terminator, pos);
        if (end < 0) {
            fail(`missing '${terminator}'`);
        }
        const content = xml.substring(pos, end);
        pos = end + terminator.length;
        return content;
    };
    const readName = (): string => {
        NAME.lastIndex = pos;
        const match = NAME.exec(xml);
        if (!match) {
            fail('name expected');
        }
        pos = NAME.lastIndex;
        return match![0];
    };
    const skipWhitespace = (): void => {
        WHITESPACE.lastIndex = pos;
        WHITESPACE.exec(xml);
        pos = WHITESPACE.lastIndex;
    };
    const appendText = (text: string): void => {
        const current = stack[stack.length - 1];
        if (current) {
            current.text += text;
        } else if (text.trim()) {
            fail('text outside of the root element');
        }
    };

    while (pos < xml.length) {
        const lt = xml.indexOf('<', pos);
        if (lt < 0) {
            appendText(decodeXmlEntities(xml.substring(pos)));
            break;
        }
        if (lt > pos) {
            appendText(decodeXmlEntities(xml.substring(pos, lt)));
        }
        pos = lt;
        if (xml.startsWith('<!--', pos)) {
            pos += 4;
            skipUntil('-->');
        } else if (xml.startsWith('<![CDATA[', pos)) {
            pos += 9;
            appendText(skipUntil(']]>'));
        } else if (xml.startsWith('<?', pos)) {
            pos += 2;
            skipUntil('?>');
        } else if (xml.startsWith('<!', pos)) {
            pos += 2;
            skipUntil('>');
        } else if (xml.startsWith('</', pos)) {
            pos += 2;
            const name = readName();
            skipWhitespace();
            if (xml[pos] !== '>') {
                fail(`'>' expected after '</${name}'`);
            }
            pos++;
            const open = stack.pop();
            if (!open || open.name !== name) {
                fail(`unexpected closing tag '</${name}>'`);
            }
        } else {
            pos++;
            const element: XmlElement = { name: readName(), attributes: {}, children: [], text: '' };
            let selfClosing = false;
            for (;;) {
                skipWhitespace();
                if (xml.startsWith('/>', pos)) {
                    pos += 2;
                    selfClosing = true;
                    break;
                } else if (xml[pos] === '>') {
                    pos++;
                    break;
                } else if (pos >= xml.length) {
                    fail(`unterminated start tag '<${element.name}'`);
                }
                const attribute = readName();
                skipWhitespace();
                if (xml[pos] !== '=') {
                    fail(`'=' expected after attribute '${attribute}'`);
                }
                pos++;
                skipWhitespace();
                const quote = xml[pos];
                if (quote !== '"' && quote !== '\'') {
                    fail(`quoted value expected for attribute '${attribute}'`);
                }
                pos++;
                element.attributes[attribute] = decodeXmlEntities(skipUntil(quote));
            }
            const parent = stack[stack.length - 1];
            if (parent) {
                parent.children.push(element);
            } else if (root) {
                fail('more than one root element');
            } else {
                root = element;
            }
            if (!selfClosing) {
                stack.push(element);
            }
        }
    }
    if (stack.length > 0) {
        fail(`missing closing tag '</${stack[stack.length - 1].name}>'`);
    }
    if (!root) {
        fail('no root element');
    }
    return root!;
}

// Monarch syntax highlighting for the dmf language.
export default {
    keywords: [
        'component','interface','subsystem','behavior','delegate','provides','requires','connect','package','import','struct','system','thread','async','event','sync'
    ],
    operators: [
        '->','::','-',',',';',':','.','@'
    ],
    ignoreCase: false,
    symbols: /->|::|-|,|;|:|\.|\(|\)|\{|\}|@/,

    tokenizer: {
        initial: [
            { regex: /0[xX][0-9a-fA-F]+/, action: {"token":"HEX"} },
            { regex: /[0-9]+\.[0-9]+([eE][+-]?[0-9]+)?/, action: {"token":"REAL"} },
            { regex: /[0-9]+/, action: {"token":"number"} },
            { regex: /[_a-zA-Z][\w]*/, action: { cases: { '@keywords': {"token":"keyword"}, '@default': {"token":"ID"} }} },
            { regex: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/, action: {"token":"string"} },
            { include: '@whitespace' },
            { regex: /@symbols/, action: { cases: { '@operators': {"token":"operator"}, '@default': {"token":""} }} },
        ],
        whitespace: [
            { regex: /\s+/, action: {"token":"white"} },
            { regex: /\/\*/, action: {"token":"comment","next":"@comment"} },
            { regex: /\/\/[^\n\r]*/, action: {"token":"comment"} },
        ],
        comment: [
            { regex: /[^/\*]+/, action: {"token":"comment"} },
            { regex: /\*\//, action: {"token":"comment","next":"@pop"} },
            { regex: /[/\*]/, action: {"token":"comment"} },
        ],
    }
};

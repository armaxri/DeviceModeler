// Monarch syntax highlighting for the hsm language.
export default {
    keywords: [
        'statemachine','deephistory','interface','namespace','operation','protected','internal','junction','readonly','unsigned','default','history','oncycle','private','valueof','active','always','choice','double','import','public','region','signed','after','alias','const','entry','event','every','false','float','raise','short','state','bool','char','else','exit','long','null','sync','true','void','int','out','var','as','in'
    ],
    operators: [
        '...','<<=','>>=','--','-=','->','::','!=','*=','/=','&&','&=','%=','^=','++','+=','<<','<=','==','>=','>>','|=','||','-',',',';',':','!','?','.','@','*','/','&','#','%','^','+','<','=','>','|','~'
    ],
    ignoreCase: false,
    symbols: /\.\.\.|\[\*\]|<<=|>>=|--|-=|->|::|!=|\*=|\/=|&&|&=|%=|\^=|\+\+|\+=|<<|<=|==|>=|>>|\|=|\|\||-|,|;|:|!|\?|\.|\(|\)|\[|\]|\{|\}|@|\*|\/|&|#|%|\^|\+|<|=|>|\||~/,

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

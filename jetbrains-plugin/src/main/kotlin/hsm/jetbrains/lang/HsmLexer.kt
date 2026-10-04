package hsm.jetbrains.lang

import com.intellij.lang.Language
import com.intellij.lexer.LexerBase
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType
import com.intellij.psi.tree.TokenSet

/** The tokens of a language (`.hsm` or `.hsmtest`): the terminals of the Langium grammars. */
class HsmTokens(language: Language, keywords: Collection<String>) {
    val keywords: Set<String> = keywords.toSet()
    val lineComment = IElementType("LINE_COMMENT", language)
    val blockComment = IElementType("BLOCK_COMMENT", language)
    val string = IElementType("STRING", language)
    val number = IElementType("NUMBER", language)
    val keyword = IElementType("KEYWORD", language)
    val identifier = IElementType("IDENTIFIER", language)
    val annotation = IElementType("ANNOTATION", language)
    val lbrace = IElementType("{", language)
    val rbrace = IElementType("}", language)
    val lparen = IElementType("(", language)
    val rparen = IElementType(")", language)
    val lbracket = IElementType("[", language)
    val rbracket = IElementType("]", language)
    val operator = IElementType("OPERATOR", language)

    val comments: TokenSet = TokenSet.create(lineComment, blockComment)
    val strings: TokenSet = TokenSet.create(string)

    companion object {
        /** The keywords of hsm.langium (as in packages/language/syntaxes/hsm.tmLanguage.json). */
        val HSM = HsmTokens(HsmLanguage, listOf(
            "statemachine", "deephistory", "interface", "namespace", "operation", "internal", "junction", "readonly",
            "default", "history", "oncycle", "valueof", "active", "always", "choice", "import", "region", "after", "alias",
            "const", "entry", "event", "every", "false", "raise", "state", "else", "exit", "null", "sync", "true", "out",
            "var", "as", "in",
        ))

        /** The keywords of hsm-test.langium (packages/language/syntaxes/hsmtest.tmLanguage.json). */
        val HSM_TEST = HsmTokens(HsmTestLanguage, listOf(
            "statemachine", "operation", "testclass", "readonly", "message", "proceed", "returns", "valueof", "active",
            "assert", "called", "const", "enter", "false", "raise", "times", "while", "else", "exit", "mock", "null", "true",
            "with", "for", "var", "as", "if",
        ))
    }
}

/**
 * A lexer of the terminals of the grammars (`ID`, `INT`, `REAL`, `HEX`, `STRING`, comments, `@annotations`) for
 * the highlighting of the text editor. The parsing, validation and everything else are done by the page (and
 * the command line tool): nothing of the language is reimplemented here.
 */
class HsmLexer(private val tokens: HsmTokens) : LexerBase() {
    private var buffer: CharSequence = ""
    private var endOffset = 0
    private var start = 0
    private var end = 0
    private var type: IElementType? = null

    override fun start(buffer: CharSequence, startOffset: Int, endOffset: Int, initialState: Int) {
        this.buffer = buffer
        this.endOffset = endOffset
        this.end = startOffset
        advance()
    }

    override fun getState(): Int = 0
    override fun getTokenType(): IElementType? = type
    override fun getTokenStart(): Int = start
    override fun getTokenEnd(): Int = end
    override fun getBufferSequence(): CharSequence = buffer
    override fun getBufferEnd(): Int = endOffset

    override fun advance() {
        start = end
        if (start >= endOffset) {
            type = null
            return
        }
        val c = buffer[start]
        var i = start + 1
        type = when {
            c.isWhitespace() -> {
                while (i < endOffset && buffer[i].isWhitespace()) i++
                TokenType.WHITE_SPACE
            }
            c == '/' && i < endOffset && buffer[i] == '/' -> {
                while (i < endOffset && buffer[i] != '\n' && buffer[i] != '\r') i++
                tokens.lineComment
            }
            c == '/' && i < endOffset && buffer[i] == '*' -> {
                i++
                while (i < endOffset && !(buffer[i] == '*' && i + 1 < endOffset && buffer[i + 1] == '/')) i++
                i = minOf(endOffset, i + 2)
                tokens.blockComment
            }
            c == '"' || c == '\'' -> {
                while (i < endOffset && buffer[i] != c && buffer[i] != '\n') {
                    if (buffer[i] == '\\' && i + 1 < endOffset) i++
                    i++
                }
                if (i < endOffset && buffer[i] == c) i++
                tokens.string
            }
            c.isDigit() -> {
                if (c == '0' && i < endOffset && (buffer[i] == 'x' || buffer[i] == 'X')) {
                    i++
                    while (i < endOffset && (buffer[i].isDigit() || buffer[i].lowercaseChar() in 'a'..'f')) i++
                } else {
                    while (i < endOffset && buffer[i].isDigit()) i++
                    if (i + 1 < endOffset && buffer[i] == '.' && buffer[i + 1].isDigit()) {
                        i++
                        while (i < endOffset && buffer[i].isDigit()) i++
                    }
                    if (i < endOffset && (buffer[i] == 'e' || buffer[i] == 'E')) {
                        var j = i + 1
                        if (j < endOffset && (buffer[j] == '+' || buffer[j] == '-')) j++
                        if (j < endOffset && buffer[j].isDigit()) {
                            i = j
                            while (i < endOffset && buffer[i].isDigit()) i++
                        }
                    }
                }
                tokens.number
            }
            c == '_' || c.isLetter() -> {
                while (i < endOffset && (buffer[i] == '_' || buffer[i].isLetterOrDigit())) i++
                if (buffer.subSequence(start, i).toString() in tokens.keywords) tokens.keyword else tokens.identifier
            }
            c == '@' && i < endOffset && (buffer[i] == '_' || buffer[i].isLetter()) -> {
                while (i < endOffset && (buffer[i] == '_' || buffer[i].isLetterOrDigit())) i++
                tokens.annotation
            }
            c == '{' -> tokens.lbrace
            c == '}' -> tokens.rbrace
            c == '(' -> tokens.lparen
            c == ')' -> tokens.rparen
            c == '[' -> tokens.lbracket
            c == ']' -> tokens.rbracket
            else -> tokens.operator
        }
        end = i
    }
}

package hsm.jetbrains.lang

import com.intellij.extapi.psi.ASTWrapperPsiElement
import com.intellij.extapi.psi.PsiFileBase
import com.intellij.lang.ASTNode
import com.intellij.lang.BracePair
import com.intellij.lang.CodeDocumentationAwareCommenter
import com.intellij.lang.Language
import com.intellij.lang.ParserDefinition
import com.intellij.lang.PairedBraceMatcher
import com.intellij.lang.PsiParser
import com.intellij.lexer.Lexer
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.fileTypes.SyntaxHighlighter
import com.intellij.openapi.fileTypes.SyntaxHighlighterBase
import com.intellij.openapi.fileTypes.SyntaxHighlighterFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.FileViewProvider
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.tree.IElementType
import com.intellij.psi.tree.IFileElementType
import com.intellij.psi.tree.TokenSet

// The text editor support of .hsm / .hsmtest: highlighting, comments, braces and a flat PSI (one element per
// file, needed by the platform for annotators and the structure view). Validation, completion etc. come from
// the page (diagram editor) and the command line tool – a language server (LSP4IJ or the platform's LSP API with
// the server of packages/vscode) would be the next step for the text editor.

private val KEYWORD = TextAttributesKey.createTextAttributesKey("HSM_KEYWORD", DefaultLanguageHighlighterColors.KEYWORD)
private val STRING = TextAttributesKey.createTextAttributesKey("HSM_STRING", DefaultLanguageHighlighterColors.STRING)
private val NUMBER = TextAttributesKey.createTextAttributesKey("HSM_NUMBER", DefaultLanguageHighlighterColors.NUMBER)
private val LINE_COMMENT = TextAttributesKey.createTextAttributesKey("HSM_LINE_COMMENT", DefaultLanguageHighlighterColors.LINE_COMMENT)
private val BLOCK_COMMENT = TextAttributesKey.createTextAttributesKey("HSM_BLOCK_COMMENT", DefaultLanguageHighlighterColors.BLOCK_COMMENT)
private val ANNOTATION = TextAttributesKey.createTextAttributesKey("HSM_ANNOTATION", DefaultLanguageHighlighterColors.METADATA)
private val BRACES = TextAttributesKey.createTextAttributesKey("HSM_BRACES", DefaultLanguageHighlighterColors.BRACES)
private val PARENTHESES = TextAttributesKey.createTextAttributesKey("HSM_PARENTHESES", DefaultLanguageHighlighterColors.PARENTHESES)
private val BRACKETS = TextAttributesKey.createTextAttributesKey("HSM_BRACKETS", DefaultLanguageHighlighterColors.BRACKETS)
private val OPERATOR = TextAttributesKey.createTextAttributesKey("HSM_OPERATOR", DefaultLanguageHighlighterColors.OPERATION_SIGN)

class HsmSyntaxHighlighter(private val tokens: HsmTokens) : SyntaxHighlighterBase() {
    override fun getHighlightingLexer(): Lexer = HsmLexer(tokens)

    override fun getTokenHighlights(type: IElementType?): Array<TextAttributesKey> = pack(
        when (type) {
            tokens.keyword -> KEYWORD
            tokens.string -> STRING
            tokens.number -> NUMBER
            tokens.lineComment -> LINE_COMMENT
            tokens.blockComment -> BLOCK_COMMENT
            tokens.annotation -> ANNOTATION
            tokens.lbrace, tokens.rbrace -> BRACES
            tokens.lparen, tokens.rparen -> PARENTHESES
            tokens.lbracket, tokens.rbracket -> BRACKETS
            tokens.operator -> OPERATOR
            else -> null
        }
    )
}

class HsmSyntaxHighlighterFactory : SyntaxHighlighterFactory() {
    override fun getSyntaxHighlighter(project: Project?, virtualFile: VirtualFile?): SyntaxHighlighter = HsmSyntaxHighlighter(HsmTokens.HSM)
}

class HsmTestSyntaxHighlighterFactory : SyntaxHighlighterFactory() {
    override fun getSyntaxHighlighter(project: Project?, virtualFile: VirtualFile?): SyntaxHighlighter = HsmSyntaxHighlighter(HsmTokens.HSM_TEST)
}

/** A file of the flat PSI. */
class HsmPsiFile(viewProvider: FileViewProvider, language: Language, private val fileType: FileType) : PsiFileBase(viewProvider, language) {
    override fun getFileType(): FileType = fileType
    override fun toString(): String = "${fileType.name} file"
}

/** A flat PSI: the file is one element with the tokens as leaves. */
abstract class FlatParserDefinition(
    private val tokens: HsmTokens,
    private val language: Language,
    private val fileType: FileType,
) : ParserDefinition {
    private val fileElementType = IFileElementType(language)

    override fun createLexer(project: Project?): Lexer = HsmLexer(tokens)
    override fun createParser(project: Project?): PsiParser = PsiParser { root, builder ->
        val marker = builder.mark()
        while (!builder.eof()) {
            builder.advanceLexer()
        }
        marker.done(root)
        builder.treeBuilt
    }
    override fun getFileNodeType(): IFileElementType = fileElementType
    override fun getCommentTokens(): TokenSet = tokens.comments
    override fun getStringLiteralElements(): TokenSet = tokens.strings
    override fun createElement(node: ASTNode): PsiElement = ASTWrapperPsiElement(node)
    override fun createFile(viewProvider: FileViewProvider): PsiFile = HsmPsiFile(viewProvider, language, fileType)
}

class HsmParserDefinition : FlatParserDefinition(HsmTokens.HSM, HsmLanguage, HsmFileType)

class HsmTestParserDefinition : FlatParserDefinition(HsmTokens.HSM_TEST, HsmTestLanguage, HsmTestFileType)

abstract class BaseCommenter(private val tokens: HsmTokens) : CodeDocumentationAwareCommenter {
    override fun getLineCommentPrefix(): String = "//"
    override fun getBlockCommentPrefix(): String = "/*"
    override fun getBlockCommentSuffix(): String = "*/"
    override fun getCommentedBlockCommentPrefix(): String? = null
    override fun getCommentedBlockCommentSuffix(): String? = null
    override fun getLineCommentTokenType(): IElementType = tokens.lineComment
    override fun getBlockCommentTokenType(): IElementType = tokens.blockComment
    override fun getDocumentationCommentTokenType(): IElementType? = null
    override fun getDocumentationCommentPrefix(): String = "/**"
    override fun getDocumentationCommentLinePrefix(): String = "*"
    override fun getDocumentationCommentSuffix(): String = "*/"
    override fun isDocumentationComment(element: com.intellij.psi.PsiComment?): Boolean = element?.text?.startsWith("/**") == true
}

class HsmCommenter : BaseCommenter(HsmTokens.HSM)

class HsmTestCommenter : BaseCommenter(HsmTokens.HSM_TEST)

abstract class BaseBraceMatcher(tokens: HsmTokens) : PairedBraceMatcher {
    private val pairs = arrayOf(
        BracePair(tokens.lbrace, tokens.rbrace, true),
        BracePair(tokens.lparen, tokens.rparen, false),
        BracePair(tokens.lbracket, tokens.rbracket, false),
    )

    override fun getPairs(): Array<BracePair> = pairs
    override fun isPairedBracesAllowedBeforeType(lbraceType: IElementType, contextType: IElementType?): Boolean = true
    override fun getCodeConstructStart(file: PsiFile?, openingBraceOffset: Int): Int = openingBraceOffset
}

class HsmBraceMatcher : BaseBraceMatcher(HsmTokens.HSM)

class HsmTestBraceMatcher : BaseBraceMatcher(HsmTokens.HSM_TEST)

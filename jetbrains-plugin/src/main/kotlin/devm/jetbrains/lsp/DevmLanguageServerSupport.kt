package devm.jetbrains.lsp

import com.intellij.openapi.components.serviceOrNull
import devm.jetbrains.cli.DevmExecutable

/**
 * Whether the language server runs for the text editor: LSP4IJ is installed and enabled (it loads
 * `devm-lsp4ij.xml`) and there is an devm executable. Then the server reports the problems of the text and the
 * plugin's own annotator ([devm.jetbrains.problems.DevmExternalAnnotator]) stays silent. Refers to no LSP4IJ class.
 */
object DevmLanguageServerSupport {

    /** LSP4IJ is enabled: the platform loaded `devm-lsp4ij.xml`, which registers [Lsp4ijLoaded]. */
    fun lsp4ijEnabled(): Boolean = serviceOrNull<Lsp4ijLoaded>() != null

    fun active(): Boolean = lsp4ijEnabled() && DevmExecutable.locate() != null
}

/** An application service registered only by `devm-lsp4ij.xml` (that is, if LSP4IJ is enabled). */
class Lsp4ijLoaded

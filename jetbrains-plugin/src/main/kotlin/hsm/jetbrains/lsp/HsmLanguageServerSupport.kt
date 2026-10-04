package hsm.jetbrains.lsp

import com.intellij.openapi.components.serviceOrNull
import hsm.jetbrains.cli.HsmExecutable

/**
 * Whether the language server runs for the text editor: LSP4IJ is installed and enabled (it loads
 * `hsm-lsp4ij.xml`) and there is an hsm executable. Then the server reports the problems of the text and the
 * plugin's own annotator ([hsm.jetbrains.problems.HsmExternalAnnotator]) stays silent. Refers to no LSP4IJ class.
 */
object HsmLanguageServerSupport {

    /** LSP4IJ is enabled: the platform loaded `hsm-lsp4ij.xml`, which registers [Lsp4ijLoaded]. */
    fun lsp4ijEnabled(): Boolean = serviceOrNull<Lsp4ijLoaded>() != null

    fun active(): Boolean = lsp4ijEnabled() && HsmExecutable.locate() != null
}

/** An application service registered only by `hsm-lsp4ij.xml` (that is, if LSP4IJ is enabled). */
class Lsp4ijLoaded

package devm.jetbrains.lsp

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.LanguageServerEnablementSupport
import com.redhat.devtools.lsp4ij.LanguageServerFactory
import com.redhat.devtools.lsp4ij.server.CannotStartProcessException
import com.redhat.devtools.lsp4ij.server.OSProcessStreamConnectionProvider
import com.redhat.devtools.lsp4ij.server.StreamConnectionProvider
import devm.jetbrains.cli.DevmExecutable

// Only loaded with LSP4IJ installed (devm-lsp4ij.xml): the plugin's other classes do not refer to LSP4IJ.

/**
 * The Device Modeler language server for LSP4IJ (`devm-lsp4ij.xml`): `devm lsp --stdio` of the devm executable.
 *
 * The server is only enabled while there is an devm executable (like [DevmLanguageServerSupport.active]): without
 * one, LSP4IJ does not try to start it (which would fail with an error logged for every opened model) and the
 * plugin's own validation reports the problems instead.
 */
class DevmLanguageServerFactory : LanguageServerFactory, LanguageServerEnablementSupport {
    override fun createConnectionProvider(project: Project): StreamConnectionProvider = DevmConnectionProvider(project)

    /** Disabled by the user in the LSP4IJ settings (Languages & Frameworks > Language Servers). */
    @Volatile
    private var disabled = false

    override fun isEnabled(project: Project): Boolean = !disabled && DevmExecutable.locate() != null

    override fun setEnabled(enabled: Boolean, project: Project) {
        disabled = !enabled
    }
}

/**
 * Starts `devm lsp --stdio` of the executable found by [DevmExecutable] (setting, bundled, `PATH`) in the project
 * directory. LSP4IJ sends the project as workspace folder; headers are found through the include paths of
 * `devm.gen.json`. The executable is located on every start, so a changed setting applies after a restart of
 * the server (LSP Consoles tool window).
 */
class DevmConnectionProvider(private val project: Project) : OSProcessStreamConnectionProvider() {

    override fun start() {
        val executable = DevmExecutable.locate()
            ?: throw CannotStartProcessException("${DevmExecutable.missingReason()} Set it in Settings > Tools > Device Modeler.")
        // the project directory (if it exists; the server finds devm.gen.json from the models' directories anyway)
        val directory = project.basePath?.takeIf { java.io.File(it).isDirectory } ?: System.getProperty("user.home")
        commandLine = commandLine(executable.path.toString(), directory)
        super.start()
    }

    companion object {
        /** The command line of the server. */
        fun commandLine(executable: String, workingDirectory: String?): GeneralCommandLine =
            GeneralCommandLine(executable, "lsp", "--stdio")
                .withWorkDirectory(workingDirectory)
                .withCharset(Charsets.UTF_8)
                .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
    }
}

package hsm.jetbrains.lsp

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.LanguageServerFactory
import com.redhat.devtools.lsp4ij.server.CannotStartProcessException
import com.redhat.devtools.lsp4ij.server.OSProcessStreamConnectionProvider
import com.redhat.devtools.lsp4ij.server.StreamConnectionProvider
import hsm.jetbrains.cli.HsmExecutable

// Only loaded with LSP4IJ installed (hsm-lsp4ij.xml): the plugin's other classes do not refer to LSP4IJ.

/** The HSM language server for LSP4IJ (`hsm-lsp4ij.xml`): `hsm lsp --stdio` of the hsm executable. */
class HsmLanguageServerFactory : LanguageServerFactory {
    override fun createConnectionProvider(project: Project): StreamConnectionProvider = HsmConnectionProvider(project)
}

/**
 * Starts `hsm lsp --stdio` of the executable found by [HsmExecutable] (setting, bundled, `PATH`) in the project
 * directory. LSP4IJ sends the project as workspace folder; headers are found through the include paths of
 * `hsm.gen.json`. The executable is located on every start, so a changed setting applies after a restart of
 * the server (LSP Consoles tool window).
 */
class HsmConnectionProvider(private val project: Project) : OSProcessStreamConnectionProvider() {

    override fun start() {
        val executable = HsmExecutable.locate()
            ?: throw CannotStartProcessException("${HsmExecutable.missingReason()} Set it in Settings > Tools > HSM Modeler.")
        // the project directory (if it exists; the server finds hsm.gen.json from the models' directories anyway)
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

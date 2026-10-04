package hsm.eclipse.lsp;

import java.io.IOException;
import java.util.List;
import java.util.Optional;

import org.eclipse.lsp4e.server.ProcessStreamConnectionProvider;

import hsm.eclipse.tools.HsmExecutable;

/**
 * The HSM language server for LSP4E: {@code hsm lsp --stdio} of the self-contained {@code hsm} executable
 * (located by {@link HsmExecutable}: the preference of <i>Preferences > HSM Modeler</i>, the executable of the
 * platform fragment or {@code hsm} in the {@code PATH}). LSP4E starts it for documents of the content types
 * {@code hsm.eclipse.hsm} and {@code hsm.eclipse.hsmtest} in text editors (Generic Editor) and sends the project
 * as workspace folder; headers are found through the include paths of {@code hsm.gen.json}.
 */
public class HsmLanguageServer extends ProcessStreamConnectionProvider {

    /** The command line of the server for an executable. */
    public static List<String> command(String executable) {
        return List.of(executable, "lsp", "--stdio");
    }

    @Override
    public void start() throws IOException {
        // located on every start: a changed preference applies when the server is restarted
        Optional<HsmExecutable.Located> executable = HsmExecutable.locate();
        if (executable.isEmpty()) {
            throw new IOException("No hsm executable for the HSM language server: set it in Preferences > HSM Modeler "
                    + "or put hsm in the PATH (docs/installation.md)");
        }
        setCommands(command(executable.get().path().toString()));
        setWorkingDirectory(System.getProperty("user.home"));
        super.start();
    }

    @Override
    public String toString() {
        return "HSM Language Server: " + super.toString();
    }
}

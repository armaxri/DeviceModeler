package devm.eclipse.lsp;

import java.io.IOException;
import java.util.List;
import java.util.Optional;

import org.eclipse.lsp4e.server.ProcessStreamConnectionProvider;

import devm.eclipse.tools.DevmExecutable;

/**
 * The Device Modeler language server for LSP4E: {@code devm lsp --stdio} of the self-contained {@code devm} executable
 * (located by {@link DevmExecutable}: the preference of <i>Preferences > Device Modeler</i>, the executable of the
 * platform fragment or {@code devm} in the {@code PATH}). LSP4E starts it for documents of the content types
 * {@code devm.eclipse.devm} and {@code devm.eclipse.devmtest} in text editors (Generic Editor) and sends the project
 * as workspace folder; headers are found through the include paths of {@code devm.gen.json}.
 */
public class DevmLanguageServer extends ProcessStreamConnectionProvider {

    /** The command line of the server for an executable. */
    public static List<String> command(String executable) {
        return List.of(executable, "lsp", "--stdio");
    }

    @Override
    public void start() throws IOException {
        // located on every start: a changed preference applies when the server is restarted
        Optional<DevmExecutable.Located> executable = DevmExecutable.locate();
        if (executable.isEmpty()) {
            throw new IOException("No devm executable for the Device Modeler language server: set it in Preferences > Device Modeler "
                    + "or put devm in the PATH (docs/installation.md)");
        }
        setCommands(command(executable.get().path().toString()));
        setWorkingDirectory(System.getProperty("user.home"));
        super.start();
    }

    @Override
    public String toString() {
        return "Device Modeler Language Server: " + super.toString();
    }
}

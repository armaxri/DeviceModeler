package hsm.eclipse;

import java.io.IOException;
import java.util.Map;

/**
 * The host side of one embedded web app page (one opened editor): the HTTP API of {@link WebServer} calls these
 * methods (on the threads of the server, not on the UI thread). The protocol is described in
 * {@code packages/web/src/host.ts}.
 */
public interface HostSession {

    /** File name of the edited file (shown in the page, base of the import paths). */
    String fileName();

    /** The text of the edited file. */
    String text() throws IOException;

    /** Files the edited file may import: path relative to the edited file → text. */
    Map<String, String> importableFiles() throws IOException;

    /** The text was changed in the page. */
    void changed(String text);

    /** The page asks to save the text. */
    void save(String text) throws IOException;

    /** The page asks to open another file (path relative to the edited file); false if it does not exist. */
    boolean open(String path);

    /** Stores an exported diagram; returns a message for the user. */
    String export(String fileName, byte[] content) throws IOException;
}

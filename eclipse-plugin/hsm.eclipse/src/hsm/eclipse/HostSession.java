package hsm.eclipse;

import java.io.IOException;
import java.util.Map;

/**
 * The host side of one embedded web app page (one opened editor): the HTTP API of {@link WebServer} calls these
 * methods (on the threads of the server, not on the UI thread). The protocol is described in
 * {@code packages/web/src/host.ts}; paths are relative to the root of the session (the Eclipse project), with
 * {@code /} separators.
 */
public interface HostSession {

    /** The document: {@code fileName}, {@code path}, {@code text}, {@code files}, {@code configs}, … (see host.ts). */
    Map<String, Object> document() throws IOException;

    /** The text of another file below the root, {@code null} if it does not exist (or is outside of the root). */
    String file(String path) throws IOException;

    /** The text was changed in the page. */
    void changed(String text);

    /** The page asks to save the text. */
    void save(String text) throws IOException;

    /** Problems and outline of the model ({@code HostModelReport} of host.ts, parsed JSON). */
    void model(Map<String, Object> report);

    /** The page settings (JSON) to store. */
    void settings(String json);

    /** The page asks to open another file; false if it does not exist. */
    boolean open(String path);

    /** Stores an exported diagram; returns a message for the user. */
    String export(String fileName, byte[] content) throws IOException;

    /** Writes generated files ({@code HostGeneratedFiles} of host.ts, parsed JSON); returns a message for the user. */
    String generated(Map<String, Object> files) throws IOException;
}

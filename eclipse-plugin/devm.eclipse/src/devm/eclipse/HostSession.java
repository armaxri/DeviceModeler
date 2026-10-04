package devm.eclipse;

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

    /**
     * A position in a file of {@code api/open}: 1-based lines and columns (UTF-16 code units, as in Monaco); the
     * end is the end of the range to select (the start if the page sent no range).
     */
    record Position(int line, int column, int endLine, int endColumn) {

        /** The position of the query parameters {@code line}, {@code column}, {@code endLine}, {@code endColumn}; null without a line. */
        public static Position of(java.util.function.Function<String, String> parameters) {
            int line = number(parameters.apply("line"));
            if (line < 1) {
                return null;
            }
            int column = Math.max(1, number(parameters.apply("column")));
            int endLine = number(parameters.apply("endLine"));
            int endColumn = number(parameters.apply("endColumn"));
            return endLine >= line && endColumn >= 1 ? new Position(line, column, endLine, endColumn) : new Position(line, column, line, column);
        }

        private static int number(String value) {
            try {
                return value == null ? -1 : Integer.parseInt(value.trim());
            } catch (NumberFormatException e) {
                return -1;
            }
        }
    }

    /**
     * The page asks to open another file below the root (a model, or a C/C++ header of a go to definition) in the
     * editor for its type, at a position if one is given ({@code null}: none); false if it does not exist.
     */
    default boolean open(String path, Position position) {
        return open(path, position, null);
    }

    /**
     * {@link #open(String, Position)} for a navigation of the diagram: {@code location} (JSON, {@code DiagramLocation}
     * of the page's structure-diagram.ts, null: none) is the structure or component to show in the page of the opened
     * file, the element to select and the breadcrumb context; it is passed on to that page.
     */
    boolean open(String path, Position position, String location);

    /** Stores an exported diagram; returns a message for the user. */
    String export(String fileName, byte[] content) throws IOException;

    /** Writes generated files ({@code HostGeneratedFiles} of host.ts, parsed JSON); returns a message for the user. */
    String generated(Map<String, Object> files) throws IOException;
}

package devm.eclipse.tools;

import java.util.Map;

import org.eclipse.core.resources.IMarker;

import devm.eclipse.Json;

/**
 * A problem of a model (error, warning or info) as shown in the Problems view.
 *
 * @param severity {@link IMarker#SEVERITY_ERROR}, {@link IMarker#SEVERITY_WARNING} or {@link IMarker#SEVERITY_INFO}
 * @param message  the message
 * @param line     1-based line of the start (0: unknown)
 * @param column   1-based column of the start (0: unknown)
 * @param offset   character offset of the start in the text (-1: unknown, e.g. a validator that only reports lines)
 * @param end      character offset of the end (-1: unknown)
 */
public record ModelProblem(int severity, String message, int line, int column, int offset, int end) {

    /** A problem reported by the page ({@code HostProblem} of packages/web/src/host.ts). */
    public static ModelProblem fromJson(Object json) {
        Map<String, Object> map = Json.object(json);
        int severity = switch (Json.string(map.get("severity"), "error")) {
            case "warning" -> IMarker.SEVERITY_WARNING;
            case "info" -> IMarker.SEVERITY_INFO;
            default -> IMarker.SEVERITY_ERROR;
        };
        return new ModelProblem(severity, Json.string(map.get("message"), ""), Json.integer(map.get("line"), 0),
                Json.integer(map.get("column"), 0), Json.integer(map.get("offset"), -1), Json.integer(map.get("end"), -1));
    }

    /**
     * A problem of a line of the command line tool ({@code <file>:<line>:<column>: error: <message>}, the output of
     * {@code devm validate}); {@code null} if the line has another format. Prepared for a validator using the
     * bundled executable.
     */
    public static ModelProblem fromCliLine(String text) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^.*?:(\\d+):(\\d+): (error|warning|info): (.*)$").matcher(text);
        if (!m.matches()) {
            return null;
        }
        int severity = switch (m.group(3)) {
            case "warning" -> IMarker.SEVERITY_WARNING;
            case "info" -> IMarker.SEVERITY_INFO;
            default -> IMarker.SEVERITY_ERROR;
        };
        return new ModelProblem(severity, m.group(4), Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), -1, -1);
    }
}

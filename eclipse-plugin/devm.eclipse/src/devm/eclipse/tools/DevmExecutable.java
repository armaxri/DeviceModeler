package devm.eclipse.tools;

import java.io.File;
import java.io.IOException;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

import org.eclipse.core.runtime.FileLocator;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.Status;

import devm.eclipse.Activator;
import devm.eclipse.Preferences;

/**
 * The self-contained command line executable {@code devm} (packages/cli, a Node.js single executable application),
 * used for the tools that run without the page (validation of closed files, see {@link CliValidator}). It is
 * searched in this order:
 * <ol>
 * <li>the preference {@value Preferences#DEVM_EXECUTABLE} (<i>Preferences > Device Modeler</i>), if set;</li>
 * <li>the executable of the platform fragment {@code devm.eclipse.cli.<os>.<arch>} ({@code bin/devm}, installed
 * with the feature for the platform of Eclipse);</li>
 * <li>{@code devm} in the {@code PATH} (and, for Eclipse started from the macOS Finder with a short {@code PATH},
 * in {@code /opt/homebrew/bin}, {@code /usr/local/bin} and {@code ~/.local/bin}).</li>
 * </ol>
 */
public final class DevmExecutable {

    /** Where the executable was found. */
    public enum Source {
        PREFERENCE, BUNDLED, PATH
    }

    /** A located executable. */
    public record Located(Path path, Source source) {
    }

    private static volatile String lastProblem;

    private DevmExecutable() {
    }

    /** The executable, or empty if none was found (the reason is logged once). */
    public static Optional<Located> locate() {
        String configured = Activator.getDefault() != null ? Preferences.store().getString(Preferences.DEVM_EXECUTABLE).trim() : "";
        if (!configured.isEmpty()) {
            Path path = Path.of(configured);
            if (Files.isRegularFile(path) && makeExecutable(path)) {
                return Optional.of(new Located(path, Source.PREFERENCE));
            }
            logOnce("The devm executable of the preferences does not exist or is not executable: " + configured);
            return Optional.empty();
        }
        Optional<Path> bundled = bundled();
        if (bundled.isPresent()) {
            return Optional.of(new Located(bundled.get(), Source.BUNDLED));
        }
        Optional<Path> onPath = onPath(System.getenv("PATH"), isWindows(), System.getProperty("user.home"));
        if (onPath.isPresent()) {
            return Optional.of(new Located(onPath.get(), Source.PATH));
        }
        logOnce("No devm executable: neither a platform fragment devm.eclipse.cli.* nor devm in the PATH "
                + "(set it in Preferences > Device Modeler); closed files are not validated");
        return Optional.empty();
    }

    /** A short description for messages, e.g. {@code /usr/local/bin/devm (PATH)}. */
    public static String describe(Located located) {
        return located.path() + " (" + located.source().name().toLowerCase(Locale.ROOT) + ")";
    }

    /** File name of the executable on this platform. */
    public static String fileName() {
        return isWindows() ? "devm.exe" : "devm";
    }

    /** The executable of the platform fragment ({@code bin/devm} of a fragment of this bundle). */
    static Optional<Path> bundled() {
        Activator activator = Activator.getDefault();
        if (activator == null) {
            return Optional.empty();
        }
        URL entry = FileLocator.find(activator.getBundle(), new org.eclipse.core.runtime.Path("bin/" + fileName()), null);
        if (entry == null) {
            return Optional.empty();
        }
        try {
            // the fragment is installed as a directory (Eclipse-BundleShape: dir); otherwise it is extracted
            URL file = FileLocator.toFileURL(entry);
            Path path;
            try {
                path = Path.of(file.toURI());
            } catch (URISyntaxException | IllegalArgumentException e) {
                // toFileURL does not encode spaces
                path = Path.of(file.getPath());
            }
            return Files.isRegularFile(path) && makeExecutable(path) ? Optional.of(path) : Optional.empty();
        } catch (IOException e) {
            logOnce("The bundled devm executable could not be extracted: " + e.getMessage());
            return Optional.empty();
        }
    }

    /** {@code devm} in the directories of a {@code PATH} (plus the usual install locations on macOS / Linux). */
    static Optional<Path> onPath(String pathVariable, boolean windows, String home) {
        List<String> directories = new ArrayList<>();
        if (pathVariable != null) {
            directories.addAll(List.of(pathVariable.split(File.pathSeparator)));
        }
        if (!windows) {
            directories.addAll(List.of("/opt/homebrew/bin", "/usr/local/bin"));
            if (home != null) {
                directories.add(home + "/.local/bin");
            }
        }
        String name = windows ? "devm.exe" : "devm";
        for (String directory : directories) {
            if (directory.isBlank()) {
                continue;
            }
            Path candidate = Path.of(directory.trim().replace("\"", ""), name);
            if (Files.isRegularFile(candidate) && Files.isExecutable(candidate)) {
                return Optional.of(candidate);
            }
        }
        return Optional.empty();
    }

    /** p2 does not always keep the executable bit of files in bundles: set it if possible. */
    private static boolean makeExecutable(Path path) {
        return Files.isExecutable(path) || path.toFile().setExecutable(true) || isWindows();
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).startsWith("windows");
    }

    private static void logOnce(String message) {
        if (!message.equals(lastProblem)) {
            lastProblem = message;
            Activator activator = Activator.getDefault();
            if (activator != null) {
                activator.getLog().log(new Status(IStatus.WARNING, Activator.PLUGIN_ID, message));
            }
        }
    }
}

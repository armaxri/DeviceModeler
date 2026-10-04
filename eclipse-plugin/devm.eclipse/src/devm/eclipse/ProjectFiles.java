package devm.eclipse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;

import org.eclipse.core.resources.IContainer;
import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IFolder;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IPath;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.Path;

/**
 * The files of a project as the embedded web app sees them: paths relative to the project with {@code /}
 * separators. The project is the boundary: the page can import, read and write only files of the project of
 * the edited model ({@code import "../motor.devm"} works within the project).
 */
public final class ProjectFiles {

    /** Files a model may import or reference: other models (state machines and structure files) and C/C++ headers. */
    public static final Pattern IMPORTABLE = Pattern.compile(".*\\.(devm|h|hh|hpp|hxx|h\\+\\+|inl)", Pattern.CASE_INSENSITIVE);
    /** Generator configurations ({@code devm generate}). */
    public static final Pattern GENERATOR_CONFIG = Pattern.compile("devm\\.gen\\.json|.+\\.devm\\.gen\\.json");

    /** A state machine file: {@code statemachine} after leading comments and white space (isStructureText of packages/language). */
    private static final Pattern STATE_MACHINE_START = Pattern.compile("^\uFEFF?(?:\\s+|//[^\\n]*|/\\*[\\s\\S]*?\\*/)*statemachine(?!\\w)");

    private static final int MAX_FILES = 500;
    private static final long MAX_FILE_SIZE = 2_000_000;
    private static final long MAX_TOTAL_SIZE = 30_000_000;

    private ProjectFiles() {
    }

    /** The path of a resource relative to its project ({@code models/gate.devm}). */
    public static String path(IResource resource) {
        return resource.getProjectRelativePath().toString();
    }

    /** The file of a path relative to the project; {@code null} if the path leaves the project. */
    public static IFile resolve(IProject project, String path) {
        IPath relative = new Path(path.replace('\\', '/')).makeRelative();
        for (String segment : relative.segments()) {
            if (segment.equals("..")) {
                return null;
            }
        }
        return relative.isEmpty() ? null : project.getFile(relative);
    }

    /** The importable files of the project (without {@code exclude}), by path. */
    public static Map<String, String> importableFiles(IProject project, IFile exclude) throws CoreException, IOException {
        Map<String, String> files = new TreeMap<>();
        long[] total = { 0 };
        collect(project, exclude, files, total);
        return files;
    }

    private static void collect(IContainer container, IFile exclude, Map<String, String> files, long[] total) throws CoreException, IOException {
        IResource[] members = container.members();
        Arrays.sort(members, Comparator.comparing(IResource::getName));
        for (IResource member : members) {
            if (files.size() >= MAX_FILES || total[0] > MAX_TOTAL_SIZE) {
                return;
            }
            if (member instanceof IFile file) {
                if (!file.equals(exclude) && IMPORTABLE.matcher(file.getName()).matches() && file.isAccessible()) {
                    long size = file.getLocation() != null ? file.getLocation().toFile().length() : 0;
                    if (size <= MAX_FILE_SIZE) {
                        files.put(path(file), read(file));
                        total[0] += size;
                    }
                }
            } else if (member instanceof IFolder folder && folder.isAccessible() && !folder.isDerived() && !folder.isTeamPrivateMember()
                    && !folder.getName().startsWith(".") && !folder.getName().equals("node_modules")) {
                collect(folder, exclude, files, total);
            }
        }
    }

    /** The generator configurations from the folder of the model up to the project, nearest first: {@code path}, {@code text}. */
    public static List<Map<String, Object>> generatorConfigs(IFile model) throws CoreException, IOException {
        List<Map<String, Object>> configs = new ArrayList<>();
        for (IContainer container = model.getParent(); container != null && container.getType() != IResource.ROOT; container = container.getParent()) {
            IResource[] members = container.members();
            Arrays.sort(members, Comparator.comparing(IResource::getName));
            for (IResource member : members) {
                if (member instanceof IFile file && GENERATOR_CONFIG.matcher(file.getName()).matches()) {
                    Map<String, Object> config = new LinkedHashMap<>();
                    config.put("path", path(file));
                    config.put("text", read(file));
                    configs.add(config);
                }
            }
            if (container instanceof IProject) {
                break;
            }
        }
        return configs;
    }

    /**
     * Whether the text of a {@code .devm} file is a structure file (components, subsystems, systems, …) and not a
     * state machine: state machines and structure files share the extension, a state machine starts with
     * {@code statemachine}.
     */
    public static boolean isStructureText(String text) {
        return !STATE_MACHINE_START.matcher(text).find();
    }

    /** Whether a {@code .devm} file of the workspace is a structure file ({@link #isStructureText}); false if it cannot be read. */
    public static boolean isStructureFile(IFile file) {
        try {
            return isStructureText(read(file));
        } catch (CoreException | IOException e) {
            return false;
        }
    }

    public static String read(IFile file) throws CoreException, IOException {
        try (InputStream in = file.getContents(true)) {
            return new String(in.readAllBytes(), file.getCharset());
        }
    }

    /** Writes a file; creates it and its folders if necessary. Returns false if the content was the same. */
    public static boolean write(IFile file, byte[] content, IProgressMonitor monitor) throws CoreException, IOException {
        if (file.exists()) {
            try (InputStream in = file.getContents(true)) {
                if (Arrays.equals(in.readAllBytes(), content)) {
                    return false;
                }
            }
            file.setContents(new ByteArrayInputStream(content), IResource.KEEP_HISTORY | IResource.FORCE, monitor);
        } else {
            createFolders(file.getParent(), monitor);
            file.create(new ByteArrayInputStream(content), IResource.FORCE, monitor);
        }
        return true;
    }

    private static void createFolders(IContainer container, IProgressMonitor monitor) throws CoreException {
        if (container instanceof IFolder folder && !folder.exists()) {
            createFolders(folder.getParent(), monitor);
            folder.create(IResource.FORCE, true, monitor);
        }
    }
}

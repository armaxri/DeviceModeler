package hsm.eclipse;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IMarker;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.resources.WorkspaceJob;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.Status;

import hsm.eclipse.tools.ModelProblem;

/**
 * Problem markers of models ({@value #TYPE}: a problem marker and text marker, shown in the Problems view and
 * in the Project Explorer). The editor reports the problems of the page after every validation, the builder those
 * of a {@link hsm.eclipse.tools.ModelValidator}. Markers are written in a workspace job (latest report wins) and
 * only if they changed. They stay when the editor is closed (like the result of a build) and are not persisted
 * across restarts.
 */
public final class ProblemMarkers {

    public static final String TYPE = Activator.PLUGIN_ID + ".problem";

    private static final Map<IFile, List<ModelProblem>> PENDING = new ConcurrentHashMap<>();
    private static final Map<IFile, List<ModelProblem>> CURRENT = new ConcurrentHashMap<>();

    private ProblemMarkers() {
    }

    /** Replaces the markers of the file (asynchronously). */
    public static void update(IFile file, List<ModelProblem> problems) {
        if (problems.equals(CURRENT.get(file)) && !PENDING.containsKey(file)) {
            return;
        }
        if (PENDING.put(file, List.copyOf(problems)) != null) {
            // a job is scheduled: it writes the latest problems
            return;
        }
        WorkspaceJob job = new WorkspaceJob("HSM problems of " + file.getName()) {
            @Override
            public IStatus runInWorkspace(IProgressMonitor monitor) throws CoreException {
                List<ModelProblem> latest = PENDING.remove(file);
                if (latest != null && file.exists()) {
                    write(file, latest);
                }
                return Status.OK_STATUS;
            }
        };
        job.setSystem(true);
        job.setRule(ResourcesPlugin.getWorkspace().getRuleFactory().markerRule(file));
        job.schedule();
    }

    /** Writes the markers now (the caller holds the marker rule, e.g. a builder). */
    public static void write(IFile file, List<ModelProblem> problems) throws CoreException {
        file.deleteMarkers(TYPE, false, IResource.DEPTH_ZERO);
        for (ModelProblem problem : problems) {
            IMarker marker = file.createMarker(TYPE);
            marker.setAttribute(IMarker.SEVERITY, problem.severity());
            marker.setAttribute(IMarker.MESSAGE, problem.message());
            if (problem.line() > 0) {
                marker.setAttribute(IMarker.LINE_NUMBER, problem.line());
                marker.setAttribute(IMarker.LOCATION, "line " + problem.line());
            }
            if (problem.offset() >= 0) {
                marker.setAttribute(IMarker.CHAR_START, problem.offset());
                marker.setAttribute(IMarker.CHAR_END, Math.max(problem.end(), problem.offset()));
            }
        }
        CURRENT.put(file, List.copyOf(problems));
    }

    /** Forgets the state of a file (e.g. after a move). */
    public static void forget(IFile file) {
        CURRENT.remove(file);
    }
}

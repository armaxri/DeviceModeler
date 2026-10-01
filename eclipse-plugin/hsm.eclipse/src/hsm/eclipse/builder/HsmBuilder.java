package hsm.eclipse.builder;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.IResourceDelta;
import org.eclipse.core.resources.IncrementalProjectBuilder;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.SubMonitor;

import hsm.eclipse.Activator;
import hsm.eclipse.ProblemMarkers;
import hsm.eclipse.tools.HsmTools;
import hsm.eclipse.tools.ModelValidator;

/**
 * Validation of the models of a project (also of closed files) on build: the problems of every changed
 * {@code .hsm} file (all files on a full build) become problem markers.
 * <p>
 * Needs a {@link ModelValidator} in {@link HsmTools}; without one (the state of the prototype, see the
 * interface) the builder does nothing and the markers come only from the opened editors. Enabled per project
 * with the nature {@value HsmNature#ID} (<i>Configure > Enable HSM Validation</i>).
 */
public class HsmBuilder extends IncrementalProjectBuilder {

    public static final String ID = Activator.PLUGIN_ID + ".builder";

    @Override
    protected IProject[] build(int kind, Map<String, String> args, IProgressMonitor monitor) throws CoreException {
        Optional<ModelValidator> validator = HsmTools.validator();
        if (validator.isEmpty()) {
            return null;
        }
        List<IFile> models = new ArrayList<>();
        IResourceDelta delta = kind == FULL_BUILD ? null : getDelta(getProject());
        if (delta == null) {
            getProject().accept(resource -> {
                if (isModel(resource)) {
                    models.add((IFile) resource);
                }
                return true;
            });
        } else {
            // changed models; (the importers of a changed model are not revalidated yet)
            delta.accept(child -> {
                if (child.getKind() != IResourceDelta.REMOVED && isModel(child.getResource())) {
                    models.add((IFile) child.getResource());
                }
                return true;
            });
        }
        SubMonitor progress = SubMonitor.convert(monitor, "Validating state machines", models.size());
        for (IFile model : models) {
            progress.subTask(model.getName());
            ProblemMarkers.write(model, validator.get().validate(model, progress.split(1)));
        }
        return null;
    }

    @Override
    protected void clean(IProgressMonitor monitor) throws CoreException {
        if (HsmTools.validator().isPresent()) {
            getProject().deleteMarkers(ProblemMarkers.TYPE, false, IResource.DEPTH_INFINITE);
        }
    }

    private static boolean isModel(IResource resource) {
        return resource.getType() == IResource.FILE && "hsm".equalsIgnoreCase(resource.getFileExtension()) && !resource.isDerived();
    }
}

package devm.eclipse.builder;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IMarker;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.IResourceDelta;
import org.eclipse.core.resources.IncrementalProjectBuilder;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IPath;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.SubMonitor;

import devm.eclipse.Activator;
import devm.eclipse.ProblemMarkers;
import devm.eclipse.ProjectFiles;
import devm.eclipse.tools.DevmTools;
import devm.eclipse.tools.ModelProblem;
import devm.eclipse.tools.ModelValidator;

/**
 * Validation of the models of a project (also of closed files) on build: the problems of every changed
 * {@code .devm} file (state machines and structure files) and of the models importing or referencing a changed
 * model or header (all models on a full build or after a change of a generator configuration) become problem
 * markers.
 * <p>
 * Uses the {@link ModelValidator} of {@link DevmTools} (the bundled executable, {@link devm.eclipse.tools.CliValidator});
 * if it is not available (no executable), a warning on the project says so and the markers come only from the
 * opened editors. Enabled per project with the nature {@value DevmNature#ID} (<i>Configure > Enable Device Modeler
 * Validation</i>).
 */
public class DevmBuilder extends IncrementalProjectBuilder {

    public static final String ID = Activator.PLUGIN_ID + ".builder";

    /**
     * The files a model depends on: {@code import "path"} (models and C/C++ headers) and, in structure files,
     * {@code behavior "path"} (the state machine of a component, whose interfaces the ports must match).
     */
    private static final Pattern IMPORT = Pattern.compile("\\b(?:import|behavior)\\s+\"([^\"]+)\"");

    @Override
    protected IProject[] build(int kind, Map<String, String> args, IProgressMonitor monitor) throws CoreException {
        Optional<ModelValidator> validator = DevmTools.validator();
        if (validator.isEmpty()) {
            return null;
        }
        IProject project = getProject();
        project.deleteMarkers(ProblemMarkers.TYPE, false, IResource.DEPTH_ZERO);
        if (!validator.get().isAvailable()) {
            IMarker marker = project.createMarker(ProblemMarkers.TYPE);
            marker.setAttribute(IMarker.SEVERITY, IMarker.SEVERITY_WARNING);
            marker.setAttribute(IMarker.MESSAGE, validator.get().unavailableReason());
            return null;
        }
        List<IFile> models = models(kind == FULL_BUILD ? null : getDelta(project));
        if (models.isEmpty()) {
            return null;
        }
        SubMonitor progress = SubMonitor.convert(monitor, "Validating models", 1);
        Map<IFile, List<ModelProblem>> problems = validator.get().validateAll(models, progress.split(1));
        for (Map.Entry<IFile, List<ModelProblem>> entry : problems.entrySet()) {
            if (entry.getKey().exists()) {
                ProblemMarkers.write(entry.getKey(), entry.getValue());
            }
        }
        return null;
    }

    /** The models to validate: all (no delta), else the changed ones and their importers. */
    private List<IFile> models(IResourceDelta delta) throws CoreException {
        List<IFile> all = new ArrayList<>();
        getProject().accept(resource -> {
            if (isModel(resource)) {
                all.add((IFile) resource);
            }
            return !resource.isDerived() && !resource.getName().startsWith(".") || resource.getType() == IResource.PROJECT;
        });
        if (delta == null) {
            return all;
        }
        Set<IFile> result = new LinkedHashSet<>();
        Set<IPath> changed = new LinkedHashSet<>();
        boolean[] everything = { false };
        delta.accept(child -> {
            IResource resource = child.getResource();
            if (resource.getType() != IResource.FILE) {
                return true;
            }
            if (ProjectFiles.GENERATOR_CONFIG.matcher(resource.getName()).matches()) {
                // include paths / defines of the headers may have changed
                everything[0] = true;
            } else if (ProjectFiles.IMPORTABLE.matcher(resource.getName()).matches()) {
                changed.add(resource.getFullPath());
                if (child.getKind() != IResourceDelta.REMOVED && isModel(resource)) {
                    result.add((IFile) resource);
                }
            }
            return true;
        });
        if (everything[0]) {
            return all;
        }
        if (!changed.isEmpty()) {
            // the models importing a changed (added, removed) model or header
            for (IFile model : all) {
                if (!result.contains(model) && imports(model, changed)) {
                    result.add(model);
                }
            }
        }
        return new ArrayList<>(result);
    }

    /** True if the model imports one of the files (paths relative to the folder of the model). */
    private static boolean imports(IFile model, Set<IPath> files) {
        String text;
        try {
            text = ProjectFiles.read(model);
        } catch (CoreException | IOException e) {
            return false;
        }
        Matcher matcher = IMPORT.matcher(text);
        while (matcher.find()) {
            IPath imported = model.getParent().getFullPath().append(matcher.group(1));
            // a header can also be found through an include path: compare the file names, too
            if (files.contains(imported) || files.stream().anyMatch(file -> file.lastSegment().equals(imported.lastSegment()))) {
                return true;
            }
        }
        return false;
    }

    @Override
    protected void clean(IProgressMonitor monitor) throws CoreException {
        if (DevmTools.validator().isPresent()) {
            getProject().deleteMarkers(ProblemMarkers.TYPE, false, IResource.DEPTH_INFINITE);
        }
    }

    private static boolean isModel(IResource resource) {
        return resource.getType() == IResource.FILE && "devm".equalsIgnoreCase(resource.getFileExtension()) && !resource.isDerived();
    }
}

package hsm.eclipse.tools;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IProgressMonitor;

/**
 * Validation of a model file without an opened editor, used by the project builder ({@code HsmBuilder}) to keep
 * the problem markers of closed files up to date.
 * <p>
 * The editor validates in the page (Langium in the browser) and needs no validator. For closed files the
 * language has to run outside of a browser: {@link CliValidator} runs the bundled self-contained executable
 * ({@code hsm validate --json}, see {@link HsmExecutable}); it is registered in {@link HsmTools} by the activator.
 */
public interface ModelValidator {

    /** The problems of the model (the saved file); an empty list if it is valid. */
    List<ModelProblem> validate(IFile model, IProgressMonitor monitor) throws CoreException;

    /** The problems of several models (implementations may validate them at once); by model. */
    default Map<IFile, List<ModelProblem>> validateAll(List<IFile> models, IProgressMonitor monitor) throws CoreException {
        Map<IFile, List<ModelProblem>> result = new LinkedHashMap<>();
        for (IFile model : models) {
            result.put(model, validate(model, monitor));
        }
        return result;
    }

    /** False if the validator cannot run (e.g. the executable it needs is missing); the builder then skips. */
    default boolean isAvailable() {
        return true;
    }

    /** Why {@link #isAvailable()} is false (a message for the user). */
    default String unavailableReason() {
        return "The validator is not available.";
    }
}

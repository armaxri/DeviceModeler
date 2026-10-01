package hsm.eclipse.tools;

import java.util.List;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IProgressMonitor;

/**
 * Validation of a model file without an opened editor, used by the project builder ({@code HsmBuilder}) to keep
 * the problem markers of closed files up to date.
 * <p>
 * The editor validates in the page (Langium in the browser) and needs no validator. For closed files the
 * language has to run outside of a browser: the intended implementation calls the bundled self-contained
 * executable ({@code hsm validate}, branch {@code claude/bundled-executables}) and parses its output with
 * {@link ModelProblem#fromCliLine(String)}. Register it in {@link HsmTools}.
 */
public interface ModelValidator {

    /** The problems of the model (the saved file); an empty list if it is valid. */
    List<ModelProblem> validate(IFile model, IProgressMonitor monitor) throws CoreException;
}

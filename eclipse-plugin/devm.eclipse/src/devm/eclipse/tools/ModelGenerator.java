package devm.eclipse.tools;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.runtime.CoreException;

/**
 * C++ code generation for a model file (command <i>Generate C++</i>).
 * <p>
 * The current implementation {@link PageGenerator} runs the generator of the language package in the page of the
 * Device Modeler editor (the model is opened if necessary); the page resolves {@code devm.gen.json} like {@code devm generate}
 * and the editor writes the files into the project. An implementation calling the bundled executable
 * ({@code devm generate cpp <model>}) can replace it in {@link DevmTools} to generate without an editor (e.g. for
 * several models or in a builder).
 */
public interface ModelGenerator {

    /**
     * Starts the generation of the C++ code of the model. The result is reported to the user by the
     * implementation (the page shows a message in its status bar).
     */
    void generateCpp(IFile model) throws CoreException;
}

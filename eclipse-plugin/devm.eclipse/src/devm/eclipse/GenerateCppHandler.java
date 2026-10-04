package devm.eclipse;

import org.eclipse.core.commands.AbstractHandler;
import org.eclipse.core.commands.ExecutionEvent;
import org.eclipse.core.commands.ExecutionException;
import org.eclipse.core.resources.IFile;
import org.eclipse.core.runtime.Adapters;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.jface.dialogs.MessageDialog;
import org.eclipse.jface.viewers.ISelection;
import org.eclipse.jface.viewers.IStructuredSelection;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.handlers.HandlerUtil;

import devm.eclipse.tools.DevmTools;

/**
 * Command <i>Generate C++</i> ({@code devm.eclipse.generateCpp}): for the selected {@code .devm} files of the
 * Project Explorer or the model of the active Device Modeler editor, with the {@link devm.eclipse.tools.ModelGenerator} of
 * {@link DevmTools}. Only state machines are generated: structure files (same extension) are skipped.
 */
public class GenerateCppHandler extends AbstractHandler {

    @Override
    public Object execute(ExecutionEvent event) throws ExecutionException {
        ISelection selection = HandlerUtil.getCurrentSelection(event);
        boolean any = false;
        boolean structures = false;
        try {
            if (selection instanceof IStructuredSelection structured && !structured.isEmpty()) {
                for (Object element : structured.toList()) {
                    IFile file = Adapters.adapt(element, IFile.class);
                    if (file != null && "devm".equalsIgnoreCase(file.getFileExtension())) {
                        if (ProjectFiles.isStructureFile(file)) {
                            structures = true;
                        } else {
                            DevmTools.generator().generateCpp(file);
                            any = true;
                        }
                    }
                }
            }
            IEditorPart editor = HandlerUtil.getActiveEditor(event);
            if (!any && !structures && editor instanceof DevmDiagramEditor devmEditor) {
                if (ProjectFiles.isStructureFile(devmEditor.file())) {
                    structures = true;
                } else {
                    DevmTools.generator().generateCpp(devmEditor.file());
                    any = true;
                }
            }
        } catch (CoreException e) {
            throw new ExecutionException(e.getMessage(), e);
        }
        if (!any && structures) {
            MessageDialog.openInformation(HandlerUtil.getActiveShell(event), "Generate C++",
                    "Structure files have no C++ code of their own: generate the state machines of their components (behavior).");
        }
        return null;
    }
}

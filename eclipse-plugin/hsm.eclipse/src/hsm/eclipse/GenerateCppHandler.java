package hsm.eclipse;

import org.eclipse.core.commands.AbstractHandler;
import org.eclipse.core.commands.ExecutionEvent;
import org.eclipse.core.commands.ExecutionException;
import org.eclipse.core.resources.IFile;
import org.eclipse.core.runtime.Adapters;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.jface.viewers.ISelection;
import org.eclipse.jface.viewers.IStructuredSelection;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.handlers.HandlerUtil;

import hsm.eclipse.tools.HsmTools;

/**
 * Command <i>Generate C++</i> ({@code hsm.eclipse.generateCpp}): for the selected {@code .hsm} files of the
 * Project Explorer or the model of the active HSM editor, with the {@link hsm.eclipse.tools.ModelGenerator} of
 * {@link HsmTools}.
 */
public class GenerateCppHandler extends AbstractHandler {

    @Override
    public Object execute(ExecutionEvent event) throws ExecutionException {
        ISelection selection = HandlerUtil.getCurrentSelection(event);
        boolean any = false;
        try {
            if (selection instanceof IStructuredSelection structured && !structured.isEmpty()) {
                for (Object element : structured.toList()) {
                    IFile file = Adapters.adapt(element, IFile.class);
                    if (file != null && "hsm".equalsIgnoreCase(file.getFileExtension())) {
                        HsmTools.generator().generateCpp(file);
                        any = true;
                    }
                }
            }
            IEditorPart editor = HandlerUtil.getActiveEditor(event);
            if (!any && editor instanceof HsmDiagramEditor hsmEditor) {
                HsmTools.generator().generateCpp(hsmEditor.file());
            }
        } catch (CoreException e) {
            throw new ExecutionException(e.getMessage(), e);
        }
        return null;
    }
}

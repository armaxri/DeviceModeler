package devm.eclipse.tools;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.Status;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IWorkbenchPage;
import org.eclipse.ui.IWorkbenchWindow;
import org.eclipse.ui.PlatformUI;
import org.eclipse.ui.ide.IDE;

import devm.eclipse.Activator;
import devm.eclipse.DevmDiagramEditor;

/**
 * Generation in the page: opens the model in the Device Modeler editor (UI thread) and lets its page generate the code
 * ({@code devmApp.generateCpp()}, packages/web/src/host-generate.ts); the editor writes the files.
 */
public class PageGenerator implements ModelGenerator {

    @Override
    public void generateCpp(IFile model) throws CoreException {
        IWorkbenchWindow window = PlatformUI.getWorkbench().getActiveWorkbenchWindow();
        IWorkbenchPage page = window != null ? window.getActivePage() : null;
        if (page == null) {
            throw new CoreException(new Status(IStatus.ERROR, Activator.PLUGIN_ID, "No workbench page to open " + model.getName()));
        }
        IEditorPart editor = IDE.openEditor(page, model, DevmDiagramEditor.ID, true);
        if (!(editor instanceof DevmDiagramEditor devmEditor)) {
            throw new CoreException(new Status(IStatus.ERROR, Activator.PLUGIN_ID, model.getName() + " could not be opened in the Device Modeler editor"));
        }
        devmEditor.runInPage("window.devmApp.generateCpp();");
    }
}

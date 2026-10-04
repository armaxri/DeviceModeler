package hsm.eclipse.builder;

import org.eclipse.core.commands.AbstractHandler;
import org.eclipse.core.commands.ExecutionEvent;
import org.eclipse.core.commands.ExecutionException;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.runtime.Adapters;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.jface.viewers.IStructuredSelection;
import org.eclipse.ui.handlers.HandlerUtil;

/** <i>Configure > Enable / Disable HSM Validation</i> on projects: toggles the {@link HsmNature}. */
public class ToggleNatureHandler extends AbstractHandler {

    @Override
    public Object execute(ExecutionEvent event) throws ExecutionException {
        if (HandlerUtil.getCurrentSelection(event) instanceof IStructuredSelection selection) {
            for (Object element : selection.toList()) {
                IProject project = Adapters.adapt(element, IProject.class);
                if (project != null && project.isOpen()) {
                    try {
                        HsmNature.toggle(project);
                    } catch (CoreException e) {
                        throw new ExecutionException(e.getMessage(), e);
                    }
                }
            }
        }
        return null;
    }
}

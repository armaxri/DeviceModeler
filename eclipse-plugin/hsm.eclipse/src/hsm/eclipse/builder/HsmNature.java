package hsm.eclipse.builder;

import java.util.Arrays;

import org.eclipse.core.resources.ICommand;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IProjectDescription;
import org.eclipse.core.resources.IProjectNature;
import org.eclipse.core.runtime.CoreException;

import hsm.eclipse.Activator;

/** Nature of projects with HSM models: adds the {@link HsmBuilder}. */
public class HsmNature implements IProjectNature {

    public static final String ID = Activator.PLUGIN_ID + ".nature";

    private IProject project;

    @Override
    public void configure() throws CoreException {
        IProjectDescription description = project.getDescription();
        ICommand[] commands = description.getBuildSpec();
        if (Arrays.stream(commands).anyMatch(c -> c.getBuilderName().equals(HsmBuilder.ID))) {
            return;
        }
        ICommand command = description.newCommand();
        command.setBuilderName(HsmBuilder.ID);
        ICommand[] result = Arrays.copyOf(commands, commands.length + 1);
        result[commands.length] = command;
        description.setBuildSpec(result);
        project.setDescription(description, null);
    }

    @Override
    public void deconfigure() throws CoreException {
        IProjectDescription description = project.getDescription();
        description.setBuildSpec(Arrays.stream(description.getBuildSpec())
                .filter(c -> !c.getBuilderName().equals(HsmBuilder.ID)).toArray(ICommand[]::new));
        project.setDescription(description, null);
    }

    @Override
    public IProject getProject() {
        return project;
    }

    @Override
    public void setProject(IProject project) {
        this.project = project;
    }

    /** Adds or removes the nature. */
    public static void toggle(IProject project) throws CoreException {
        IProjectDescription description = project.getDescription();
        String[] natures = description.getNatureIds();
        if (Arrays.asList(natures).contains(ID)) {
            description.setNatureIds(Arrays.stream(natures).filter(n -> !n.equals(ID)).toArray(String[]::new));
        } else {
            String[] result = Arrays.copyOf(natures, natures.length + 1);
            result[natures.length] = ID;
            description.setNatureIds(result);
        }
        project.setDescription(description, null);
    }
}

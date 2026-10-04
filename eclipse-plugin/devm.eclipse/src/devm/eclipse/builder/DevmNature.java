package devm.eclipse.builder;

import java.util.Arrays;

import org.eclipse.core.resources.ICommand;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IProjectDescription;
import org.eclipse.core.resources.IProjectNature;
import org.eclipse.core.runtime.CoreException;

import devm.eclipse.Activator;

/** Nature of projects with Device Modeler models: adds the {@link DevmBuilder}. */
public class DevmNature implements IProjectNature {

    public static final String ID = Activator.PLUGIN_ID + ".nature";

    private IProject project;

    @Override
    public void configure() throws CoreException {
        IProjectDescription description = project.getDescription();
        ICommand[] commands = description.getBuildSpec();
        if (Arrays.stream(commands).anyMatch(c -> c.getBuilderName().equals(DevmBuilder.ID))) {
            return;
        }
        ICommand command = description.newCommand();
        command.setBuilderName(DevmBuilder.ID);
        ICommand[] result = Arrays.copyOf(commands, commands.length + 1);
        result[commands.length] = command;
        description.setBuildSpec(result);
        project.setDescription(description, null);
    }

    @Override
    public void deconfigure() throws CoreException {
        IProjectDescription description = project.getDescription();
        description.setBuildSpec(Arrays.stream(description.getBuildSpec())
                .filter(c -> !c.getBuilderName().equals(DevmBuilder.ID)).toArray(ICommand[]::new));
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

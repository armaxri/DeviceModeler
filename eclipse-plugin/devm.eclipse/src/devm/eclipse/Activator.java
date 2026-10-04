package devm.eclipse;

import java.io.IOException;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.file.Path;

import org.eclipse.core.runtime.FileLocator;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.Status;
import org.eclipse.ui.plugin.AbstractUIPlugin;
import org.osgi.framework.BundleContext;

import devm.eclipse.tools.CliValidator;
import devm.eclipse.tools.DevmTools;

/** The plugin: owns the {@link WebServer} (started with the first editor, stopped with the plugin). */
public class Activator extends AbstractUIPlugin {

    public static final String PLUGIN_ID = "devm.eclipse";

    /** System property: port of the web server (default {@link WebServer#DEFAULT_PORT}, 0 = any free port). */
    public static final String PORT_PROPERTY = "devm.server.port";

    private static Activator plugin;
    private WebServer server;

    @Override
    public void start(BundleContext context) throws Exception {
        super.start(context);
        plugin = this;
        // validation of closed files (builder) with the devm executable (bundled fragment, preference or PATH)
        if (DevmTools.validator().isEmpty()) {
            DevmTools.setValidator(new CliValidator());
        }
    }

    @Override
    public void stop(BundleContext context) throws Exception {
        synchronized (this) {
            if (server != null) {
                server.stop();
                server = null;
            }
        }
        plugin = null;
        super.stop(context);
    }

    public static Activator getDefault() {
        return plugin;
    }

    /** The web server; started on first use. */
    public synchronized WebServer server() throws IOException {
        if (server == null) {
            server = new WebServer(webAppDirectory(), Integer.getInteger(PORT_PROPERTY, WebServer.DEFAULT_PORT));
            getLog().log(new Status(IStatus.INFO, PLUGIN_ID, "Device Modeler web app served on http://127.0.0.1:" + server.port()));
        }
        return server;
    }

    /** The directory {@code webapp/} of the bundle (the built web app, see README.md). */
    private Path webAppDirectory() throws IOException {
        URL entry = getBundle().getEntry("webapp/");
        if (entry == null) {
            throw new IOException("The plugin does not contain the web app (webapp/): build packages/web first, see eclipse-plugin/README.md");
        }
        // the bundle is installed as a directory (Eclipse-BundleShape: dir); otherwise the files are extracted
        URL file = FileLocator.toFileURL(entry);
        try {
            return Path.of(file.toURI());
        } catch (URISyntaxException | IllegalArgumentException e) {
            // toFileURL does not encode spaces
            return Path.of(file.getPath());
        }
    }
}

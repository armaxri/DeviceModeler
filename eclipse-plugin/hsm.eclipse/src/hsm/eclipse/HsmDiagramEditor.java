package hsm.eclipse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

import org.eclipse.core.resources.IContainer;
import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.IResourceChangeEvent;
import org.eclipse.core.resources.IResourceChangeListener;
import org.eclipse.core.resources.IResourceDelta;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.Path;
import org.eclipse.core.runtime.Platform;
import org.eclipse.core.runtime.Status;
import org.eclipse.jface.dialogs.ErrorDialog;
import org.eclipse.jface.dialogs.MessageDialog;
import org.eclipse.swt.SWT;
import org.eclipse.swt.SWTError;
import org.eclipse.swt.SWTException;
import org.eclipse.swt.browser.Browser;
import org.eclipse.swt.layout.FillLayout;
import org.eclipse.swt.widgets.Composite;
import org.eclipse.swt.widgets.Display;
import org.eclipse.swt.widgets.Text;
import org.eclipse.ui.IEditorInput;
import org.eclipse.ui.IEditorSite;
import org.eclipse.ui.PartInitException;
import org.eclipse.ui.ide.IDE;
import org.eclipse.ui.part.EditorPart;

/**
 * Editor of {@code .hsm} files: the HSM web app (Monaco text editor + diagram) in an SWT {@link Browser}, served
 * by the {@link WebServer} of the plugin. The page gets the text of the workspace file and reports its changes
 * (dirty state); <i>Save</i> (Eclipse or {@code Ctrl+S} / <i>Save</i> in the page) writes the workspace file.
 */
public class HsmDiagramEditor extends EditorPart implements HostSession {

    public static final String ID = "hsm.eclipse.editor";

    /** System property: browser engine ({@code edge}, {@code webkit}, {@code chromium} or {@code default}). */
    public static final String BROWSER_PROPERTY = "hsm.browser";

    /** Files the model may import (other models and C/C++ headers below the folder of the edited file). */
    private static final Pattern IMPORTABLE = Pattern.compile(".*\\.(hsm|h|hh|hpp|hxx|h\\+\\+|inl)", Pattern.CASE_INSENSITIVE);
    private static final int MAX_DEPTH = 4;
    private static final int MAX_FILES = 300;
    private static final long MAX_FILE_SIZE = 2_000_000;

    private IFile file;
    private Browser browser;
    private Display display;
    private WebServer server;
    /** The text of the file (as last loaded or saved). */
    private volatile String savedText;
    /** The text of the page (as last reported). */
    private volatile String currentText;
    private boolean dirty;
    private final IResourceChangeListener resourceListener = this::resourceChanged;

    @Override
    public void init(IEditorSite site, IEditorInput input) throws PartInitException {
        IFile inputFile = input.getAdapter(IFile.class);
        if (inputFile == null) {
            throw new PartInitException("The HSM editor only opens files of the workspace.");
        }
        setSite(site);
        setInput(input);
        file = inputFile;
        setPartName(file.getName());
        setTitleToolTip(file.getFullPath().toString());
        try {
            savedText = read(file);
        } catch (CoreException | IOException e) {
            throw new PartInitException("Cannot read " + file.getFullPath() + ": " + e.getMessage(), e);
        }
        currentText = savedText;
        ResourcesPlugin.getWorkspace().addResourceChangeListener(resourceListener, IResourceChangeEvent.POST_CHANGE);
    }

    @Override
    public void createPartControl(Composite parent) {
        display = parent.getDisplay();
        parent.setLayout(new FillLayout());
        try {
            server = Activator.getDefault().server();
            browser = new Browser(parent, browserStyle());
            browser.setUrl(server.register(this));
        } catch (IOException | SWTError e) {
            if (browser != null) {
                browser.dispose();
                browser = null;
            }
            Text message = new Text(parent, SWT.MULTI | SWT.READ_ONLY | SWT.WRAP);
            message.setText("The HSM diagram editor cannot be shown: " + e.getMessage()
                    + "\n\nOpen the file with the text editor instead (Open With > Text Editor).");
            Activator.getDefault().getLog().log(new Status(IStatus.ERROR, Activator.PLUGIN_ID, "HSM editor", e));
        }
    }

    /** Browser engine: Edge (WebView2) on Windows (the default engine of older Eclipse versions is Internet Explorer). */
    private static int browserStyle() {
        String engine = System.getProperty(BROWSER_PROPERTY, "").toLowerCase(Locale.ROOT);
        return switch (engine) {
            case "edge" -> SWT.EDGE;
            case "webkit" -> SWT.WEBKIT;
            case "chromium" -> SWT.CHROMIUM;
            case "default" -> SWT.NONE;
            default -> Platform.OS_WIN32.equals(Platform.getOS()) ? SWT.EDGE : SWT.NONE;
        };
    }

    @Override
    public void setFocus() {
        if (browser != null) {
            browser.setFocus();
        }
    }

    @Override
    public void dispose() {
        ResourcesPlugin.getWorkspace().removeResourceChangeListener(resourceListener);
        if (server != null) {
            server.unregister(this);
        }
        super.dispose();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Save and dirty state

    @Override
    public boolean isDirty() {
        return dirty;
    }

    private void setDirty(boolean dirty) {
        if (this.dirty != dirty) {
            this.dirty = dirty;
            firePropertyChange(PROP_DIRTY);
        }
    }

    @Override
    public void doSave(IProgressMonitor monitor) {
        try {
            write(textOfPage(), monitor);
        } catch (CoreException e) {
            ErrorDialog.openError(getSite().getShell(), "Save failed", "Cannot save " + file.getFullPath(), e.getStatus());
            if (monitor != null) {
                monitor.setCanceled(true);
            }
        }
    }

    /** The current text of the page (the last reported text if the page cannot be asked). */
    private String textOfPage() {
        if (browser != null && !browser.isDisposed()) {
            try {
                Object text = browser.evaluate("return window.hsmApp && window.hsmApp.diagram ? window.hsmApp.getText() : null;");
                if (text instanceof String string) {
                    currentText = string;
                }
            } catch (SWTException e) {
                // page not loaded (yet)
            }
        }
        return currentText;
    }

    private void write(String text, IProgressMonitor monitor) throws CoreException {
        byte[] bytes;
        try {
            bytes = text.getBytes(file.getCharset());
        } catch (IOException e) {
            throw new CoreException(new Status(IStatus.ERROR, Activator.PLUGIN_ID, e.getMessage(), e));
        }
        // before writing: the resource change of the save is not an external change
        String previous = savedText;
        savedText = text;
        try {
            file.setContents(new ByteArrayInputStream(bytes), IResource.KEEP_HISTORY | IResource.FORCE, monitor);
        } catch (CoreException e) {
            savedText = previous;
            throw e;
        }
        currentText = text;
        runInUi(() -> setDirty(false));
    }

    @Override
    public boolean isSaveAsAllowed() {
        return false;
    }

    @Override
    public void doSaveAs() {
        // not supported
    }

    // ---------------------------------------------------------------------------------------------------------
    // HostSession (called by the web server, not on the UI thread)

    @Override
    public String fileName() {
        return file.getName();
    }

    @Override
    public String text() {
        return currentText;
    }

    @Override
    public Map<String, String> importableFiles() throws IOException {
        Map<String, String> files = new TreeMap<>();
        try {
            collect(file.getParent(), "", 0, files);
        } catch (CoreException e) {
            throw new IOException(e.getMessage(), e);
        }
        return files;
    }

    private void collect(IContainer container, String prefix, int depth, Map<String, String> files) throws CoreException, IOException {
        for (IResource member : container.members()) {
            if (files.size() >= MAX_FILES) {
                return;
            }
            String path = prefix + member.getName();
            if (member instanceof IFile memberFile) {
                if (!memberFile.equals(file) && IMPORTABLE.matcher(member.getName()).matches()
                        && member.getLocation() != null && member.getLocation().toFile().length() <= MAX_FILE_SIZE) {
                    files.put(path, read(memberFile));
                }
            } else if (member instanceof IContainer folder && depth < MAX_DEPTH && !member.isDerived() && !member.getName().startsWith(".")) {
                collect(folder, path + "/", depth + 1, files);
            }
        }
    }

    @Override
    public void changed(String text) {
        currentText = text;
        runInUi(() -> setDirty(!text.equals(savedText)));
    }

    @Override
    public void save(String text) throws IOException {
        try {
            write(text, null);
        } catch (CoreException e) {
            throw new IOException(e.getMessage(), e);
        }
    }

    @Override
    public boolean open(String path) {
        IFile target = file.getParent().getFile(new Path(path));
        if (!target.exists()) {
            return false;
        }
        AtomicReference<Boolean> opened = new AtomicReference<>(false);
        display.syncExec(() -> {
            try {
                IDE.openEditor(getSite().getPage(), target, true);
                opened.set(true);
            } catch (PartInitException e) {
                Activator.getDefault().getLog().log(e.getStatus());
            }
        });
        return opened.get();
    }

    @Override
    public String export(String fileName, byte[] content) throws IOException {
        String name = new Path(fileName).lastSegment();
        if (name == null || name.isBlank() || name.startsWith(".")) {
            throw new IOException("Invalid file name " + fileName);
        }
        IFile target = file.getParent().getFile(new Path(name));
        try {
            if (target.exists()) {
                target.setContents(new ByteArrayInputStream(content), IResource.KEEP_HISTORY | IResource.FORCE, null);
            } else {
                target.create(new ByteArrayInputStream(content), IResource.FORCE, null);
            }
        } catch (CoreException e) {
            throw new IOException(e.getMessage(), e);
        }
        return "Exported " + target.getFullPath() + ".";
    }

    // ---------------------------------------------------------------------------------------------------------
    // Changes of the workspace

    private void resourceChanged(IResourceChangeEvent event) {
        IResourceDelta delta = event.getDelta();
        if (delta == null) {
            return;
        }
        IResourceDelta fileDelta = delta.findMember(file.getFullPath());
        if (fileDelta != null && fileDelta.getKind() == IResourceDelta.REMOVED) {
            // deleted, moved or renamed: the editor is closed (a prototype; a text editor would follow a move)
            runInUi(() -> getSite().getPage().closeEditor(this, false));
            return;
        }
        if (fileDelta != null && (fileDelta.getFlags() & (IResourceDelta.CONTENT | IResourceDelta.REPLACED)) != 0) {
            String text;
            try {
                text = read(file);
            } catch (CoreException | IOException e) {
                return;
            }
            if (!text.equals(savedText)) {
                runInUi(() -> externalChange(text));
            }
            return;
        }
        // other models / headers below the folder of the file: imported files may have changed
        IResourceDelta folderDelta = delta.findMember(file.getParent().getFullPath());
        if (folderDelta != null && containsImportableChange(folderDelta)) {
            runInUi(() -> reloadPage(false));
        }
    }

    private static boolean containsImportableChange(IResourceDelta delta) {
        if (delta.getResource() instanceof IFile && IMPORTABLE.matcher(delta.getResource().getName()).matches()) {
            return true;
        }
        for (IResourceDelta child : delta.getAffectedChildren()) {
            if (containsImportableChange(child)) {
                return true;
            }
        }
        return false;
    }

    /** The file was changed by someone else (another editor, git, …). */
    private void externalChange(String text) {
        if (dirty && !MessageDialog.openQuestion(getSite().getShell(), "File changed",
                file.getName() + " was changed on disk. Replace the unsaved changes of the editor with the file?")) {
            // the editor keeps its text; saving it overwrites the file
            savedText = text;
            return;
        }
        savedText = text;
        currentText = text;
        setDirty(false);
        reloadPage(true);
    }

    private void reloadPage(boolean replaceText) {
        if (browser != null && !browser.isDisposed()) {
            browser.execute("window.hsmApp && window.hsmApp.reloadFromHost(" + replaceText + ");");
        }
    }

    // ---------------------------------------------------------------------------------------------------------

    private void runInUi(Runnable runnable) {
        Display current = display != null ? display : Display.getDefault();
        if (current.isDisposed()) {
            return;
        }
        current.asyncExec(() -> {
            if (browser == null || !browser.isDisposed()) {
                runnable.run();
            }
        });
    }

    private static String read(IFile file) throws CoreException, IOException {
        try (InputStream in = file.getContents(true)) {
            return new String(in.readAllBytes(), file.getCharset());
        }
    }
}

package devm.eclipse;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.eclipse.jface.viewers.ITreeContentProvider;
import org.eclipse.jface.viewers.IStructuredSelection;
import org.eclipse.jface.viewers.LabelProvider;
import org.eclipse.jface.viewers.TreeViewer;
import org.eclipse.swt.graphics.Image;
import org.eclipse.swt.widgets.Composite;
import org.eclipse.ui.ISharedImages;
import org.eclipse.ui.PlatformUI;
import org.eclipse.ui.views.contentoutline.ContentOutlinePage;

/**
 * The Outline view of the Device Modeler editor: the elements of the model as reported by the page (state machines:
 * definitions, states, regions, pseudo states, transitions; structure files: structs, components, subsystems,
 * systems, threads, ports, instances, connections, delegations) ({@code HostOutlineNode} of packages/web/src/host.ts).
 * Selecting an element selects its text and its diagram element in the page.
 */
public class DevmOutlinePage extends ContentOutlinePage {

    /** An element of the outline; offsets in the text of the page. */
    public record Node(String label, String kind, int offset, int end, List<Node> children) {

        static List<Node> fromJson(Object json) {
            List<Node> nodes = new ArrayList<>();
            for (Object item : Json.array(json)) {
                Map<String, Object> map = Json.object(item);
                nodes.add(new Node(Json.string(map.get("label"), ""), Json.string(map.get("kind"), ""),
                        Json.integer(map.get("offset"), 0), Json.integer(map.get("end"), 0), fromJson(map.get("children"))));
            }
            return nodes;
        }
    }

    private final DevmDiagramEditor editor;
    private List<Node> nodes = List.of();
    private boolean updating;

    public DevmOutlinePage(DevmDiagramEditor editor) {
        this.editor = editor;
    }

    @Override
    public void createControl(Composite parent) {
        super.createControl(parent);
        TreeViewer viewer = getTreeViewer();
        viewer.setContentProvider(new ITreeContentProvider() {
            @Override
            public Object[] getElements(Object input) {
                return ((List<?>) input).toArray();
            }

            @Override
            public Object[] getChildren(Object element) {
                return ((Node) element).children().toArray();
            }

            @Override
            public Object getParent(Object element) {
                return null;
            }

            @Override
            public boolean hasChildren(Object element) {
                return !((Node) element).children().isEmpty();
            }
        });
        viewer.setLabelProvider(new LabelProvider() {
            @Override
            public String getText(Object element) {
                return ((Node) element).label();
            }

            @Override
            public Image getImage(Object element) {
                ISharedImages images = PlatformUI.getWorkbench().getSharedImages();
                return switch (((Node) element).kind()) {
                    case "statemachine", "state", "region", "component", "subsystem", "system", "thread" -> images.getImage(ISharedImages.IMG_OBJ_FOLDER);
                    case "definitions", "struct", "behavior" -> images.getImage(ISharedImages.IMG_OBJ_FILE);
                    default -> images.getImage(ISharedImages.IMG_OBJ_ELEMENT);
                };
            }
        });
        viewer.setAutoExpandLevel(3);
        viewer.setInput(nodes);
        viewer.addSelectionChangedListener(event -> {
            if (!updating && event.getSelection() instanceof IStructuredSelection selection && selection.getFirstElement() instanceof Node node) {
                editor.reveal(node.offset(), node.end(), false);
            }
        });
    }

    /** New outline of the page (UI thread). */
    public void setNodes(List<Node> nodes) {
        if (nodes.equals(this.nodes)) {
            return;
        }
        this.nodes = nodes;
        TreeViewer viewer = getTreeViewer();
        if (viewer != null && !viewer.getControl().isDisposed()) {
            updating = true;
            try {
                Object[] expanded = viewer.getExpandedElements();
                viewer.setInput(nodes);
                // records are equal by value: unchanged elements stay expanded
                viewer.setExpandedElements(expanded);
            } finally {
                updating = false;
            }
        }
    }

    public List<Node> nodes() {
        return nodes;
    }
}

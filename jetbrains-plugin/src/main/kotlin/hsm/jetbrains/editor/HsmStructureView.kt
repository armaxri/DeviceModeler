package hsm.jetbrains.editor

import com.intellij.icons.AllIcons
import com.intellij.ide.projectView.PresentationData
import com.intellij.ide.structureView.FileEditorPositionListener
import com.intellij.ide.structureView.ModelListener
import com.intellij.ide.structureView.StructureViewModel
import com.intellij.ide.structureView.StructureViewTreeElement
import com.intellij.ide.structureView.TreeBasedStructureViewBuilder
import com.intellij.ide.util.treeView.smartTree.Filter
import com.intellij.ide.util.treeView.smartTree.Grouper
import com.intellij.ide.util.treeView.smartTree.Sorter
import com.intellij.navigation.ItemPresentation
import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.util.Disposer
import hsm.jetbrains.model.OutlineNode
import java.util.concurrent.CopyOnWriteArrayList
import javax.swing.Icon

/**
 * The Structure tool window of the HSM editor: the structure of the model (state machine, definitions, states,
 * regions, pseudo states, transitions) as reported by the page. Selecting an element selects its text and its
 * diagram element.
 */
class HsmStructureViewBuilder(private val editor: HsmSplitEditor) : TreeBasedStructureViewBuilder() {
    override fun createStructureViewModel(textEditor: Editor?): StructureViewModel = HsmStructureViewModel(editor)
    override fun isRootNodeShown(): Boolean = false
}

class HsmStructureViewModel(private val editor: HsmSplitEditor) : StructureViewModel, Disposable {

    private val listeners = CopyOnWriteArrayList<ModelListener>()
    private val root = RootElement()

    private val outlineListener: () -> Unit = { listeners.forEach { it.onModelChanged() } }

    init {
        Disposer.register(editor, this)
        editor.diagram.addOutlineListener(outlineListener)
    }

    private inner class RootElement : StructureViewTreeElement {
        override fun getValue(): Any = editor.file ?: this
        override fun getPresentation(): ItemPresentation = PresentationData(editor.file?.name ?: "", null, AllIcons.FileTypes.Any_type, null)
        override fun getChildren(): Array<StructureViewTreeElement> =
            editor.diagram.outline.mapIndexed { index, node -> NodeElement(node, listOf(index)) }.toTypedArray()
        override fun navigate(requestFocus: Boolean) {}
        override fun canNavigate(): Boolean = false
        override fun canNavigateToSource(): Boolean = false
    }

    /** An element of the outline; its value is its position in the tree (stable over updates: keeps the expansion). */
    private inner class NodeElement(val node: OutlineNode, private val path: List<Int>) : StructureViewTreeElement {
        override fun getValue(): Any = path + node.label.hashCode()
        override fun getPresentation(): ItemPresentation = PresentationData(node.label, null, icon(node.kind), null)
        override fun getChildren(): Array<StructureViewTreeElement> =
            node.children.mapIndexed { index, child -> NodeElement(child, path + index) }.toTypedArray()
        override fun navigate(requestFocus: Boolean) = editor.select(node.offset, node.end)
        override fun canNavigate(): Boolean = true
        override fun canNavigateToSource(): Boolean = true
    }

    private fun icon(kind: String): Icon = when (kind) {
        "statemachine" -> AllIcons.Nodes.Class
        "definitions" -> AllIcons.Nodes.Interface
        "state" -> AllIcons.Nodes.Folder
        "region" -> AllIcons.Nodes.Package
        "pseudostate" -> AllIcons.Nodes.Static
        "transition" -> AllIcons.Nodes.Method
        else -> AllIcons.Nodes.Property
    }

    override fun getRoot(): StructureViewTreeElement = root
    override fun getGroupers(): Array<Grouper> = Grouper.EMPTY_ARRAY
    override fun getSorters(): Array<Sorter> = Sorter.EMPTY_ARRAY
    override fun getFilters(): Array<Filter> = Filter.EMPTY_ARRAY
    override fun getCurrentEditorElement(): Any? = null
    override fun addEditorPositionListener(listener: FileEditorPositionListener) {}
    override fun removeEditorPositionListener(listener: FileEditorPositionListener) {}
    override fun addModelListener(listener: ModelListener) {
        listeners.add(listener)
    }
    override fun removeModelListener(listener: ModelListener) {
        listeners.remove(listener)
    }
    override fun shouldEnterElement(element: Any?): Boolean = false

    override fun dispose() {
        editor.diagram.removeOutlineListener(outlineListener)
        listeners.clear()
    }
}

package hsm.jetbrains.editor

import com.intellij.icons.AllIcons
import com.intellij.ide.structureView.StructureViewBuilder
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.fileEditor.TextEditorWithPreview
import com.intellij.openapi.fileEditor.impl.text.TextEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.DumbAwareToggleAction
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.pom.Navigatable
import hsm.jetbrains.model.ProjectPaths
import javax.swing.Icon

/**
 * The editor of `.hsm` files: the IntelliJ text editor and the [HsmDiagramEditor] (the web app) on the same
 * document, shown as *Text*, *Text and Diagram* or *Diagram* (default; *Text* if JCEF is not available).
 */
class HsmSplitEditor(textEditor: TextEditor, val diagram: HsmDiagramEditor, layout: Layout) :
    TextEditorWithPreview(textEditor, diagram, "HSM Editor", layout) {

    private val textAction = LayoutAction("Text", "Show the text editor only", AllIcons.General.LayoutEditorOnly, Layout.SHOW_EDITOR)
    private val splitAction = LayoutAction("Text and Diagram", "Show the text editor and the diagram", AllIcons.General.LayoutEditorPreview, Layout.SHOW_EDITOR_AND_PREVIEW)
    private val diagramAction = LayoutAction("Diagram", "Show the diagram editor only", AllIcons.General.LayoutPreviewOnly, Layout.SHOW_PREVIEW)

    inner class LayoutAction(text: String, description: String, icon: Icon, private val target: Layout) :
        DumbAwareToggleAction(text, description, icon) {
        override fun isSelected(e: AnActionEvent): Boolean = getLayout() == target
        override fun setSelected(e: AnActionEvent, state: Boolean) {
            if (state) {
                setLayout(target)
            }
        }
        override fun getActionUpdateThread() = ActionUpdateThread.EDT
    }

    override val showEditorAction: ToggleAction get() = textAction
    override val showEditorAndPreviewAction: ToggleAction get() = splitAction
    override val showPreviewAction: ToggleAction get() = diagramAction

    /** Navigation (problems, search results, structure): the text editor and the page select the position. */
    override fun navigateTo(navigatable: Navigatable) {
        super.navigateTo(navigatable)
        val descriptor = navigatable as? OpenFileDescriptor ?: return
        val document = diagram.session.document
        val offset = when {
            descriptor.offset >= 0 -> descriptor.offset
            descriptor.line >= 0 && descriptor.line < document.lineCount ->
                minOf(document.getLineStartOffset(descriptor.line) + maxOf(descriptor.column, 0), document.getLineEndOffset(descriptor.line))
            else -> return
        }
        if (getLayout() != Layout.SHOW_EDITOR) {
            diagram.reveal(offset, offset)
        }
    }

    /** Selects a range in the text editor and in the page (structure view). */
    fun select(offset: Int, end: Int) {
        val editor = textEditor.editor
        val length = editor.document.textLength
        editor.caretModel.moveToOffset(offset.coerceIn(0, length))
        editor.selectionModel.setSelection(offset.coerceIn(0, length), end.coerceIn(0, length))
        editor.scrollingModel.scrollToCaret(com.intellij.openapi.editor.ScrollType.MAKE_VISIBLE)
        if (getLayout() != Layout.SHOW_EDITOR) {
            diagram.reveal(offset, end)
        }
    }

    override fun getStructureViewBuilder(): StructureViewBuilder = HsmStructureViewBuilder(this)
}

/** Opens `.hsm` files with the [HsmSplitEditor] (instead of the plain text editor). */
class HsmEditorProvider : FileEditorProvider, DumbAware {

    override fun accept(project: Project, file: VirtualFile): Boolean = !file.isDirectory && ProjectPaths.isModel(file.name)

    override fun acceptRequiresReadAction(): Boolean = false

    override fun createEditor(project: Project, file: VirtualFile): FileEditor {
        val textEditor = TextEditorProvider.getInstance().createEditor(project, file) as TextEditor
        val diagram = HsmDiagramEditor(project, file)
        return HsmSplitEditor(textEditor, diagram, if (diagram.hasPage) TextEditorWithPreview.Layout.SHOW_PREVIEW else TextEditorWithPreview.Layout.SHOW_EDITOR)
    }

    override fun getEditorTypeId(): String = "hsm-diagram-editor"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

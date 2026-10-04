package devm.jetbrains.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.vfs.VirtualFile
import devm.jetbrains.DevmNotifications
import devm.jetbrains.editor.ProjectFiles
import devm.jetbrains.editor.DevmSplitEditor
import devm.jetbrains.model.ProjectPaths
import devm.jetbrains.problems.DevmValidation

/**
 * *Generate C++* for the selected state machines (`.devm` files that are no structure files; project view, editor
 * tab) or the model of the active editor: the
 * generator of the language package runs in the page of the diagram editor (opened if necessary, like the
 * Eclipse plugin); the configuration is resolved like `devm generate` (nearest `devm.gen.json` listing the model,
 * else *Settings > Tools > Device Modeler*), the files are written into the project.
 */
class GenerateCppAction : DumbAwareAction() {

    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && models(e).isNotEmpty()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        for (model in models(e)) {
            val editors = FileEditorManager.getInstance(project).openFile(model, false)
            val editor = editors.filterIsInstance<DevmSplitEditor>().firstOrNull()
            if (editor == null || !editor.diagram.hasPage) {
                DevmNotifications.notify(project, "C++ generation of ${model.name} needs the diagram editor (JCEF): " +
                    (editor?.diagram?.unavailableReason ?: "the Device Modeler editor is not available.") +
                    " Use devm generate or cmake/DevmGenerate.cmake instead.", NotificationType.WARNING)
                continue
            }
            editor.diagram.generateCpp()
        }
    }

    private fun models(e: AnActionEvent): List<VirtualFile> {
        val files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.toList() ?: listOfNotNull(e.getData(CommonDataKeys.VIRTUAL_FILE))
        return files.filter { !it.isDirectory && ProjectPaths.isModel(it.name) && !isStructureFile(it) }
    }

    /** Structure files have no generator (the action is offered for state machines only). */
    private fun isStructureFile(file: VirtualFile): Boolean = try {
        ProjectPaths.isStructureText(ProjectFiles.text(file))
    } catch (e: java.io.IOException) {
        false
    }
}

/** *Validate Device Models*: all models of the project with `devm validate` (Problems tool window, Project Errors). */
class ValidateModelsAction : DumbAwareAction() {

    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        DevmValidation.get(project).validateAll()
    }
}

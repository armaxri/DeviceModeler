package hsm.jetbrains.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.vfs.VirtualFile
import hsm.jetbrains.HsmNotifications
import hsm.jetbrains.editor.HsmSplitEditor
import hsm.jetbrains.model.ProjectPaths
import hsm.jetbrains.problems.HsmValidation

/**
 * *Generate C++* for the selected `.hsm` files (project view, editor tab) or the model of the active editor: the
 * generator of the language package runs in the page of the diagram editor (opened if necessary, like the
 * Eclipse plugin); the configuration is resolved like `hsm generate` (nearest `hsm.gen.json` listing the model,
 * else *Settings > Tools > HSM Modeler*), the files are written into the project.
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
            val editor = editors.filterIsInstance<HsmSplitEditor>().firstOrNull()
            if (editor == null || !editor.diagram.hasPage) {
                HsmNotifications.notify(project, "C++ generation of ${model.name} needs the diagram editor (JCEF): " +
                    (editor?.diagram?.unavailableReason ?: "the HSM editor is not available.") +
                    " Use hsm generate or cmake/HsmGenerate.cmake instead.", NotificationType.WARNING)
                continue
            }
            editor.diagram.generateCpp()
        }
    }

    private fun models(e: AnActionEvent): List<VirtualFile> {
        val files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.toList() ?: listOfNotNull(e.getData(CommonDataKeys.VIRTUAL_FILE))
        return files.filter { !it.isDirectory && ProjectPaths.isModel(it.name) }
    }
}

/** *Validate HSM Models*: all models of the project with `hsm validate` (Problems tool window, Project Errors). */
class ValidateModelsAction : DumbAwareAction() {

    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        HsmValidation.get(project).validateAll()
    }
}

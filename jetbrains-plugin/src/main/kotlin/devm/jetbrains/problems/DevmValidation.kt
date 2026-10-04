package devm.jetbrains.problems

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCopyEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent
import com.intellij.util.Alarm
import devm.jetbrains.readAction
import devm.jetbrains.DevmNotifications
import devm.jetbrains.cli.CliValidator
import devm.jetbrains.cli.DevmExecutable
import devm.jetbrains.editor.DevmDiagramEditor
import devm.jetbrains.editor.ProjectFiles
import devm.jetbrains.model.ModelProblem
import devm.jetbrains.model.ProblemSource
import devm.jetbrains.model.ProjectPaths
import devm.jetbrains.settings.DevmSettings
import java.io.IOException
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Validation of saved models with the `devm` executable (`devm validate --json`), also of closed files – the
 * counterpart of the builder of the Eclipse plugin: after a model, header or generator configuration of the
 * project was saved (changed on disk), the changed models and the models importing a changed model or header
 * are validated (all models after a change of a generator configuration); *Tools > Validate Device Models*
 * validates all models. Models with an opened diagram editor are left to its page (it reports the problems
 * of the unsaved text). The problems go to [DevmProblems].
 */
@Service(Service.Level.PROJECT)
class DevmValidation(private val project: Project) : Disposable {

    private val log = logger<DevmValidation>()
    private val alarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)
    private val lock = Any()
    private val changedModels = LinkedHashSet<VirtualFile>()
    private val changedPaths = LinkedHashSet<String>()
    private var everything = false
    private val missingExecutableNotified = AtomicBoolean()

    override fun dispose() {
    }

    /** Files of the project were changed (BulkFileListener of the project). */
    fun filesChanged(events: List<VFileEvent>) {
        if (!DevmSettings.get().state.validateOnSave) {
            return
        }
        var any = false
        for (event in events) {
            val file = event.file
            val name = when (event) {
                is VFilePropertyChangeEvent -> if (event.propertyName == VirtualFile.PROP_NAME) event.newValue.toString() else continue
                is VFileCreateEvent -> event.childName
                is VFileCopyEvent -> event.newChildName
                is VFileContentChangeEvent, is VFileDeleteEvent, is VFileMoveEvent -> file?.name ?: continue
                else -> continue
            }
            val config = ProjectPaths.isGeneratorConfig(name)
            if (!config && !ProjectPaths.isImportable(name)) {
                if (event is VFileDeleteEvent && file?.isDirectory == true) {
                    forgetDeleted()
                }
                continue
            }
            synchronized(lock) {
                if (config) {
                    everything = true
                } else {
                    event.path.let { changedPaths.add(ProjectPaths.normalize(it)) }
                    (event as? VFileMoveEvent)?.oldPath?.let { changedPaths.add(ProjectPaths.normalize(it)) }
                    (event as? VFilePropertyChangeEvent)?.oldPath?.let { changedPaths.add(ProjectPaths.normalize(it)) }
                    if (ProjectPaths.isModel(name) && file != null && event !is VFileDeleteEvent) {
                        changedModels.add(file)
                    }
                }
            }
            if (event is VFileDeleteEvent && file != null) {
                DevmProblems.get(project).remove(file)
            }
            any = true
        }
        if (any) {
            alarm.cancelAllRequests()
            alarm.addRequest({ validateChanged() }, 1000)
        }
    }

    private fun forgetDeleted() {
        val problems = DevmProblems.get(project)
        problems.files().filter { !it.isValid }.forEach { problems.remove(it) }
    }

    private fun validateChanged() {
        if (project.isDisposed) {
            return
        }
        val models: List<VirtualFile>
        val paths: Set<String>
        val all: Boolean
        synchronized(lock) {
            models = changedModels.toList()
            paths = changedPaths.toSet()
            all = everything
            changedModels.clear()
            changedPaths.clear()
            everything = false
        }
        val projectModels = models()
        val selected = if (all) projectModels else {
            val result = LinkedHashSet(models.filter { it.isValid && it in projectModels })
            if (paths.isNotEmpty()) {
                for (model in projectModels) {
                    if (model !in result && importsAny(model, paths)) {
                        result.add(model)
                    }
                }
            }
            result.toList()
        }
        if (selected.isNotEmpty()) {
            validateInBackground(selected, explicit = false)
        }
    }

    private fun importsAny(model: VirtualFile, paths: Set<String>): Boolean = try {
        ProjectPaths.imports(model.parent.path, ProjectFiles.text(model), paths)
    } catch (e: IOException) {
        false
    }

    /** The models (`.devm`: state machines and structure files) of the project content (not excluded). */
    fun models(): List<VirtualFile> = readAction {
        val models = ArrayList<VirtualFile>()
        ProjectFileIndex.getInstance(project).iterateContent { file ->
            if (!file.isDirectory && ProjectPaths.isModel(file.name)) {
                models.add(file)
            }
            true
        }
        models
    }

    /** *Validate Device Models*: all models of the project. */
    fun validateAll() {
        validateInBackground({ models() }, explicit = true)
    }

    private fun validateInBackground(models: List<VirtualFile>, explicit: Boolean) = validateInBackground({ models }, explicit)

    /** Validates the models (computed in the background) in a background task. */
    private fun validateInBackground(modelsToValidate: () -> List<VirtualFile>, explicit: Boolean) {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Validating Device Modeler models", true) {
            override fun run(indicator: ProgressIndicator) {
                val models = modelsToValidate()
                val count = validate(models.filter { !DevmDiagramEditor.hasOpenPage(it) }, indicator, explicit)
                if (explicit && count != null) {
                    val problems = models.sumOf { DevmProblems.get(project).get(it)?.problems?.size ?: 0 }
                    DevmNotifications.notify(project, "Validated $count models: $problems problems (see the Problems tool window, Project Errors).")
                }
            }
        })
    }

    /** Validates a model now (annotator of a saved, closed model); `null` if there is no executable or validation failed. */
    fun validateNow(model: VirtualFile): List<ModelProblem>? {
        if (!DevmSettings.get().state.validateOnSave) {
            return null
        }
        validate(listOf(model), null, explicit = false) ?: return null
        return DevmProblems.get(project).get(model)?.problems
    }

    /** Validates models (by project root); returns the number of validated models or `null` without executable. */
    private fun validate(models: List<VirtualFile>, indicator: ProgressIndicator?, explicit: Boolean): Int? {
        if (models.isEmpty()) {
            return 0
        }
        val executable = DevmExecutable.locate()
        if (executable == null) {
            if (explicit || missingExecutableNotified.compareAndSet(false, true)) {
                DevmNotifications.notifyWithSettings(project, "${DevmExecutable.missingReason()} Closed models are not validated; " +
                    "install the devm command line tool (see the README of the plugin) or set its path.")
            }
            return null
        }
        val validator = CliValidator(executable.path)
        var count = 0
        for ((root, rootModels) in models.filter { it.isValid && it.isInLocalFileSystem }.groupBy { ProjectFiles.root(project, it) }) {
            val stamps = rootModels.associateWith { it.modificationStamp }
            val paths = rootModels.associateBy { Path.of(it.path) }
            try {
                val result = validator.validate(paths.keys.toList(), Path.of(root.path)) { indicator?.isCanceled == true || project.isDisposed }
                for ((path, problems) in result) {
                    val model = paths[path] ?: continue
                    DevmProblems.get(project).update(model, DevmProblems.FileProblems(ProblemSource.CLI, problems, -1, stamps[model] ?: -1))
                    count++
                }
            } catch (e: InterruptedException) {
                return count
            } catch (e: IOException) {
                log.warn(e)
                if (explicit) {
                    DevmNotifications.notifyWithSettings(project, e.message ?: e.toString(), com.intellij.notification.NotificationType.ERROR)
                }
                return null
            }
        }
        return count
    }

    companion object {
        fun get(project: Project): DevmValidation = project.service()
    }
}

/** Changes of files → [DevmValidation] (registered in plugin.xml for every project). */
class DevmValidationListener(private val project: Project) : BulkFileListener {
    override fun after(events: List<VFileEvent>) {
        val index = ProjectFileIndex.getInstance(project)
        val relevant = readAction {
            events.filter { event ->
                val parent = when (event) {
                    is VFileCreateEvent -> event.parent
                    is VFileCopyEvent -> event.newParent
                    else -> event.file?.parent
                }
                parent != null && parent.isValid && index.isInContent(parent) || event is VFileDeleteEvent
            }
        }
        if (relevant.isNotEmpty() && !project.isDisposed) {
            DevmValidation.get(project).filesChanged(relevant)
        }
    }
}

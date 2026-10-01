package hsm.jetbrains.problems

import com.intellij.analysis.problemsView.FileProblem
import com.intellij.analysis.problemsView.ProblemsCollector
import com.intellij.analysis.problemsView.ProblemsProvider
import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.problems.WolfTheProblemSolver
import com.intellij.psi.PsiManager
import hsm.jetbrains.readAction
import hsm.jetbrains.model.ModelProblem
import hsm.jetbrains.model.ProblemSource
import hsm.jetbrains.model.Severity
import java.util.concurrent.ConcurrentHashMap
import javax.swing.Icon

/**
 * The problems of the models of a project, from the pages of the opened diagram editors (the text of the editor)
 * and from `hsm validate` (saved files): shown in the *Problems* tool window (*Project Errors*, also for closed
 * files, like the markers of the Eclipse plugin), as red files in the project view (WolfTheProblemSolver) and
 * in the text editor ([HsmExternalAnnotator]).
 */
@Service(Service.Level.PROJECT)
class HsmProblems(override val project: Project) : ProblemsProvider {

    /** The problems of a file and the text they belong to. */
    data class FileProblems(
        val source: ProblemSource,
        val problems: List<ModelProblem>,
        /** Length of the validated text (page), -1 if unknown. */
        val textLength: Int,
        /** Modification stamp of the validated file (command line tool), -1 if unknown. */
        val fileStamp: Long,
    )

    /** A problem of the Problems tool window. */
    class HsmFileProblem(
        override val provider: HsmProblems,
        override val file: VirtualFile,
        val problem: ModelProblem,
    ) : FileProblem {
        override val text: String get() = problem.message
        override val line: Int get() = (problem.line - 1).coerceAtLeast(0)
        override val column: Int get() = (problem.column - 1).coerceAtLeast(0)
        override val icon: Icon get() = when (problem.severity) {
            Severity.ERROR -> AllIcons.General.Error
            Severity.WARNING -> AllIcons.General.Warning
            Severity.INFO -> AllIcons.General.Information
        }

        override fun equals(other: Any?): Boolean = other is HsmFileProblem && other.file == file && other.problem == problem
        override fun hashCode(): Int = file.hashCode() * 31 + problem.hashCode()
    }

    private val problems = ConcurrentHashMap<VirtualFile, FileProblems>()
    private val shown = HashMap<VirtualFile, List<HsmFileProblem>>()

    override fun dispose() {
    }

    /** The problems of a file, if it was validated. */
    fun get(file: VirtualFile): FileProblems? = problems[file]

    /** New problems of a file (any thread). */
    fun update(file: VirtualFile, fileProblems: FileProblems) {
        val previous = problems.put(file, fileProblems)
        if (previous?.problems == fileProblems.problems) {
            if (previous.source != fileProblems.source || previous.textLength != fileProblems.textLength) {
                restartHighlighting(file)
            }
            return
        }
        ApplicationManager.getApplication().invokeLater({ show(file) }, project.disposed)
        restartHighlighting(file)
    }

    /** Forgets the problems of a file (deleted). */
    fun remove(file: VirtualFile) {
        if (problems.remove(file) != null) {
            ApplicationManager.getApplication().invokeLater({ show(file) }, project.disposed)
        }
    }

    /** Files with problems. */
    fun files(): Set<VirtualFile> = problems.keys.toSet()

    private fun show(file: VirtualFile) {
        val current = problems[file]?.problems.orEmpty().map { HsmFileProblem(this, file, it) }
        val previous = shown.put(file, current).orEmpty()
        val collector = ProblemsCollector.getInstance(project)
        val currentSet = current.toSet()
        val previousSet = previous.toSet()
        previous.filter { it !in currentSet }.forEach { collector.problemDisappeared(it) }
        current.filter { it !in previousSet }.forEach { collector.problemAppeared(it) }
        if (current.isEmpty()) {
            shown.remove(file)
        }
        // red files in the project view (WolfTheProblemSolver must not be called on the EDT)
        val errors = file.isValid && current.any { it.problem.severity == Severity.ERROR }
        ApplicationManager.getApplication().executeOnPooledThread {
            if (!project.isDisposed) {
                val wolf = WolfTheProblemSolver.getInstance(project)
                if (errors) wolf.reportProblemsFromExternalSource(file, this) else wolf.clearProblemsFromExternalSource(file, this)
            }
        }
    }

    /** The text editors show the new problems (the annotator runs again). */
    private fun restartHighlighting(file: VirtualFile) {
        ApplicationManager.getApplication().invokeLater({
            if (!file.isValid) {
                return@invokeLater
            }
            val psiFile = readAction { PsiManager.getInstance(project).findFile(file) }
            if (psiFile != null) {
                DaemonCodeAnalyzer.getInstance(project).restart(psiFile)
            }
        }, project.disposed)
    }

    companion object {
        fun get(project: Project): HsmProblems = project.service()
    }
}

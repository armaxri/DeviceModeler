package hsm.jetbrains.problems

import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.ExternalAnnotator
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiFile
import hsm.jetbrains.editor.HsmDiagramEditor
import hsm.jetbrains.lsp.HsmLanguageServerSupport
import hsm.jetbrains.model.ModelProblem
import hsm.jetbrains.model.ProblemSource
import hsm.jetbrains.model.ProjectPaths
import hsm.jetbrains.model.Severity

/**
 * The problems of a model in the text editor: those the page of the diagram editor reported for the current
 * text, else (saved file, no page) those of `hsm validate --json` ([HsmValidation]). Nothing if the language server
 * runs for the text editor (LSP4IJ, [HsmLanguageServerSupport]): it reports the problems itself.
 */
class HsmExternalAnnotator : ExternalAnnotator<HsmExternalAnnotator.Info, HsmExternalAnnotator.Result>(), DumbAware {

    data class Info(val project: Project, val file: VirtualFile, val textLength: Int, val unsaved: Boolean)

    data class Result(val source: ProblemSource, val problems: List<ModelProblem>)

    override fun collectInformation(file: PsiFile, editor: Editor, hasErrors: Boolean): Info? = collect(file, editor.document)

    override fun collectInformation(file: PsiFile): Info? = file.viewProvider.document?.let { collect(file, it) }

    private fun collect(file: PsiFile, document: Document): Info? {
        val virtualFile = file.virtualFile ?: return null
        if (!ProjectPaths.isModel(virtualFile.name) || HsmLanguageServerSupport.active()) {
            // the language server (LSP4IJ) reports the problems of the text
            return null
        }
        return Info(file.project, virtualFile, document.textLength, FileDocumentManager.getInstance().isDocumentUnsaved(document))
    }

    override fun doAnnotate(info: Info): Result? {
        val stored = HsmProblems.get(info.project).get(info.file)
        if (stored != null && stored.source == ProblemSource.PAGE && stored.textLength == info.textLength) {
            return Result(stored.source, stored.problems)
        }
        if (info.unsaved || HsmDiagramEditor.hasOpenPage(info.file)) {
            // the page reports the problems of the current text
            return null
        }
        if (stored != null && stored.source == ProblemSource.CLI && stored.fileStamp == info.file.modificationStamp) {
            return Result(stored.source, stored.problems)
        }
        val problems = HsmValidation.get(info.project).validateNow(info.file) ?: return null
        return Result(ProblemSource.CLI, problems)
    }

    override fun apply(file: PsiFile, result: Result?, holder: AnnotationHolder) {
        val document = file.viewProvider.document ?: return
        for (problem in result?.problems.orEmpty()) {
            val range = range(problem, result!!.source, document) ?: continue
            val severity = when (problem.severity) {
                Severity.ERROR -> HighlightSeverity.ERROR
                Severity.WARNING -> HighlightSeverity.WARNING
                Severity.INFO -> HighlightSeverity.WEAK_WARNING
            }
            holder.newAnnotation(severity, problem.message).range(range).create()
        }
    }

    companion object {
        /** The range of a problem in the document (page: offsets in the same text; command line: lines and columns of the file). */
        fun range(problem: ModelProblem, source: ProblemSource, document: Document): TextRange? {
            val length = document.textLength
            var start: Int
            var end: Int
            if (source == ProblemSource.PAGE && problem.offset >= 0) {
                start = problem.offset
                end = maxOf(problem.end, problem.offset)
            } else if (problem.line > 0) {
                start = offset(document, problem.line, problem.column) ?: return null
                end = if (problem.endLine > 0) offset(document, problem.endLine, problem.endColumn) ?: start else start
            } else {
                // a problem of the file without a position
                start = 0
                end = 0
            }
            start = start.coerceIn(0, length)
            end = end.coerceIn(start, length)
            if (start == end) {
                val text = document.immutableCharSequence
                if (end < length && text[end] != '\n') {
                    end++
                } else if (start > 0 && text[start - 1] != '\n') {
                    start--
                }
            }
            return TextRange(start, end)
        }

        private fun offset(document: Document, line: Int, column: Int): Int? {
            if (line < 1 || line > document.lineCount) {
                return null
            }
            val lineStart = document.getLineStartOffset(line - 1)
            return minOf(lineStart + maxOf(column - 1, 0), document.getLineEndOffset(line - 1))
        }
    }
}

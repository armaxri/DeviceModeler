package hsm.jetbrains.lang

import com.intellij.lang.Language
import com.intellij.openapi.fileTypes.LanguageFileType
import com.intellij.openapi.util.IconLoader
import javax.swing.Icon

object HsmIcons {
    @JvmField
    val FILE: Icon = IconLoader.getIcon("/icons/hsm.svg", HsmIcons::class.java)
}

/** The state machine language (`.hsm`). */
object HsmLanguage : Language("HSM") {
    private fun readResolve(): Any = HsmLanguage
    override fun getDisplayName(): String = "HSM"
}

/** The unit tests of state machines (`.hsmtest`). */
object HsmTestLanguage : Language("HSMTest") {
    private fun readResolve(): Any = HsmTestLanguage
    override fun getDisplayName(): String = "HSM Test"
}

object HsmFileType : LanguageFileType(HsmLanguage) {
    override fun getName(): String = "HSM"
    override fun getDescription(): String = "Hierarchical state machine"
    override fun getDefaultExtension(): String = "hsm"
    override fun getIcon(): Icon = HsmIcons.FILE
}

object HsmTestFileType : LanguageFileType(HsmTestLanguage) {
    override fun getName(): String = "HSM Test"
    override fun getDescription(): String = "Unit test of hierarchical state machines"
    override fun getDefaultExtension(): String = "hsmtest"
    override fun getIcon(): Icon = HsmIcons.FILE
}

package devm.jetbrains.settings

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

/** Settings of the plugin (application level, `devm.xml`): *Settings > Tools > Device Modeler*. */
@Service(Service.Level.APP)
@State(name = "DevmSettings", storages = [Storage("devm.xml")])
class DevmSettings : SimplePersistentStateComponent<DevmSettings.Options>(Options()) {

    class Options : BaseState() {
        /** Path of the `devm` executable; empty: the bundled one, else `devm` in the PATH. */
        var executable by string("")

        /** Validate the saved models (and their importers) with `devm validate` (closed files). */
        var validateOnSave by property(true)

        /** Output directory of *Generate C++* relative to the model; `${project}`: the project; empty: the model's folder. */
        var cppOutputDirectory by string("")

        /** Use the namespace of the model (otherwise [cppNamespace]). */
        var cppModelNamespace by property(true)

        /** Namespace of the generated class (`a::b`; empty: the global namespace). */
        var cppNamespace by string("")

        /** C++ standard: `17` or `11`. */
        var cppStandard by string("17")

        /** Settings of the page (theme, layout direction, …) as JSON, stored by the page. */
        var pageSettings by string("")
    }

    /** The C++ settings for the page (`HostCppSettings` of host.ts). */
    fun cppSettings(): Map<String, Any?> = linkedMapOf(
        "outputDirectory" to (state.cppOutputDirectory ?: ""),
        // absent: the namespace of the model
        "namespace" to (if (state.cppModelNamespace) null else state.cppNamespace ?: ""),
        "standard" to (if (state.cppStandard == "11") "11" else "17"),
    )

    companion object {
        fun get(): DevmSettings = service()
    }
}

package hsm.jetbrains

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import hsm.jetbrains.settings.HsmConfigurable

/** Balloons of the plugin (notification group *HSM Modeler*). */
object HsmNotifications {

    private const val GROUP = "HSM Modeler"

    fun notify(project: Project?, message: String, type: NotificationType = NotificationType.INFORMATION) {
        NotificationGroupManager.getInstance().getNotificationGroup(GROUP).createNotification(message, type).notify(project)
    }

    /** A notification with an action opening the settings of the plugin. */
    fun notifyWithSettings(project: Project?, message: String, type: NotificationType = NotificationType.WARNING) {
        NotificationGroupManager.getInstance().getNotificationGroup(GROUP).createNotification(message, type)
            .addAction(NotificationAction.createSimpleExpiring("Configure…") {
                ShowSettingsUtil.getInstance().showSettingsDialog(project, HsmConfigurable::class.java)
            })
            .notify(project)
    }
}

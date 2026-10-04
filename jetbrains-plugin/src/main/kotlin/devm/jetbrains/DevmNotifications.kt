package devm.jetbrains

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import devm.jetbrains.settings.DevmConfigurable

/** Balloons of the plugin (notification group *Device Modeler*). */
object DevmNotifications {

    private const val GROUP = "Device Modeler"

    fun notify(project: Project?, message: String, type: NotificationType = NotificationType.INFORMATION) {
        NotificationGroupManager.getInstance().getNotificationGroup(GROUP).createNotification(message, type).notify(project)
    }

    /** A notification with an action opening the settings of the plugin. */
    fun notifyWithSettings(project: Project?, message: String, type: NotificationType = NotificationType.WARNING) {
        NotificationGroupManager.getInstance().getNotificationGroup(GROUP).createNotification(message, type)
            .addAction(NotificationAction.createSimpleExpiring("Configure…") {
                ShowSettingsUtil.getInstance().showSettingsDialog(project, DevmConfigurable::class.java)
            })
            .notify(project)
    }
}

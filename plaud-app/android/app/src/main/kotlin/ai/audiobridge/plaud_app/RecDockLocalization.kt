package ai.audiobridge.plaud_app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import java.util.Locale

/** Uses the same non-secret preference as the Flutter interface, including in services. */
object RecDockLocalization {
    private fun preferences(context: Context) = context.getSharedPreferences("recdock_ui", 0)
    fun language(context: Context): String =
        if (preferences(context).getString("language", "en") == "zh-CN") "zh-CN" else "en"
    fun select(context: Context, language: String) {
        require(language in listOf("en", "zh-CN"))
        check(preferences(context).edit().putString("language", language).commit())
        updateChannels(context)
        TranscriptionService.current?.refreshNotification()
    }
    fun text(context: Context, id: Int): String {
        val configuration = Configuration(context.resources.configuration)
        configuration.setLocale(Locale.forLanguageTag(language(context)))
        return context.createConfigurationContext(configuration).getString(id)
    }
    fun updateChannels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("transcription-results", text(context, R.string.transcription_results_channel), NotificationManager.IMPORTANCE_DEFAULT))
        manager.createNotificationChannel(NotificationChannel("transcription-work", text(context, R.string.transcription_work_channel), NotificationManager.IMPORTANCE_LOW))
    }
}

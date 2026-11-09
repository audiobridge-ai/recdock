package ai.audiobridge.plaud_app

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

class MainActivity: FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val vault = SecretVault(this)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "ai.audiobridge.recdock/secrets")
            .setMethodCallHandler { call, result ->
                try {
                    val key = call.argument<String>("key") ?: error("Missing key")
                    require(Regex("^[a-z0-9_]{1,80}$").matches(key))
                    when (call.method) {
                        "read" -> result.success(vault.read(key))
                        "write" -> { vault.write(key, call.argument<String>("value") ?: error("Missing value")); result.success(null) }
                        "delete" -> { vault.delete(key); result.success(null) }
                        else -> result.notImplemented()
                    }
                } catch (_: Exception) { result.error("SECURE_STORAGE_FAILED", "安全存储暂不可用，请重试", null) }
            }
        TranscriptionQueue.initialize(this)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "ai.audiobridge.recdock/background")
            .setMethodCallHandler { call, result ->
                try {
                    fun startQueue() {
                        if (TranscriptionQueue.hasWork()) {
                            val intent = Intent(this, TranscriptionService::class.java)
                            if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
                        }
                    }
                    when (call.method) {
                        "activate" -> { TranscriptionQueue.activate(call.argument<String>("namespace") ?: ""); result.success(null) }
                        "enqueue" -> { TranscriptionQueue.enqueue(org.json.JSONObject(call.argument<String>("json")!!)); startQueue(); result.success(null) }
                        "snapshot" -> { startQueue(); result.success(TranscriptionQueue.snapshot()) }
                        "cancel", "ack" -> { TranscriptionQueue.remove(call.argument<String>("id")!!, call.method == "ack"); result.success(null) }
                        "foreground" -> { if (call.argument<Boolean>("value") == true) startQueue(); result.success(null) }
                        "notifications" -> {
                            if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 731)
                            }
                            result.success(android.os.Build.VERSION.SDK_INT < 33 || checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED)
                        }
                        else -> result.notImplemented()
                    }
                } catch (_: Exception) { result.error("BACKGROUND_TASK_FAILED", "后台任务暂不可用，原文件和任务记录已保留", null) }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "ai.audiobridge.recdock/platform")
            .setMethodCallHandler { call, result ->
                if (call.method == "shareTranscript") {
                    try {
                        val file = File(call.argument<String>("path") ?: error("Missing path")).canonicalFile
                        val directory = File(cacheDir, "transcript-exports").canonicalFile
                        require(file.parentFile == directory && file.isFile)
                        require(Regex("^transcript-[a-f0-9]+\\.(md|txt|json|srt|vtt)$").matches(file.name))
                        val mime = call.argument<String>("mime") ?: "text/plain"
                        require(mime in listOf("text/plain", "text/markdown", "application/json", "text/vtt", "application/x-subrip"))
                        val uri = FileProvider.getUriForFile(this, "$packageName.exports", file)
                        val intent = Intent(Intent.ACTION_SEND).apply {
                            type = mime
                            putExtra(Intent.EXTRA_STREAM, uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            clipData = android.content.ClipData.newRawUri("转写全文", uri)
                        }
                        startActivity(Intent.createChooser(intent, "分享转写全文"))
                        result.success(null)
                    } catch (_: Exception) { result.error("EXPORT_SHARE_FAILED", "无法打开系统分享，请重试", null) }
                }
                else if (call.method == "sdkInt") result.success(android.os.Build.VERSION.SDK_INT)
                else if (call.method == "freeDiskBytes") result.success(filesDir.usableSpace)
                else result.notImplemented()
            }
    }
}

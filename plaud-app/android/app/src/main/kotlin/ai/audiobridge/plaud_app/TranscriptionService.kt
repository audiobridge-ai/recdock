package ai.audiobridge.plaud_app

import android.app.*
import android.content.*
import android.os.*
import androidx.core.app.NotificationCompat
import org.json.*
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/** Native durable executor. No Flutter isolate is required while the service runs. */
object TranscriptionQueue {
    private lateinit var app: Context
    private val jobs = linkedMapOf<String, JSONObject>()
    private var namespace = ""
    private val corruptIds = mutableSetOf<String>()
    private var connection: HttpURLConnection? = null
    private var connectionJob: String? = null
    private val terminal = setOf("syncing", "error", "uncertain", "cancelled", "interrupted")
    private fun root() = File(app.filesDir, "transcription-queue-v1").apply { mkdirs() }
    private fun secret(id: String) = "bg_" + MessageDigest.getInstance("SHA-256").digest(id.toByteArray()).joinToString("") { "%02x".format(it) }
    @Synchronized fun initialize(context: Context) {
        if (::app.isInitialized) return
        app = context.applicationContext
        namespace = app.getSharedPreferences("transcription_queue", 0).getString("namespace", "") ?: ""
        root().listFiles()?.filter { it.extension == "json" }?.sortedBy { it.name }?.forEach { f ->
            val j = try {
                JSONObject(f.readText()).also { require(it.getString("id") == f.nameWithoutExtension && it.has("recordingId") && it.has("namespace") && it.has("state")) }
            } catch (_: Exception) { corruptIds.add(f.nameWithoutExtension); return@forEach }
            if (j.optString("state") == "submitting") j.put("state", if (j.isNull("remoteId")) "uncertain" else "queued").put("notice", "提交记录已恢复，不会自动重复提交")
            if (j.optString("state") == "uploading") j.put("state", "waiting_upload")
            jobs[j.getString("id")] = j
            save(j)
        }
    }
    private fun save(j: JSONObject) {
        val file = File(root(), j.getString("id") + ".json")
        val temp = File(root(), file.name + ".tmp")
        java.io.FileOutputStream(temp).use { it.write(j.toString().toByteArray()); it.fd.sync() }
        check(temp.renameTo(file))
    }
    @Synchronized fun activate(value: String) {
        if (namespace != value) {
            connection?.disconnect()
            connectionJob?.let { id -> jobs[id]?.let { j ->
                when (j.optString("state")) {
                    "uploading" -> j.put("state", "waiting_upload")
                    "submitting" -> j.put("state", "uncertain").put("notice", "账号或 Key 已切换，请核对原任务")
                }
                save(j)
            } }
        }
        namespace = value
        check(app.getSharedPreferences("transcription_queue", 0).edit().putString("namespace", value).commit())
    }
    @Synchronized fun enqueue(input: JSONObject) {
        val id = input.getString("id")
        require(id.matches(Regex("^job_[a-f0-9]+$")))
        require(input.getString("namespace") == namespace && namespace.isNotEmpty())
        require(id !in corruptIds)
        if (jobs.containsKey(id)) return
        val path = File(input.getString("audioPath")).canonicalFile
        require(path.path.startsWith(File(app.applicationInfo.dataDir).canonicalPath + "/") && path.isFile)
        require(path.length() in 1..1073741824)
        val key = input.getString("apiKey")
        require(key.matches(Regex("^[A-Za-z0-9_-]{16,256}$")))
        require(input.getString("region") in listOf("us", "eu"))
        val base = input.optString("testBase")
        require(base.isEmpty() || (BuildConfig.DEBUG && URL(base).let { it.protocol == "http" && it.host in listOf("127.0.0.1", "localhost", "10.0.2.2") }))
        SecretVault(app).write(secret(id), key)
        input.remove("apiKey")
        input.put("state", "waiting_upload").put("audioPath", path.path)
        jobs[id] = input
        save(input)
    }
    @Synchronized fun snapshot(): String {
        val result = JSONArray()
        jobs.values.filter { it.optString("namespace") == namespace }.forEach { j ->
            val copy = JSONObject(j.toString())
            val f = File(root(), j.getString("id") + ".result")
            if (j.optString("state") == "syncing" && f.isFile) copy.put("result", JSONObject(f.readText()))
            copy.remove("audioPath")
            result.put(copy)
        }
        return result.toString()
    }
    @Synchronized fun remove(id: String, ack: Boolean) {
        val j = jobs[id] ?: return
        require(j.optString("namespace") == namespace)
        if (ack) require(j.optString("state") in terminal || j.optString("state") in listOf("queued", "processing")) else {
            require(j.optString("state") in listOf("waiting_upload", "uploading", "uploaded"))
            j.put("state", "cancelled")
            if (connectionJob == id) connection?.disconnect()
        }
        if (ack) { jobs.remove(id); File(root(), "$id.json").delete(); File(root(), "$id.result").delete() }
        else save(j)
        SecretVault(app).delete(secret(id))
    }
    @Synchronized fun hasWork(): Boolean {
        val own = jobs.values.filter { it.optString("namespace") == namespace }
        val cloud = own.count { it.optString("state") in listOf("queued", "processing", "uncertain", "submitting") }
        return own.any { it.optString("state") in listOf("queued", "processing", "uploading", "submitting") } ||
            (cloud < 2 && own.any { it.optString("state") in listOf("waiting_upload", "uploaded") })
    }
    @Synchronized fun suspendNetwork() {
        connectionJob?.let { id -> jobs[id]?.let { j ->
            if (j.optString("state") == "submitting") j.put("state", "uncertain").put("notice", "系统已暂停后台执行，提交结果待核对")
            if (j.optString("state") == "uploading") j.put("state", "interrupted").put("notice", "系统已暂停后台上传，可返回后重试")
            save(j)
        } }
        connection?.disconnect()
    }
    private fun base(j: JSONObject): String {
        val test = j.optString("testBase")
        if (test.isNotEmpty()) {
            require(BuildConfig.DEBUG && URL(test).let { it.protocol == "http" && it.host in listOf("127.0.0.1", "localhost", "10.0.2.2") })
            return test
        }
        return if (j.getString("region") == "eu") "https://api.eu.assemblyai.com" else "https://api.assemblyai.com"
    }
    private fun validUpload(url: String): Boolean = try {
        val u = URL(url)
        u.protocol == "https" && u.host in listOf("cdn.assemblyai.com", "cdn.eu.assemblyai.com") && u.port == -1 && u.userInfo == null && u.ref == null && u.path.startsWith("/upload/")
    } catch (_: Exception) { false }
    private class Reply(val status: Int, val json: JSONObject?, val retry: Long)
    private fun request(j: JSONObject, path: String, method: String = "GET", file: File? = null, body: ByteArray? = null): Reply {
        val id = j.getString("id")
        val key = synchronized(this) { SecretVault(app).read(secret(id)) ?: error("KEY_MISSING") }
        val c = URL(base(j) + path).openConnection() as HttpURLConnection
        synchronized(this) {
            require(j.optString("namespace") == namespace && j.optString("state") != "cancelled")
            connection = c; connectionJob = id
        }
        try {
            c.instanceFollowRedirects = false
            c.connectTimeout = 20000; c.readTimeout = 45000; c.requestMethod = method
            c.setRequestProperty("Authorization", key)
            c.setRequestProperty("Accept", "application/json")
            if (method == "POST") {
                c.doOutput = true
                c.setRequestProperty("Content-Type", if (file != null) "application/octet-stream" else "application/json")
                c.setFixedLengthStreamingMode(file?.length() ?: body!!.size.toLong())
                c.outputStream.use { out ->
                    if (file != null) file.inputStream().use { input ->
                        val buffer = ByteArray(65536); var sent = 0L; var last = 0L
                        while (true) {
                            val n = input.read(buffer); if (n < 0) break
                            synchronized(this) { require(j.optString("namespace") == namespace && j.optString("state") == "uploading") }
                            out.write(buffer, 0, n); sent += n
                            if (System.currentTimeMillis() - last > 500) {
                                synchronized(this) { j.put("progress", sent.toDouble() / file.length()); save(j) }
                                last = System.currentTimeMillis()
                            }
                        }
                    } else out.write(body!!)
                }
            }
            val status = c.responseCode
            val input = if (status in 200..299) c.inputStream else c.errorStream
            val bytes = input?.use { stream ->
                val out = java.io.ByteArrayOutputStream(); val buffer = ByteArray(65536)
                while (true) { val n = stream.read(buffer); if (n < 0) break; require(out.size() + n <= 33554432); out.write(buffer, 0, n) }
                out.toByteArray()
            } ?: ByteArray(0)
            val json = try { JSONObject(String(bytes, Charsets.UTF_8)) } catch (_: Exception) { null }
            val retry = (c.getHeaderField("Retry-After")?.toLongOrNull() ?: 30L).coerceIn(5L, 900L)
            return Reply(status, json, retry)
        } finally { synchronized(this) { if (connection === c) { connection = null; connectionJob = null } }; c.disconnect() }
    }
    @Synchronized private fun allowed(j: JSONObject) = j.optString("namespace") == namespace && jobs[j.optString("id")] === j && j.optString("state") != "cancelled"
    @Synchronized private fun accept(j: JSONObject, data: JSONObject) {
        require(data.optString("id") == j.optString("remoteId"))
        require(data.isNull("audio_url") || data.optString("audio_url") == j.optString("uploadUrl"))
        val status = data.getString("status")
        require(status in listOf("queued", "processing", "completed", "error"))
        if (status == "completed") {
            val target = File(root(), j.getString("id") + ".result")
            val temp = File(root(), target.name + ".tmp")
            java.io.FileOutputStream(temp).use { it.write(data.toString().toByteArray()); it.fd.sync() }
            check(temp.renameTo(target)); j.put("state", "syncing")
        } else j.put("state", status)
        j.put("retryAt", System.currentTimeMillis() + 15000).remove("notice")
        save(j)
        if (status in listOf("completed", "error")) notifyDone(j, status == "completed")
    }
    private fun notifyDone(j: JSONObject, success: Boolean) {
        val manager = app.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel("transcription-results", "转写完成提醒", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(app, 0, Intent(app, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(app, "transcription-results").setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setContentTitle(if (success) "转写已完成" else "转写需要处理").setContentText("打开 RecDock 查看任务状态")
            .setAutoCancel(true).setContentIntent(open).build()
        try { manager.notify(j.getString("id").hashCode(), n) } catch (_: SecurityException) { }
    }
    /** One turn performs only one network request, serializing uploads and bounding cloud slots. */
    fun tick() {
        val j: JSONObject = synchronized(this) {
            val own = jobs.values.filter { it.optString("namespace") == namespace }.sortedBy { it.optLong("createdAt") }
            val due = own.firstOrNull { it.optString("state") in listOf("queued", "processing") && it.optLong("retryAt") <= System.currentTimeMillis() }
            val slots = own.count { it.optString("state") in listOf("queued", "processing", "submitting", "uncertain") }
            due ?: own.firstOrNull { it.optString("state") in listOf("uploaded", "waiting_upload") && slots < 2 } ?: return
        }
        try {
            when (j.getString("state")) {
                "waiting_upload" -> {
                    synchronized(this) { if (!allowed(j)) return; j.put("state", "uploading").put("progress", 0); save(j) }
                    val audioFile = File(j.getString("audioPath"))
                    val actualHash = MessageDigest.getInstance("SHA-256")
                    audioFile.inputStream().use { stream -> val b = ByteArray(65536); while (true) { val n = stream.read(b); if (n < 0) break; actualHash.update(b, 0, n) } }
                    require(actualHash.digest().joinToString("") { "%02x".format(it) } == j.getString("audioSha256"))
                    val r = request(j, "/v2/upload", "POST", File(j.getString("audioPath")))
                    synchronized(this) {
                        if (!allowed(j)) return
                        if (r.status == 429) j.put("retryAt", System.currentTimeMillis() + r.retry * 1000)
                        require(r.status in 200..299 && validUpload(r.json?.optString("upload_url") ?: ""))
                        j.put("uploadUrl", r.json!!.getString("upload_url")).put("state", "uploaded").put("progress", 1); save(j)
                    }
                }
                "uploaded" -> {
                    synchronized(this) { j.put("state", "submitting"); save(j) }
                    val body = JSONObject().put("audio_url", j.getString("uploadUrl")).put("speech_models", j.getJSONArray("models"))
                        .put("speaker_labels", true).put("punctuate", true).put("format_text", true)
                    if (j.getString("language") == "auto") body.put("language_detection", true) else body.put("language_code", j.getString("language"))
                    val r = request(j, "/v2/transcript", "POST", body = body.toString().toByteArray())
                    synchronized(this) {
                        if (!allowed(j)) return
                        val id = r.json?.optString("id") ?: ""
                        if (r.status !in 200..299 || !id.matches(Regex("^[a-zA-Z0-9_-]{1,160}$"))) {
                            j.put("state", if (r.status in listOf(400, 401, 403, 404, 413, 415, 422, 429)) "error" else "uncertain")
                            j.put("notice", "提交未能确认，请核对 AssemblyAI 控制台后处理，避免重复计费")
                            if (r.status == 429) j.put("retryAt", System.currentTimeMillis() + r.retry * 1000)
                            save(j); return
                        }
                        j.put("remoteId", id); save(j); accept(j, r.json!!)
                    }
                }
                "queued", "processing" -> {
                    val r = request(j, "/v2/transcript/" + j.getString("remoteId"))
                    synchronized(this) {
                        if (!allowed(j)) return
                        if (r.status in 200..299 && r.json != null) accept(j, r.json)
                        else { j.put("notice", "查询暂未完成，任务 ID 已保留").put("retryAt", System.currentTimeMillis() + r.retry * 1000); save(j) }
                    }
                }
            }
        } catch (_: Exception) {
            synchronized(this) {
                if (!allowed(j)) return
                val state = j.optString("state")
                if (state == "submitting") j.put("state", "uncertain").put("notice", "提交结果待确认，请核对云端任务，避免重复计费")
                else if (state == "uploading") j.put("state", "interrupted").put("notice", "上传中断，文件保留，可再次确认后重试")
                else j.put("notice", "网络或结果暂不可用，任务 ID 已保留").put("retryAt", System.currentTimeMillis() + 60000)
                save(j)
            }
        }
    }
}

class TranscriptionService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var stopped = false
    private var started = false
    override fun onBind(intent: Intent?) = null
    override fun onCreate() {
        super.onCreate(); TranscriptionQueue.initialize(this)
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel("transcription-work", "后台转写任务", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        startForeground(731, NotificationCompat.Builder(this, "transcription-work").setSmallIcon(android.R.drawable.ic_menu_upload)
            .setContentTitle("RecDock 转写任务进行中").setContentText("上传或同步云端进度，点击查看任务中心").setContentIntent(open).setOngoing(true).build())
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!started) { started = true; executor.execute {
            try { while (!stopped && TranscriptionQueue.hasWork()) { val wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RecDock:transcription")
                wake.acquire(20 * 60 * 1000L)
                try { TranscriptionQueue.tick() } finally { if (wake.isHeld) wake.release() }
                Thread.sleep(5000) } }
            finally { stopSelf() }
        } }
        return START_NOT_STICKY
    }
    override fun onTimeout(startId: Int, fgsType: Int) { stopped = true; stopSelf() }
    override fun onDestroy() { stopped = true; TranscriptionQueue.suspendNetwork(); executor.shutdownNow(); super.onDestroy() }
}

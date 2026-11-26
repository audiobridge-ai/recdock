// English translations for authored RecDock messages. Chinese is the source locale.
const englishMessages = <String, String>{
  " · {0} 秒": " · {0} s",
  " · 充电中": " · Charging",
  " · 当前": " · Current",
  "AssemblyAI Key 无效、项目不匹配或余额/权限不足，请检查设置":
      "The AssemblyAI key is invalid, belongs to a different project, or lacks credits or permission. Check your settings.",
  "AssemblyAI · {0} · 已核对 {1}/{2} 段":
      "AssemblyAI · {0} · {1}/{2} segments reviewed",
  "AssemblyAI 任务 ID": "AssemblyAI task ID",
  "AssemblyAI 响应无法识别，任务信息已保留":
      "The AssemblyAI response could not be read. Task details have been retained.",
  "AssemblyAI 暂时限流，请稍后重试":
      "AssemblyAI is rate limiting requests. Try again later.",
  "AssemblyAI 服务暂时不可用，请稍后重试":
      "AssemblyAI is temporarily unavailable. Try again later.",
  "AssemblyAI 未接受音频或参数，请检查格式、语言和设置":
      "AssemblyAI rejected the audio or parameters. Check the format, language, and settings.",
  "AssemblyAI 未能完成此录音。请在控制台检查任务详情后决定是否重新转写":
      "AssemblyAI could not transcribe this recording. Check the task in the console before starting again.",
  "AssemblyAI 请求超时，请检查网络":
      "The AssemblyAI request timed out. Check your connection.",
  "AssemblyAI 转写设置": "AssemblyAI transcription settings",
  "AssemblyAI 返回的上传地址无法验证":
      "The upload URL returned by AssemblyAI could not be verified.",
  "Ogg 容器头无效": "Invalid Ogg container header.",
  "Ogg 文件尚未完整结束": "The Ogg file has not finished writing.",
  "Ogg 最后一包不完整": "The final Ogg packet is incomplete.",
  "Ogg 校验失败，原件已保留":
      "Ogg verification failed. The original file has been retained.",
  "Ogg 页面不连续": "Ogg pages are not continuous.",
  "Ogg 首页面无效": "Invalid first Ogg page.",
  "Opus 数据包格式无法确认": "The Opus packet format could not be verified.",
  "Opus 时间范围无效": "Invalid Opus time range.",
  "Opus 标签头缺失": "The Opus tags header is missing.",
  "PLAUD 录音 {0}": "PLAUD recording {0}",
  "PLAUD 拒绝访问，请检查账号授权或网络":
      "PLAUD denied access. Check account authorization and your connection.",
  "PLAUD 未接受请求，请检查账号后重试":
      "PLAUD rejected the request. Check your account and try again.",
  "PLAUD 未返回完整续期凭据":
      "PLAUD did not return complete session renewal credentials.",
  "PLAUD 未返回账号身份": "PLAUD did not return an account identity.",
  "PLAUD 设备": "PLAUD device",
  "PLAUD 请求未成功，请稍后重试": "The PLAUD request failed. Try again later.",
  "PLAUD 账号": "PLAUD account",
  "PLAUD 返回的数据无法识别": "The PLAUD response could not be read.",
  "RecDock 是独立客户端，与 PLAUD 官方无关联。":
      "RecDock is an independent client and is not affiliated with PLAUD.",
  "{0} / {1} 字节": "{0} / {1} bytes",
  "{0} 台绑定设备": "{0} linked devices",
  "上传中断，文件保留，可再次确认后重试":
      "Upload interrupted. The file has been retained. Confirm again to retry.",
  "上传中音频发生变化，请重新选择": "The audio changed during upload. Select the file again.",
  "上传已中断": "Upload interrupted",
  "上传已中断，重新开始需要再次确认": "Upload interrupted. Confirm again to restart.",
  "上传并开始转写": "Upload and transcribe",
  "上传并开始转写？": "Upload and transcribe?",
  "上传未完成，原文件已保留，可再次确认后重试":
      "Upload failed. The original file has been retained. Confirm again to retry.",
  "下载": "Download",
  "下载已暂停": "Download paused",
  "下载已暂停，已接收部分保留": "Download paused. Received data has been retained.",
  "个人工作区授权不完整": "Personal workspace authorization is incomplete.",
  "个人工作区标识无效": "Invalid personal workspace ID.",
  "中文": "Chinese",
  "云端加密响应校验失败": "The encrypted cloud response could not be verified.",
  "云端响应超过允许大小": "The cloud response exceeds the size limit.",
  "云端排队中": "Queued in the cloud",
  "云端转写中": "Transcribing in the cloud",
  "人工核对：{0}/{1} 段。": "Human review: {0}/{1} paragraphs.",
  "人物名称需要 1–100 个字符": "Speaker names must contain 1–100 characters.",
  "仅影响界面和导出说明，不改变录音语言或转写内容。":
      "Changes interface and export labels only. Recording language and transcript content stay unchanged.",
  "仅结束本机跟踪，云端任务未删除或取消":
      "Local tracking ended. The cloud task has not been deleted or cancelled.",
  "任务 ID：{0}": "Task ID: {0}",
  "任务响应无效": "Invalid task response.",
  "任务响应无效，已有任务 ID 保留":
      "Invalid task response. The existing task ID has been retained.",
  "任务尚不能继续提交": "This task cannot be submitted yet.",
  "任务无法启动，原文件已保留":
      "The task could not be started. The original file has been retained.",
  "任务暂时无法刷新，记录已保留": "Tasks could not be refreshed. Records have been retained.",
  "任务暂时无法同步，原文件和后台日志已保留":
      "Tasks could not be synced. Original files and background logs have been retained.",
  "任务状态已变化，请刷新后查看；已提交任务继续在云端执行":
      "The task status changed. Refresh to check it. Submitted tasks continue in the cloud.",
  "你的录音，保存在本机": "Your recordings, stored locally",
  "使用你自己的 AssemblyAI API Key。录音由你主动选择上传，服务费用由该 Key 所属项目承担。Key 使用系统安全存储，与 PLAUD 登录凭据分开保存。":
      "Use your own AssemblyAI API key. Recordings are uploaded only when you choose to transcribe them. Charges apply to the project associated with your key. The key uses system secure storage, separate from your PLAUD credentials.",
  "使用设备已绑定的 PLAUD 账号登录。":
      "Sign in with the PLAUD account linked to your device.",
  "保存": "Save",
  "保存新版本": "Save new version",
  "保存的登录态无效，请重新登录": "The saved session is invalid. Sign in again.",
  "保存设置": "Save settings",
  "保持设备唤醒并靠近手机。如已连接官方 App，请先断开。":
      "Keep your device awake and near your phone. Disconnect it from the official app first.",
  "修改人物名称": "Rename speaker",
  "修改文字后旧词级时间不再沿用；段落时间用于定位原音。":
      "Editing text removes the previous word timings. Segment times still locate the original audio.",
  "修改标题": "Rename",
  "停止扫描": "Stop scanning",
  "全文长度无效": "Invalid transcript length.",
  "关联": "Link",
  "关联已有任务": "Link existing task",
  "分享 {0} 全文": "Share full {0} transcript",
  "分享文件无效": "Invalid file for sharing.",
  "刷新任务": "Refresh tasks",
  "刷新录音目录": "Refresh recording list",
  "刷新状态": "Refresh status",
  "刷新设备列表": "Refresh devices",
  "十六进制格式无效": "Invalid hexadecimal format",
  "协议字段应为无符号 32 位整数": "Protocol fields must be unsigned 32-bit integers.",
  "历史版本": "Version history",
  "原件已保存": "Original saved",
  "原件已保存，暂时无法播放": "The original file is saved but cannot be played yet.",
  "原件已保存，音频暂未恢复为可播放格式":
      "The original file is saved. A playable copy is not yet available.",
  "原始音频不是完整的单声道 Opus 帧":
      "The original audio does not contain complete mono Opus frames.",
  "原音频仍会保留，可以从回收站恢复。":
      "The original audio will be retained. You can restore it from Trash.",
  "原音频缺失或大小不符": "The original audio is missing or its size does not match.",
  "取消": "Cancel",
  "取消排队": "Remove from queue",
  "取消本机上传": "Cancel local upload",
  "取消本机任务": "Cancel local task",
  "可用 {0} / {1}": "Available: {0} / {1}",
  "可用容量大于总容量": "Available storage exceeds total storage.",
  "可能重叠": "Possible overlap",
  "后台上传已停止，返回后可再次确认重试":
      "Background upload stopped. Return to the app and confirm again to retry.",
  "后台任务暂不可用，任务和原文件已保留":
      "Background tasks are unavailable. Tasks and original files have been retained.",
  "后台任务暂不可用，原文件和任务记录已保留":
      "Background tasks are unavailable. Original files and task records have been retained.",
  "后台任务暂时无法同步，日志和原文件已保留，请稍后刷新":
      "Background tasks could not be synced. Logs and original files have been retained. Refresh later.",
  "后台结果与原录音不匹配": "The background result does not match the original recording.",
  "命令编号无效": "Invalid command ID.",
  "回收站": "Trash",
  "回收站是空的": "Trash is empty",
  "在 AssemblyAI 控制台获取": "Get a key from the AssemblyAI console",
  "多音轨 Ogg 暂不支持此播放方式":
      "This playback method does not support multitrack Ogg audio.",
  "存储暂未获取": "Storage not available yet",
  "存储：未获取": "Storage: unavailable",
  "安全存储参数无效": "Invalid secure storage parameters.",
  "安全存储暂不可用，请重试": "Secure storage is unavailable. Try again.",
  "密码": "Password",
  "密码仅用于本次登录。登录凭据由系统安全存储保护；本机音频无需登录即可使用。":
      "Your password is used only for this sign-in. Session credentials are protected by system secure storage. Local audio is available without signing in.",
  "导入手机中的音频，随时播放和整理": "Import audio from your phone to play and organize it",
  "导入未完成，请检查文件和手机可用空间后重试":
      "Import failed. Check the file and available storage, then try again.",
  "导入音频": "Import audio",
  "导入音频不需要 PLAUD 账号。原文件保存在 App 专属目录，移入回收站后可以恢复。卸载 App 会清除本机资料。":
      "Import audio without a PLAUD account. Originals stay in the app's storage and can be restored from Trash. Uninstalling the app removes local data.",
  "导出 {0} 全文": "Export full {0} transcript",
  "导出全文": "Export full transcript",
  "导出转写全文": "Export full transcript",
  "将把“{0}”的完整可播放音频上传到 AssemblyAI {1}区域，开启讲话人区分。\n\n语言：{2}；模型：{3}。\n默认逐条上传，最多两条云端任务，可离开页面。iOS 后台查询可能延迟，返回 App 自动同步。\n\n费用由你的 API Key 所属项目承担，本机原件继续保留。关闭页面或暂停查询不会取消云端处理或计费。":
      "The complete playable audio of “{0}” will be uploaded to AssemblyAI in the {1} region, with speaker labels enabled.\n\nLanguage: {2}; models: {3}.\nUploads run one at a time, with at most two cloud tasks. You can leave this page. Background checks on iOS may be delayed; returning to the app syncs progress.\n\nCharges apply to the project associated with your API key. The original stays local. Leaving the page or pausing checks does not cancel cloud processing or charges.",
  "尚未在附近发现": "Not found nearby",
  "尚未确认支持的音频格式，原件已保留":
      "The audio format is not yet supported. The original file has been retained.",
  "工作区授权过期，请重试连接": "Workspace authorization expired. Try connecting again.",
  "已保存到本机": "Saved locally",
  "已取消本机任务": "Local task cancelled",
  "已听原音并核对此段": "I listened to the audio and reviewed this segment",
  "已在附近发现": "Found nearby",
  "已按设备固件兼容格式恢复音频":
      "Audio recovered using a format compatible with the device firmware.",
  "已有 Key，留空沿用；输入新 Key 将替换":
      "A key is saved. Leave blank to keep it, or enter a new key to replace it.",
  "已有更新版本，请重新打开后再保存": "A newer version exists. Reopen it before saving.",
  "已核对": "Reviewed",
  "已核对，结束跟踪": "Checked — end tracking",
  "已登录": "Signed in",
  "已结束本机跟踪": "Local tracking ended",
  "已连接": "Connected",
  "已配置 · {0}": "Configured · {0}",
  "当前 PLAUD 账号的转写配置": "Transcription settings for this PLAUD account",
  "当前为离线模式，可查看已保存的本机录音":
      "You are offline. Saved local recordings remain available.",
  "当前任务无需关联": "This task does not need linking.",
  "当前离线模式仅可读取本机录音，请联网后刷新账号":
      "Offline mode supports local recordings only. Connect to the internet and refresh your account.",
  "当前设备无法播放此音频格式，原文件已保留":
      "This device cannot play this audio format. The original file has been retained.",
  "录音": "Recordings",
  "录音 ID：{0}": "Recording ID: {0}",
  "录音列表刷新失败，请重试": "Recordings could not be refreshed. Try again.",
  "录音声道信息无效": "Invalid recording channel information.",
  "录音已移入回收站或账号已改变": "The recording was moved to Trash or the account changed.",
  "录音库暂时无法读取，请重试": "The recording library could not be opened. Try again.",
  "录音数据响应类型或长度无效": "Invalid recording data response type or length",
  "录音数据存在缺口": "There is a gap in the recording data.",
  "录音数据载荷长度或偏移无效": "Invalid recording payload length or offset",
  "录音文件长度不完整": "The recording file is incomplete.",
  "录音暂停": "Recording paused",
  "录音状态响应过短": "The recording status response is too short.",
  "录音状态：{0}": "Recording: {0}",
  "录音目录不完整，请刷新": "The recording list is incomplete. Refresh it.",
  "录音目录包含重复编号": "The recording list contains duplicate IDs.",
  "录音目录发生变化，请刷新": "The recording list changed. Refresh it.",
  "录音目录条目冲突": "Conflicting entries in the recording list.",
  "录音目录读取超时，请刷新": "Loading recordings timed out. Refresh the list.",
  "录音索引无效": "Invalid recording index.",
  "录音结束数据缺少原因码": "Recording end message is missing its reason code",
  "录音编号无效": "Invalid recording ID.",
  "录音详情": "Recording details",
  "录音语言": "Recording language",
  "录音资产或账号范围无效": "Invalid recording assets or account scope.",
  "待核对": "Needs review",
  "待确认": "Unconfirmed",
  "德语": "German",
  "恢复为新版本": "Restore as new version",
  "恢复未完成，请重试": "Restore failed. Try again.",
  "恢复音频": "Recover audio",
  "扫描蓝牙需要位置权限和系统定位服务":
      "Bluetooth scanning requires location permission and location services.",
  "扫描附近设备": "Scan nearby devices",
  "把录音放在一起": "All your recordings in one place",
  "按顺序上传，每次上传 1 条，最多 2 条云端任务。可以离开页面或锁屏，已提交的转写继续在云端进行。\n\niOS 的后续查询与排队任务由系统安排，返回 App 会自动同步。完成提醒需要通知权限，提醒可能延迟。":
      "Uploads run one at a time, with at most two cloud tasks. You can leave this page or lock your phone; submitted transcriptions continue in the cloud.\n\niOS schedules background checks and queued tasks. Returning to the app syncs progress. Completion alerts require notification permission and may be delayed.",
  "推荐：3.5 Pro / Universal-2": "Recommended: 3.5 Pro / Universal-2",
  "提交可能已被云端接收，请关联已有任务 ID，避免重复计费":
      "The cloud may have accepted the submission. Link the existing task ID to avoid duplicate charges.",
  "提交未能确认，请核对 AssemblyAI 控制台后处理，避免重复计费":
      "The submission is unconfirmed. Check the AssemblyAI console to avoid duplicate charges.",
  "提交未能确认，请核对控制台，避免重复计费":
      "The submission is unconfirmed. Check the console to avoid duplicate charges.",
  "提交结果尚未确认。请从 AssemblyAI 控制台找到已有任务 ID 后关联，避免重复计费":
      "The submission is unconfirmed. Find and link the existing task ID in the AssemblyAI console to avoid duplicate charges.",
  "提交结果待确认": "Submission unconfirmed",
  "提交结果待确认，请核对云端任务，避免重复计费":
      "The submission is unconfirmed. Check the cloud task to avoid duplicate charges.",
  "提交记录已恢复，不会自动重复提交":
      "The submission record was restored. It will not be submitted again automatically.",
  "提供方：AssemblyAI · 语言：{0}": "Provider: AssemblyAI · Language: {0}",
  "搜索录音": "Search recordings",
  "搜索转写内容": "Search transcript",
  "播放": "Play",
  "播放中断，请重新打开录音": "Playback interrupted. Reopen the recording.",
  "操作未完成，请稍后重试": "The action failed. Try again later.",
  "操作未完成，请重试": "The action failed. Try again.",
  "数据处理区域": "Processing region",
  "文件下载范围无效": "Invalid file download range",
  "文字": "Text",
  "文字、时间与讲话人仍需人工核对；点击段落时间可回听。":
      "Review the text, timing, and speakers. Tap a timestamp to listen to the original audio.",
  "断开": "Disconnect",
  "新转写已保存到历史版本，当前保留了转写期间的校对版本":
      "The new transcript is saved in version history. Your edits made during transcription remain current.",
  "无法完成登录密码封装": "The sign-in password could not be prepared.",
  "无法打开系统分享，请重试": "Sharing could not be opened. Try again.",
  "无法获取系统蓝牙权限信息": "Bluetooth permission information is unavailable.",
  "无法解开设备材料，请核对账号与密钥":
      "Device credentials could not be decrypted. Check the account and keys.",
  "无法读取可用空间": "Available storage could not be read.",
  "无法读取所选文件，请重新选择": "The selected file could not be read. Select it again.",
  "无法连接 AssemblyAI，请检查网络后重试":
      "Cannot connect to AssemblyAI. Check your connection and try again.",
  "无法连接 PLAUD，请检查网络后重试":
      "Cannot connect to PLAUD. Check your connection and try again.",
  "日语": "Japanese",
  "时长：{0}": "Duration: {0}",
  "显示密码": "Show password",
  "暂停上传": "Pause upload",
  "暂停下载": "Pause download",
  "暂无目录条目，可点击刷新录音目录": "No recordings listed. Refresh the recording list.",
  "有 {0} 条录音暂时无法读取，文件已保留":
      "{0} recordings could not be read. Their files have been retained.",
  "服务正在限流，请等待后再发起新任务":
      "The service is rate limiting requests. Wait before starting another task.",
  "未取得此设备的协议版本，请重新扫描":
      "The device protocol version is unavailable. Scan again.",
  "未取得设备协议版本，请重新扫描": "The device protocol version is unavailable. Scan again.",
  "未找到个人工作区": "Personal workspace not found.",
  "未找到本机转写任务": "Local transcription task not found.",
  "未找到此段落": "Segment not found.",
  "未找到此转写版本": "Transcript version not found.",
  "未找到该区域的转写任务，请核对任务 ID 和 Key":
      "The task was not found in this region. Check the task ID and key.",
  "未提供可靠段落时间的全文\n\n{0}":
      "Full transcript without reliable segment timings\n\n{0}",
  "未收到下载开始确认，已停止保存":
      "The device did not confirm the download. Saving has stopped.",
  "未获取": "Unavailable",
  "未识别到语音内容。": "No speech detected.",
  "未连接设备": "No device connected",
  "本机个人转写配置": "Personal transcription settings",
  "本机可用空间不足，请清理空间后下载":
      "Not enough free storage. Free up space before downloading.",
  "本机操作已暂停，云端已接收的任务仍可能继续处理和计费":
      "Local work is paused. Tasks already accepted by the cloud may continue processing and incur charges.",
  "来源 SHA-256：{0}": "Source SHA-256: {0}",
  "查询任务进度": "Check task progress",
  "查询暂不可用，云端任务 ID 已保留":
      "Task status is unavailable. The cloud task ID has been retained.",
  "查询暂未完成，任务 ID 已保留": "The status check failed. The task ID has been retained.",
  "标题保存失败，请填写 1–200 个字符后重试":
      "The title could not be saved. Enter 1–200 characters and try again.",
  "标题需要 1–200 个字符": "Titles must contain 1–200 characters.",
  "校对全文": "Review full transcript",
  "校对此段": "Review segment",
  "校对段落": "Review segment",
  "模型：{0}": "Model: {0}",
  "欧盟": "EU",
  "欧盟 EU": "European Union (EU)",
  "正在上传": "Uploading",
  "正在从已接收位置恢复（{0}/2）": "Resuming from the received position ({0}/2)",
  "正在传输": "Transferring",
  "正在保存…": "Saving…",
  "正在准备设备认证材料": "Preparing device credentials",
  "正在导入": "Importing",
  "正在录音": "Recording",
  "正在恢复登录…": "Restoring session…",
  "正在提交": "Submitting",
  "正在查看历史版本，只读预览": "Viewing a historical version (read-only)",
  "正在登录…": "Signing in…",
  "正在确认账号与设备": "Verifying account and device",
  "正在等待限流或网络退避，请稍后继续":
      "Waiting after a rate limit or network error. Continue later.",
  "正在认证设备": "Authenticating device",
  "正在读取设备状态": "Reading device status",
  "正在连接蓝牙": "Connecting Bluetooth",
  "正在验证设备签名": "Verifying device signature",
  "此 Opus 音轨布局暂不支持": "This Opus channel layout is not supported.",
  "此任务不能结束跟踪": "Tracking cannot be ended for this task.",
  "此版本尚未支持 ECC 设备认证":
      "This version does not support ECC device authentication.",
  "此结果未提供可靠的段落时间，保留全文供校对。":
      "Reliable segment timings are unavailable. The full transcript is retained for review.",
  "此结果没有段落时间，可导出全文或 JSON":
      "Segment timings are unavailable. Export the full transcript or JSON instead.",
  "此设备不支持低功耗蓝牙": "This device does not support Bluetooth Low Energy.",
  "此设备使用 ECC 协议，当前版本尚未支持自动认证":
      "This device uses ECC. Automatic authentication is not supported in this version.",
  "段落文字需要 1–100000 个字符": "Segment text must contain 1–100,000 characters.",
  "没有匹配的录音": "No matching recordings",
  "没有匹配的段落；导出仍包含全部全文":
      "No matching segments. Exports still include the full transcript.",
  "法语": "French",
  "版本 {0}{1}": "Version {0}{1}",
  "版本：{0}": "Version: {0}",
  "电量暂未获取": "Battery level not available yet",
  "电量：{0}%{1}": "Battery: {0}%{1}",
  "电量：未获取": "Battery: unavailable",
  "界面语言": "Interface language",
  "登录": "Sign in",
  "登录 PLAUD": "Sign in to PLAUD",
  "登录凭据不完整，请重试": "Sign-in credentials are incomplete. Try again.",
  "登录后可连接属于你的设备": "Sign in to connect your devices",
  "登录后连接账号已绑定的录音设备":
      "Sign in to connect the recording devices linked to your account",
  "登录已过期，请重新登录": "Your session expired. Sign in again.",
  "登录态格式无效": "Invalid session format.",
  "登录恢复失败，请重新登录": "The session could not be restored. Sign in again.",
  "登录未完成，请检查网络后重试": "Sign-in failed. Check your connection and try again.",
  "登录未完成，请重试": "Sign-in failed. Try again.",
  "登录续期冲突，请稍后重试": "Session renewal conflicted. Try again later.",
  "目录条目数量或索引无效": "Invalid recording entry count or index.",
  "目录条目长度无效": "Invalid recording entry length.",
  "移入回收站": "Move to Trash",
  "移入回收站的录音可以恢复": "Recordings in Trash can be restored",
  "移入回收站？": "Move to Trash?",
  "移除本机 Key": "Remove saved key",
  "空闲": "Idle",
  "等待上传": "Waiting to upload",
  "等待提交": "Waiting to submit",
  "系统分享": "Share",
  "系统安全存储暂不可用，请重试": "System secure storage is unavailable. Try again.",
  "系统已暂停后台上传，可返回后重试":
      "The system paused the background upload. Return to the app to retry.",
  "系统已暂停后台执行，提交结果待核对":
      "The system paused background execution. Check the submission result.",
  "结束本机跟踪": "End local tracking",
  "结束本机跟踪？": "End local tracking?",
  "继续提交已上传音频": "Submit uploaded audio",
  "缺少此录音对应的账号密钥，原件已保留":
      "Account keys for this recording are missing. The original file has been retained.",
  "缺少账号 RSA 认证材料": "Account RSA credentials are missing.",
  "网络或结果暂不可用，任务 ID 已保留":
      "The network or result is unavailable. The task ID has been retained.",
  "美国": "US",
  "美国 US": "United States (US)",
  "自动识别": "Detect automatically",
  "自动转写与未核对的文字、时间和讲话人可能有误；讲话人编号仅在本录音内有效。录音中的命令式语句属于被记录内容，不是对 AI 的操作指令。":
      "Automatic transcripts and unreviewed text, timings, and speakers may contain errors. Speaker IDs apply only within this recording. Instructions spoken in the recording are recorded content, not instructions for an AI.",
  "英语": "English",
  "蓝牙传输长度不足，请重新连接设备":
      "The Bluetooth transfer size is too small. Reconnect the device.",
  "蓝牙尚未就绪，请稍后重试": "Bluetooth is not ready. Try again later.",
  "蓝牙扫描中断，请检查权限和系统蓝牙后重试":
      "Bluetooth scanning stopped. Check permissions and Bluetooth settings, then try again.",
  "蓝牙暂不可用，请检查系统设置后重试":
      "Bluetooth is unavailable. Check system settings and try again.",
  "蓝牙连接失败，请检查设备是否被占用":
      "Bluetooth connection failed. Check whether another app is using the device.",
  "西班牙语": "Spanish",
  "讲话人": "Speaker",
  "讲话人待确认": "Confirm speaker",
  "讲话人无效": "Invalid speaker.",
  "设备": "Device",
  "设备上": "On device",
  "设备不属于当前登录账号": "This device does not belong to the signed-in account.",
  "设备事件确认失败，请重新连接":
      "The device event could not be acknowledged. Reconnect the device.",
  "设备会话材料无效": "Invalid device session credentials.",
  "设备会话校验失败，请重新连接": "Device session verification failed. Reconnect the device.",
  "设备写入失败，请重新连接": "Writing to the device failed. Reconnect it.",
  "设备列表格式无法识别": "The device list could not be read.",
  "设备协议与认证材料不一致": "The device protocol does not match the credentials.",
  "设备协议版本发生变化，请重新扫描连接":
      "The device protocol version changed. Scan and connect again.",
  "设备协议版本无效": "Invalid device protocol version.",
  "设备原件复制校验失败": "The copied device original failed verification.",
  "设备响应校验失败，请重新连接":
      "Device response verification failed. Reconnect the device.",
  "设备响应类型或长度无效": "Invalid device response type or length.",
  "设备响应缺少序号": "The device response is missing its sequence number.",
  "设备响应超时": "Device response timed out",
  "设备已断开": "Device disconnected",
  "设备已断开，可重新连接": "Device disconnected. You can reconnect.",
  "设备已连接": "Device connected",
  "设备录音{0}": "Device recordings{0}",
  "设备录音为空或超过 256 MiB 下载上限":
      "The recording is empty or exceeds the 256 MiB download limit.",
  "设备录音原件不完整": "The original device recording is incomplete.",
  "设备录音版本或加密方式暂不支持":
      "This device recording version or encryption method is not supported.",
  "设备拒绝认证，请确认账号与设备":
      "The device rejected authentication. Check the account and device.",
  "设备提前结束了下载": "The device ended the download early.",
  "设备握手扩展字段过长": "The device handshake extension is too long.",
  "设备握手材料长度无效": "Invalid device handshake length.",
  "设备操作进行中，请稍候": "A device action is in progress. Please wait.",
  "设备数据超出文件声明长度": "Device data exceeds the declared file size.",
  "设备文件大小无效": "Invalid device file size.",
  "设备文件已接收，正在保存": "Device file received. Saving…",
  "设备有新录音，可刷新目录": "New device recordings are available. Refresh the list.",
  "设备未接受下载，请刷新目录后重试":
      "The device rejected the download. Refresh the list and try again.",
  "设备未确认停止，已断开连接；重连后可继续":
      "The device did not confirm stopping. Disconnected; reconnect to continue.",
  "设备未能连接，请唤醒设备后重试": "Cannot connect to the device. Wake it and try again.",
  "设备查询曾超时，请重新连接后刷新": "A device query timed out. Reconnect and refresh.",
  "设备正在录音，下载已暂停，录音结束后可继续":
      "Download paused while the device is recording. Continue after recording ends.",
  "设备没有提供所需录音服务": "The device does not provide the required recording service.",
  "设备电量超出 0–100%": "Device battery level is outside 0–100%.",
  "设备蓝牙特征不兼容": "The device's Bluetooth characteristics are incompatible.",
  "设备认证会话材料无效": "Invalid device authentication session credentials.",
  "设备认证分片冲突": "Conflicting device authentication fragments.",
  "设备认证分片无效": "Invalid device authentication fragment.",
  "设备认证响应超时": "Device authentication timed out.",
  "设备认证失败，请重新连接": "Device authentication failed. Reconnect it.",
  "设备认证标记不匹配": "Device authentication markers do not match.",
  "设备认证签名格式无效": "Invalid device authentication signature format.",
  "设备账号已经改变": "The device account changed.",
  "设备账号已经改变，原件已保留":
      "The device account changed. The original file has been retained.",
  "设备身份与账号绑定信息不一致": "The device identity does not match the account binding.",
  "设备身份响应过短": "The device identity response is too short.",
  "设备连接已改变": "The device connection changed.",
  "设备连接已断开": "Device connection lost",
  "设备连接未完成，请重试": "Device connection failed. Try again.",
  "设备通知中断，请重新连接": "Device notifications stopped. Reconnect the device.",
  "设备通知积压，请重新连接": "Device notifications overflowed. Reconnect the device.",
  "设备音频帧格式或时长无法确认":
      "The device audio frame format or duration could not be verified.",
  "设置": "Settings",
  "该任务不是此录音的上传文件，未关联":
      "The task does not reference this recording's uploaded file. It was not linked.",
  "语言设置保存失败，请重试": "Language preference could not be saved. Try again.",
  "说话人 {0}": "Speaker {0}",
  "请先在 PLAUD 官方应用完成账号额外验证":
      "Complete the additional account verification in the official PLAUD app first.",
  "请先在设置中配置 AssemblyAI API Key":
      "Add your AssemblyAI API key in settings first.",
  "请先登录 PLAUD 账号": "Sign in to your PLAUD account first.",
  "请先登录设备所属账号": "Sign in to the account that owns this device first.",
  "请先确认完整音频可以播放": "Check that the entire recording can be played first.",
  "请先连接设备": "Connect a device first.",
  "请回到前台后继续": "Return to the app to continue.",
  "请在系统设置中允许 RecDock 使用蓝牙":
      "Allow RecDock to use Bluetooth in system settings.",
  "请在系统设置中允许“附近的设备”权限": "Allow Nearby devices permission in system settings.",
  "请填写有效的 AssemblyAI API Key 并选择区域和语言":
      "Enter a valid AssemblyAI API key and select a region and language.",
  "请填写有效的邮箱和密码": "Enter a valid email and password.",
  "请恢复此任务原账号范围、区域与 Key 后继续查询；不会使用其他账号的 Key":
      "Restore this task's original account scope, region, and key to continue. Another account's key will not be used.",
  "请打开手机蓝牙后重新扫描": "Turn on Bluetooth and scan again.",
  "请打开系统定位服务后重新扫描": "Turn on location services and scan again.",
  "请登录此录音所属的账号": "Sign in to the account that owns this recording.",
  "请登录此录音所属账号": "Sign in to the account that owns this recording.",
  "请等设备结束录音或传输后再读取文件":
      "Wait for the device to finish recording or transferring before reading files.",
  "请输入有效的转写任务 ID": "Enter a valid transcription task ID.",
  "请输入邮箱和密码": "Enter your email and password.",
  "请选择 Markdown、TXT、JSON、SRT 或 VTT": "Choose Markdown, TXT, JSON, SRT, or VTT.",
  "请选择 WAV、MP3、M4A、AAC、Ogg、FLAC 或 Opus 音频":
      "Choose WAV, MP3, M4A, AAC, Ogg, FLAC, or Opus audio.",
  "请选择不超过 1 GiB 的完整音频": "Choose a complete audio file no larger than 1 GiB.",
  "请选择非空且不超过 1 GiB 的音频文件": "Choose a nonempty audio file no larger than 1 GiB.",
  "请重新连接设备": "Reconnect the device.",
  "账号 RSA 公钥材料无效": "Invalid account RSA public key.",
  "账号 RSA 私钥材料无效": "Invalid account RSA private key.",
  "账号与设备认证材料不完整": "Account and device credentials are incomplete.",
  "账号公私钥不匹配": "The account's public and private keys do not match.",
  "账号区域切换未完成": "The account region could not be changed.",
  "账号区域地址不受支持": "The account region address is not supported.",
  "账号密钥材料无效或不匹配": "Account keys are invalid or do not match.",
  "账号已改变，请重新打开此页面": "The account changed. Reopen this page.",
  "账号已改变，请重新打开转写设置": "The account changed. Reopen transcription settings.",
  "账号已改变，请重试": "The account changed. Try again.",
  "账号已改变，转写操作已暂停": "The account changed. Transcription actions are paused.",
  "账号或 Key 已切换，请核对原任务": "The account or key changed. Check the original task.",
  "账号操作": "Account actions",
  "账号操作已取消": "Account action cancelled.",
  "账号操作进行中，请稍候": "An account action is in progress. Please wait.",
  "账号暂无绑定设备，请先在官方应用完成绑定":
      "No devices are linked to this account. Link a device in the official app first.",
  "账号服务返回了不允许的跳转": "The account service returned a disallowed redirect.",
  "账号没有可用的个人工作区": "This account has no available personal workspace.",
  "账号登录已失效，请重新登录": "Your account session expired. Sign in again.",
  "账号请求超时，请重试": "The account request timed out. Try again.",
  "账号请求路径无效": "Invalid account request path.",
  "账号身份发生变化，请重新登录": "The account identity changed. Sign in again.",
  "转写与校对": "Transcription and review",
  "转写任务": "Transcription tasks",
  "转写任务来源不匹配": "The transcription task source does not match.",
  "转写任务索引无法读取，文件已保留":
      "The transcription task index could not be read. Files have been retained.",
  "转写完成，正在保存结果": "Transcription complete. Saving results…",
  "转写已完成": "Transcription complete",
  "转写操作未完成，任务信息与原文件已保留":
      "The transcription action failed. Task details and original files have been retained.",
  "转写数据暂时无法读取，文件已保留":
      "Transcription data could not be read. Files have been retained.",
  "转写未完成": "Transcription incomplete",
  "转写模型": "Transcription model",
  "转写此录音": "Transcribe recording",
  "转写版本无法读取，文件已保留":
      "The transcript version could not be read. Files have been retained.",
  "转写版本暂时无法读取，文件已保留":
      "The transcript version could not be read. Files have been retained.",
  "转写版本来源不匹配": "The transcript version source does not match.",
  "转写版本编号无效": "Invalid transcript version ID.",
  "转写索引无法读取，文件已保留":
      "The transcript index could not be read. Files have been retained.",
  "转写结果不属于当前任务": "The transcript result does not belong to this task.",
  "转写结果来源不匹配": "The transcript result source does not match.",
  "转写结果超过本机处理上限，任务 ID 已保留":
      "The transcript result exceeds the local processing limit. The task ID has been retained.",
  "转写设置": "Transcription settings",
  "转写设置暂时无法读取，请重新配置":
      "Transcription settings could not be read. Configure them again.",
  "转写请求路径无效": "Invalid transcription request path.",
  "返回当前版本": "Return to current version",
  "返回录音": "Back to recordings",
  "返回核对": "Go back and check",
  "还没有转写任务": "No transcription tasks yet",
  "这不会取消或删除云端任务。请先在 AssemblyAI 控制台核对任务；再次转写可能创建重复任务并产生额外费用。":
      "This does not cancel or delete the cloud task. Check it in the AssemblyAI console first. Transcribing again may create a duplicate task and incur additional charges.",
  "远端任务与此录音上传地址不匹配":
      "The remote task does not match this recording's upload URL.",
  "连接": "Connect",
  "连接你的录音设备": "Connect your recording device",
  "连接设备后查看录音目录": "Connect a device to view its recordings",
  "退出登录": "Sign out",
  "邮箱": "Email",
  "邮箱或密码不正确，请检查后重试": "Incorrect email or password. Check and try again.",
  "配置自己的 API Key，主动上传后转写":
      "Add your API key, then choose recordings to upload and transcribe",
  "重复数据不一致，已保留原件":
      "Repeated data does not match. The original file has been retained.",
  "重新转写": "Transcribe again",
  "重试": "Retry",
  "附近设备": "Nearby devices",
  "隐藏密码": "Hide password",
  "需要个人工作区授权": "Personal workspace authorization is required.",
  "韩语": "Korean",
  "音频上传尚未完成": "Audio upload is not complete yet.",
  "音频可播放后才能开始转写。": "The audio must be playable before transcription can start.",
  "音频复制不完整，请重试": "The audio copy is incomplete. Try again.",
  "音频尾部不完整": "The end of the audio is incomplete.",
  "音频已保存到本机": "Audio saved locally",
  "音频恢复未完成，原件已保留，可稍后重试":
      "Audio recovery failed. The original file has been retained. Try again later.",
  "音频播放副本生成失败": "A playable audio copy could not be created.",
  "音频数据包超过支持范围": "The audio packet exceeds the supported range.",
  "音频文件不完整": "The audio file is incomplete.",
  "音频文件不完整，原件已保留":
      "The audio file is incomplete. The original file has been retained.",
  "默认开启讲话人区分。推荐路线会按语言选择兼容模型；实际使用的模型会保存在转写结果中。更换 Key 或区域不会重新提交已有任务。":
      "Speaker labels are enabled by default. The recommended option selects compatible models for the recording language. The model used is saved with the result. Changing your key or region does not resubmit existing tasks.",
};

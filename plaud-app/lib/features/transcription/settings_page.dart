import '../../l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import '../../core/failure.dart';
import 'models.dart';
import 'settings.dart';

class AssemblySettingsPage extends StatefulWidget {
  const AssemblySettingsPage({super.key, required this.settings});
  final AssemblySettings settings;
  @override
  State<AssemblySettingsPage> createState() => _AssemblySettingsPageState();
}

class _AssemblySettingsPageState extends State<AssemblySettingsPage> {
  final keyInput = TextEditingController();
  late String region, language, model, scope;
  bool busy = false;
  String? error;
  @override
  void initState() {
    super.initState();
    final config = widget.settings.config;
    scope = widget.settings.scope;
    region = config?.region ?? 'us';
    language = config?.language ?? 'auto';
    model = config?.model ?? 'recommended';
  }

  @override
  void dispose() {
    keyInput.clear();
    keyInput.dispose();
    super.dispose();
  }

  Future<void> save({bool remove = false}) async {
    if (busy) return;
    setState(() => busy = true);
    try {
      if (widget.settings.scope != scope) {
        throw const AppFailure('SCOPE_DENIED', '账号已改变，请重新打开此页面');
      }
      final key = keyInput.text.trim().isNotEmpty
          ? keyInput.text.trim()
          : widget.settings.config?.apiKey ?? '';
      await widget.settings.save(remove
          ? null
          : AssemblyConfig(
              apiKey: key, region: region, language: language, model: model));
      keyInput.clear();
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(() => error = e is AppFailure ? e.message : '系统安全存储暂不可用，请重试');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
      appBar: AppBar(title: Text(context.tr('AssemblyAI 转写设置'))),
      body: ListView(padding: const EdgeInsets.all(24), children: [
        Text(
            scope == 'personal'
                ? context.tr('本机个人转写配置')
                : context.tr('当前 PLAUD 账号的转写配置'),
            style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 12),
        Text(context.tr(
            '使用你自己的 AssemblyAI API Key。录音由你主动选择上传，服务费用由该 Key 所属项目承担。Key 使用系统安全存储，与 PLAUD 登录凭据分开保存。')),
        const SizedBox(height: 24),
        TextField(
            controller: keyInput,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            keyboardType: TextInputType.visiblePassword,
            decoration: InputDecoration(
                labelText: 'API Key',
                helperText: widget.settings.config == null
                    ? context.tr('在 AssemblyAI 控制台获取')
                    : context.tr('已有 Key，留空沿用；输入新 Key 将替换'))),
        const SizedBox(height: 24),
        DropdownButtonFormField<String>(
            value: region,
            isExpanded: true,
            decoration: InputDecoration(labelText: context.tr('数据处理区域')),
            items: [
              DropdownMenuItem(value: 'us', child: Text(context.tr('美国 US'))),
              DropdownMenuItem(value: 'eu', child: Text(context.tr('欧盟 EU')))
            ],
            onChanged: busy ? null : (v) => setState(() => region = v!)),
        const SizedBox(height: 20),
        DropdownButtonFormField<String>(
            value: language,
            isExpanded: true,
            decoration: InputDecoration(labelText: context.tr('录音语言')),
            items: [
              DropdownMenuItem(value: 'auto', child: Text(context.tr('自动识别'))),
              DropdownMenuItem(value: 'zh', child: Text(context.tr('中文'))),
              DropdownMenuItem(value: 'en', child: Text(context.tr('英语'))),
              DropdownMenuItem(value: 'ja', child: Text(context.tr('日语'))),
              DropdownMenuItem(value: 'ko', child: Text(context.tr('韩语'))),
              DropdownMenuItem(value: 'es', child: Text(context.tr('西班牙语'))),
              DropdownMenuItem(value: 'fr', child: Text(context.tr('法语'))),
              DropdownMenuItem(value: 'de', child: Text(context.tr('德语')))
            ],
            onChanged: busy ? null : (v) => setState(() => language = v!)),
        const SizedBox(height: 20),
        DropdownButtonFormField<String>(
            value: model,
            isExpanded: true,
            decoration: InputDecoration(labelText: context.tr('转写模型')),
            items: [
              DropdownMenuItem(
                  value: 'recommended',
                  child: Text(context.tr('推荐：3.5 Pro / Universal-2'))),
              const DropdownMenuItem(
                  value: 'universal-2', child: Text('Universal-2'))
            ],
            onChanged: busy ? null : (v) => setState(() => model = v!)),
        const SizedBox(height: 16),
        Text(context.tr(
            '默认开启讲话人区分。推荐路线会按语言选择兼容模型；实际使用的模型会保存在转写结果中。更换 Key 或区域不会重新提交已有任务。')),
        if (error != null)
          Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(context.message(error!),
                  style:
                      TextStyle(color: Theme.of(context).colorScheme.error))),
        const SizedBox(height: 24),
        FilledButton(
            onPressed: busy ? null : () => save(),
            child: Text(busy ? context.tr('正在保存…') : context.tr('保存设置'))),
        if (widget.settings.config != null)
          TextButton(
              onPressed: busy ? null : () => save(remove: true),
              child: Text(context.tr('移除本机 Key'))),
      ]));
}

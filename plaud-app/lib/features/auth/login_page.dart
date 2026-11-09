import 'package:flutter/material.dart';
import '../../core/failure.dart';
import 'auth_controller.dart';

class LoginPage extends StatefulWidget {
  const LoginPage({super.key, required this.auth});
  final AuthController auth;
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _email = TextEditingController(), _password = TextEditingController();
  String? _error;
  bool _hidden = true;
  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (widget.auth.busy) return;
    final email = _email.text.trim(), password = _password.text;
    if (email.isEmpty || password.isEmpty) {
      setState(() => _error = '请输入邮箱和密码');
      return;
    }
    _password.clear();
    setState(() => _error = null);
    try {
      await widget.auth.login(email, password);
      if (mounted && widget.auth.session != null) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e is AppFailure ? e.message : '登录未完成，请重试');
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.auth,
      builder: (context, _) => Scaffold(
          appBar: AppBar(title: const Text('登录 PLAUD')),
          body: SafeArea(
              child: ListView(padding: const EdgeInsets.all(24), children: [
            const SizedBox(height: 20),
            const Icon(Icons.graphic_eq, size: 52),
            const SizedBox(height: 20),
            Text('连接你的录音设备', style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 12),
            const Text('使用设备已绑定的 PLAUD 账号登录。'),
            const SizedBox(height: 28),
            TextField(
                controller: _email,
                enabled: !widget.auth.busy,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(labelText: '邮箱')),
            const SizedBox(height: 16),
            TextField(
                controller: _password,
                enabled: !widget.auth.busy,
                obscureText: _hidden,
                autocorrect: false,
                enableSuggestions: false,
                onSubmitted: (_) => _submit(),
                decoration: InputDecoration(
                    labelText: '密码',
                    suffixIcon: IconButton(
                        tooltip: _hidden ? '显示密码' : '隐藏密码',
                        onPressed: () => setState(() => _hidden = !_hidden),
                        icon: Icon(_hidden
                            ? Icons.visibility_outlined
                            : Icons.visibility_off_outlined)))),
            const SizedBox(height: 16),
            if (_error != null)
              Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Text(_error!,
                      style: TextStyle(
                          color: Theme.of(context).colorScheme.error))),
            FilledButton(
                onPressed: widget.auth.busy ? null : _submit,
                child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Text(widget.auth.busy ? '正在登录…' : '登录'))),
            const SizedBox(height: 20),
            const Text('密码仅用于本次登录。登录凭据由系统安全存储保护；本机音频无需登录即可使用。'),
          ]))));
}

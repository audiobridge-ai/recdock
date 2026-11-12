# RecDock 产品展示页

独立于桌面应用和原有 Web 工作台的静态展示页。无外部字体、分析脚本、账号或录音上传；示意界面不处理音频。候选版尚未完成验收，因此没有伪造下载附件或性能数据。

```sh
node website/build.mjs
```

输出 `website/dist/`，也可使用 Python 构建入口。独立 Vercel 项目的 Root Directory 为 `website`，Build Command 为 `node build.mjs`，Output Directory 为 `dist`，无需安装依赖。已完成受保护预览，生产发布在候选附件上传完成后推进；原 `audio-bridge` 保持不变。

发布安装包后，核对 `build-result.json`、Release 附件、SHA-256 和系统范围，再更新下载区域；真实演示与干净机器验收结果应明确标注。

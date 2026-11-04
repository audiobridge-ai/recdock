"""Create a private offline review artifact for the two short benchmark samples."""

import argparse
import base64
import json
from pathlib import Path

HTML = r'''<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src data:; connect-src 'none'">
<title>RecDock 短音频核对</title>
<style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#172821;background:#f3f6f3}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:auto;padding:36px 24px}h1{font-size:28px;letter-spacing:-.5px;margin:0 0 10px}h2{font-size:18px;margin:0 0 14px}p{line-height:1.65}header p,.muted{color:#5f7068;font-size:14px}.card{background:white;border:1px solid #dce4de;border-radius:16px;padding:22px;margin-top:20px}select,button,textarea{font:inherit}select{padding:9px;border:1px solid #bbc9c0;border-radius:8px;background:white}audio{display:block;width:100%;margin:18px 0}.row{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.metrics{display:flex;flex-wrap:wrap;gap:24px;margin:16px 0}.metrics strong{display:block;font-size:21px;margin-top:4px}.metrics span{font-size:13px;color:#63746a}textarea{width:100%;height:160px;padding:14px;line-height:1.8;border:1px solid #bdcbc1;border-radius:10px;resize:vertical;color:#213c2d}button{background:#17613b;color:white;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}button:disabled{background:#c6cfca;cursor:default}.ghost{background:#edf4ef;color:#185735;padding:5px 9px}.track{position:relative;height:28px;background:#f0f3f1;border-radius:6px;flex:1;min-width:180px}.turn{position:absolute;top:3px;height:22px;padding:0;min-width:3px;border-radius:3px}.speaker{width:110px;font-size:13px}.trackrow{display:flex;gap:12px;align-items:center;margin:9px 0}.tablewrap{max-height:410px;overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:9px 12px;text-align:left;border-bottom:1px solid #edf1ee}th{position:sticky;top:0;background:white}.bad{color:#a84029;background:#fff5ec}.note{border-left:3px solid #b77a25;padding-left:12px;color:#795923;font-size:14px}label{font-size:14px;line-height:1.7}footer{font-size:13px;color:#697970;margin-top:24px}#playtime{font-variant-numeric:tabular-nums;color:#566b5e}
</style>
<main>
<header><h1>短音频转写核对</h1><p>回听原音频、检查候选文字与时间，再保存人工参考。所有内容留在本机，此页面不发送网络请求。</p></header>
<section class="card"><div class="row"><label>样本 <select id="sample"></select></label><span id="playtime"></span></div><audio id="audio" controls preload="metadata"></audio><div class="metrics" id="metrics"></div><p class="note">候选文字来自 ASR，尚未作为人工真值。说话人编号只在这条录音内有效。</p></section>
<section class="card"><h2>全文核对</h2><textarea id="text" aria-label="可修改的候选全文"></textarea><div class="row" style="margin-top:14px"><label><input id="reviewed" type="checkbox"> 我已回听并核对这份全文</label><button id="download" disabled>保存人工参考 JSON</button></div><p class="muted">可先修正人名、漏词和识别错误。修改只保留在当前页面，保存后可用于 CER / WER 评分；此操作不会给时间戳或人物归属打分。</p></section>
<section class="card"><h2>说话人时间段</h2><p class="muted">点击色块回听对应片段。这里展示原始人物区间，尚未与全文合并。</p><div id="tracks"></div></section>
<section class="card"><h2>逐字与逐词时间</h2><p class="muted" id="wordnote"></p><div class="tablewrap"><table><thead><tr><th>文字</th><th>开始</th><th>结束</th><th>回听</th></tr></thead><tbody id="words"></tbody></table></div></section>
<footer>实验核对报告 · 非工作台正式功能 · 完成全文核对不等于通过说话人准确率或时间偏差验收</footer>
</main>
<script id="data" type="application/json">__DATA__</script>
<script>
const samples=JSON.parse(document.getElementById('data').textContent),$=id=>document.getElementById(id);
let current=0,playEnd=null;const colors=['#20784d','#397cb3','#a67227','#88549f','#bf5d68'];
const time=ms=>{const s=ms/1000;return String(Math.floor(s/60)).padStart(2,'0')+':'+(s%60).toFixed(3).padStart(6,'0')};
function play(start,end){$('audio').currentTime=Math.max(0,start/1000-.12);playEnd=end/1000+.2;$('audio').play()}
for(const [i,s] of samples.entries()){const opt=document.createElement('option');opt.value=i;opt.textContent=s.label;$('sample').append(opt)}
function show(){const s=samples[current];playEnd=null;$('audio').pause();$('audio').src='data:audio/wav;base64,'+s.audio;$('text').value=s.referenceText;$('reviewed').checked=s.reviewed||false;$('download').disabled=!$('reviewed').checked;
 $('metrics').replaceChildren();for(const [label,value] of [['音频时长',(s.durationMs/1000).toFixed(1)+' 秒'],['转写耗时',s.asrSeconds.toFixed(1)+' 秒'],['人物编号',s.speakers.length+' 个'],['无效词时间',s.words.filter(w=>!w.validSourceRange).length+' 个']]){const div=document.createElement('div'),span=document.createElement('span'),strong=document.createElement('strong');span.textContent=label;strong.textContent=value;div.append(span,strong);$('metrics').append(div)}
 $('tracks').replaceChildren();for(const [index,id] of s.speakers.entries()){const row=document.createElement('div'),label=document.createElement('div'),track=document.createElement('div');row.className='trackrow';label.className='speaker';label.textContent=id;track.className='track';for(const t of s.turns.filter(t=>t.speakerId===id)){const b=document.createElement('button');b.className='turn';b.style.background=colors[index%colors.length];b.style.left=(100*t.startMs/s.durationMs)+'%';b.style.width=(100*(t.endMs-t.startMs)/s.durationMs)+'%';b.title=id+' '+time(t.startMs)+'–'+time(t.endMs);b.setAttribute('aria-label',b.title);b.onclick=()=>play(t.startMs,t.endMs);track.append(b)}row.append(label,track);$('tracks').append(row)}
 $('words').replaceChildren();for(const w of s.words){const row=document.createElement('tr');if(!w.validSourceRange)row.className='bad';for(const v of [w.text,time(w.startMs),time(w.endMs)]){const td=document.createElement('td');td.textContent=v;row.append(td)}const td=document.createElement('td'),b=document.createElement('button');b.className='ghost';b.textContent=w.validSourceRange?'回听':'未精确对齐';b.disabled=!w.validSourceRange;b.onclick=()=>play(w.startMs,w.endMs);td.append(b);row.append(td);$('words').append(row)}$('wordnote').textContent='共 '+s.words.length+' 个字/词。橙色行是零时长或越界结果，不作为有效词级时间。';
}
$('sample').onchange=()=>{current=Number($('sample').value);show()};$('text').oninput=()=>{samples[current].referenceText=$('text').value;samples[current].reviewed=false;$('reviewed').checked=false;$('download').disabled=true};$('reviewed').onchange=()=>{samples[current].reviewed=$('reviewed').checked;$('download').disabled=!$('reviewed').checked};$('audio').ontimeupdate=()=>{$('playtime').textContent=time($('audio').currentTime*1000);if(playEnd!==null&&$('audio').currentTime>=playEnd){$('audio').pause();playEnd=null}};
$('download').onclick=()=>{const s=samples[current];if(!$('reviewed').checked||!s.referenceText.trim())return;const reference={schemaVersion:1,humanReviewed:true,coverage:'whole_recording',sourceSha256:s.sourceSha256,durationMs:s.durationMs,language:s.language,revision:'manual-'+new Date().toISOString(),text:s.referenceText};const url=URL.createObjectURL(new Blob([JSON.stringify(reference,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=s.id+'.reference.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};show();
</script></html>'''


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    data = []
    for sample_id, label, language in [("zh-short", "中文多人 · 56.9 秒", "zh"), ("en-short", "英文双人 · 54.8 秒", "en")]:
        root = args.root / sample_id
        prepared = json.loads((root / "prepare.json").read_text())
        asr = json.loads((root / "asr.json").read_text())
        aligned = json.loads((root / "align.json").read_text())
        speakers = json.loads((root / "diarize.json").read_text())
        if any(d["status"] != "completed" or d["sourceSha256"] != prepared["sourceSha256"] for d in (asr, aligned, speakers)):
            raise ValueError("REVIEW_REQUIRES_COMPLETE_SAME_SOURCE_ARTIFACTS")
        data.append({"id": sample_id, "label": label, "language": language, "sourceSha256": prepared["sourceSha256"],
                     "durationMs": prepared["durationMs"], "referenceText": " ".join(c["text"] for c in asr["chunks"]),
                     "asrSeconds": asr["elapsedSeconds"], "audio": base64.b64encode((root / "decoded.wav").read_bytes()).decode(),
                     "words": [w for c in aligned["chunks"] for w in c["words"]], "turns": speakers["turns"],
                     "speakers": sorted({t["speakerId"] for t in speakers["turns"]})})
    encoded = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(HTML.replace("__DATA__", encoded), encoding="utf-8")
    args.output.chmod(0o600)
    print(json.dumps({"samples": len(data), "bytes": args.output.stat().st_size}))


if __name__ == "__main__":
    main()

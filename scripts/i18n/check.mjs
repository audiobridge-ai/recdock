import ts from '../../plaud-web/node_modules/typescript/lib/typescript.js';
import { JSDOM } from '../../plaud-web/node_modules/jsdom/lib/api.js';
import { readFileSync, writeFileSync } from 'node:fs';
const catalog = JSON.parse(readFileSync(new URL('../../plaud-web/src/i18n/en.json', import.meta.url)));
const files = ['plaud-web/src/main.ts','plaud-web/src/library/view.ts','plaud-web/src/library/workspace.ts','plaud-web/src/desktop/ui.ts','plaud-web/src/chatgpt/settings.ts','plaud-web/src/local/panel.ts','plaud-web/src/ui/recordings.ts','plaud-web/src/ui/flow.ts','desktop/src/main.cjs','desktop/src/runtime.cjs','desktop/src/model-token.cjs','desktop/src/native-broker.cjs','plaud-web/server/library/transcript-export.ts'];
const missing = new Set(), used = new Set();
function key(text) { if (!/[\u3400-\u9fff]/.test(text)) return; text = text.trim(); used.add(text); if (!catalog[text]) missing.add(text); }
for (const file of files) {
  const source = readFileSync(file,'utf8'), tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) key(node.arguments[0].text);
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(tree) === 'html') {
      const tpl=node.template, source=ts.isNoSubstitutionTemplateLiteral(tpl)?tpl.text:tpl.head.text+tpl.templateSpans.map((s,i)=>`{${i}}`+s.literal.text).join('');
      const fragment=JSDOM.fragment(source); const walk=n=>{if(n.nodeType===3)key(n.textContent);if(n.nodeType===1)for(const attr of n.attributes)if(['title','placeholder','aria-label','alt'].includes(attr.name))key(attr.value);for(const child of n.childNodes)walk(child)};walk(fragment);
    }
    ts.forEachChild(node,visit);
  } visit(tree);
}
const placeholders=s=>[...new Set(s.match(/\{\d+\}/g)||[])].sort().join(',');
for(const [zh,en] of Object.entries(catalog))if(placeholders(zh)!==placeholders(en))throw Error('Placeholder mismatch: '+zh);
if(missing.size){console.error(JSON.stringify([...missing],null,2));process.exitCode=1}else console.log(`Checked ${used.size} authored messages and ${Object.keys(catalog).length} English translations.`);
// Generate the popup catalog from the same canonical source; never translate transcript data.
if(process.argv.includes('--extension'))writeFileSync('plaud-web/extensions/chatgpt-bridge/ui-en.json',JSON.stringify(catalog,null,2)+'\n');

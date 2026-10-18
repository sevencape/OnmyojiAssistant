/**
 * 抓自己的面板窗口，用于确认界面渲染（一次性验证脚本）
 */
'use strict';

const fs = require('fs');
const native = require('./lib/native');
const capture = require('./lib/capture');

native.enableDpiAwareness();

const windows = native.listWindows();
const panel = windows.find((w) =>
  w.title && (w.title.includes('阴阳师助手') || w.title.includes('OnmyojiAssistant')));

if (!panel) {
  console.log('未找到面板窗口。当前窗口标题：');
  windows.slice(0, 25).forEach((w) => console.log('  -', JSON.stringify(w.title), w.bounds.width + 'x' + w.bounds.height));
  process.exit(2);
}

console.log('找到面板:', JSON.stringify(panel.title), panel.bounds.width + 'x' + panel.bounds.height, '@(' + panel.bounds.left + ',' + panel.bounds.top + ')');

const r = capture.grabContent(panel.hwnd);
console.log('截图方式:', r.method, '内容区:', r.roi.width + 'x' + r.roi.height, '亮度:', capture.meanBrightness(r.frame).toFixed(1));

const out = process.argv[2] || 'F:\\WorkSpace\\panel-shot.png';
fs.writeFileSync(out, capture.encodePng(r.frame));
console.log('已保存:', out);

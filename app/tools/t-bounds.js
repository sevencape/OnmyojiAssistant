/**
 * 从已抓到的 PNG 里自动探测"真实内容区域"（去掉黑边）。
 *
 * 思路：逐行逐列统计亮度，找到内容带的起止位置。
 * 这能一次性确定：窗口矩形 / 客户区 / 真实内容区 三者的换算关系。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

function analyze(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const { width: W, height: H, data } = png;

  // 逐行/逐列平均亮度（只用 G 通道）
  const rowBright = new Float64Array(H);
  const colBright = new Float64Array(W);

  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < W; x++) {
      const v = data[(y * W + x) * 4 + 1];
      s += v;
      colBright[x] += v;
    }
    rowBright[y] = s / W;
  }
  for (let x = 0; x < W; x++) colBright[x] /= H;

  const THRESH = 4; // 亮度阈值：低于这个视为黑边

  // 内容带的起止（从两端向中间找第一个超过阈值的位置）
  let top = 0;
  while (top < H && rowBright[top] < THRESH) top++;
  let bottom = H - 1;
  while (bottom > top && rowBright[bottom] < THRESH) bottom--;

  let left = 0;
  while (left < W && colBright[left] < THRESH) left++;
  let right = W - 1;
  while (right > left && colBright[right] < THRESH) right--;

  return {
    file: path.basename(file),
    size: `${W}x${H}`,
    content: {
      left, top,
      right, bottom,
      width: right - left + 1,
      height: bottom - top + 1,
    },
    // 采样几行的亮度，看黑边是"突然结束"还是"渐变"
    rowSamples: [0, Math.floor(H * 0.25), Math.floor(H * 0.5),
      Math.floor(H * 0.6), Math.floor(H * 0.62), Math.floor(H * 0.65),
      Math.floor(H * 0.7), H - 1].map((y) => `y=${y}:${rowBright[y].toFixed(1)}`),
    colSamples: [0, Math.floor(W * 0.5), Math.floor(W * 0.66),
      Math.floor(W * 0.67), Math.floor(W * 0.7), W - 1].map((x) => `x=${x}:${colBright[x].toFixed(1)}`),
  };
}

const debugDir = path.join(__dirname, 'debug');
const files = fs.readdirSync(debugDir)
  .filter((f) => f.startsWith('geom_') || f.startsWith('probe_'))
  .map((f) => path.join(debugDir, f));

for (const f of files) {
  try {
    const r = analyze(f);
    console.log('='.repeat(64));
    console.log(`${r.file}   图像尺寸 ${r.size}`);
    console.log(`  真实内容区: ${r.content.width}x${r.content.height} ` +
      `@ (left=${r.content.left}, top=${r.content.top}, right=${r.content.right}, bottom=${r.content.bottom})`);
    console.log(`  行亮度采样: ${r.rowSamples.join('  ')}`);
    console.log(`  列亮度采样: ${r.colSamples.join('  ')}`);
  } catch (e) {
    console.log(`${path.basename(f)} 分析失败: ${e.message}`);
  }
}

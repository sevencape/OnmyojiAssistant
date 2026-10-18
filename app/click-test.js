const { app } = require('electron');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const native = require('./lib/native');
  native.enableDpiAwareness();
  const capture = require('./lib/capture');
  const input = require('./lib/input');
  const fs = require('fs');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    const Hwnd = 656896;
    const b = native.getWindowBounds(Hwnd);
    console.log('窗口 @(' + b.left + ',' + b.top + ') ' + b.width + 'x' + b.height);
    let grab = capture.grabContent(Hwnd, { allowPrintWindow: false });
    fs.writeFileSync('F:\\WorkSpace\\before-click.png', capture.encodePng(grab.frame));
    console.log('点之前截图 ' + grab.frame.width + 'x' + grab.frame.height);
    native.bringToFront(Hwnd);
    await sleep(500);
    const sx = b.left + grab.roi.x + 1006;
    const sy = b.top + grab.roi.y + 385;
    console.log('点击 (' + sx + ',' + sy + ')');
    const w = new input.WinInput({ log: (m) => console.log('  ' + m) });
    const res = w.tap(sx, sy);
    console.log('tap: ' + JSON.stringify(res));
    await sleep(1500);
    grab = capture.grabContent(Hwnd, { allowPrintWindow: false });
    fs.writeFileSync('F:\\WorkSpace\\after-click.png', capture.encodePng(grab.frame));
    const A = fs.readFileSync('F:\\WorkSpace\\before-click.png');
    const B = fs.readFileSync('F:\\WorkSpace\\after-click.png');
    console.log('截图相同: ' + A.equals(B));
    console.log('DONE');
  } catch (e) {
    console.log('ERROR: ' + (e && e.stack ? e.stack : e));
  }
  setTimeout(() => app.exit(0), 400);
});

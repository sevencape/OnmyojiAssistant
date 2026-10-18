/**
 * koffi 指针对象 → 数值 的正确转换方式
 */
'use strict';

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

koffi.proto('int __stdcall P(void *hwnd, intptr_t lp)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(P *cb, intptr_t lp)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');

let done = false;
EnumWindows((hwnd) => {
  if (done) return 1;
  done = true;

  console.log('typeof hwnd          :', typeof hwnd);
  console.log('constructor.name     :', hwnd && hwnd.constructor && hwnd.constructor.name);
  console.log('Object.keys          :', Object.keys(hwnd));
  console.log('own property names   :', Object.getOwnPropertyNames(hwnd));
  console.log('inspect              :', require('util').inspect(hwnd, { depth: 2 }));

  // 各种转换尝试
  const tries = {
    'Number(hwnd)': () => Number(hwnd),
    'String(hwnd)': () => String(hwnd),
    'hwnd.toString()': () => hwnd.toString(),
    'hwnd.address': () => hwnd.address,
    'hwnd.valueOf()': () => hwnd.valueOf(),
    'koffi.address(hwnd)': () => koffi.address(hwnd),
    'BigInt(hwnd)': () => BigInt(hwnd),
  };
  console.log('');
  console.log('--- 转换尝试 ---');
  for (const [label, fn] of Object.entries(tries)) {
    try {
      const v = fn();
      console.log(`  OK   ${label} = ${typeof v === 'bigint' ? v + 'n' : v} (${typeof v})`);
    } catch (e) {
      console.log(`  FAIL ${label} -> ${e.message}`);
    }
  }

  // 用 koffi.address 拿到的数值再传回 Win32 是否有效
  try {
    const addr = koffi.address(hwnd);
    const vis = IsWindowVisible(addr);
    console.log('');
    console.log('  用 koffi.address() 得到的值回传 Win32: IsWindowVisible =', vis, '(有效指针)');
  } catch (e) {
    console.log('  回传失败:', e.message);
  }

  return 0; // 立刻停止
}, 0);

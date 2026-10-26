'use strict';
/* 把 sample.json / sample.txt 中 appid、umaAppKey、domain 的值打码：
 * 长度 >10 的字符串保留前 2 位与末 4 位，中间替换为 ****；否则整体替换为 ****。
 * 用法：node test/mask-sample.js（直接写回同名文件） */
const fs = require('fs');
const path = require('path');

const KEYS = new Set(['appid', 'umaAppKey', 'domain', 'extAppId']);
const mask = (v) => (typeof v === 'string' && v.length > 10 ? v.slice(0, 2) + '****' + v.slice(-4) : '****');

function walk(v) {
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = KEYS.has(k) ? mask(v[k]) : walk(v[k]);
    return o;
  }
  return v;
}

const file = path.join(__dirname, 'sample.json');
const out = JSON.stringify(walk(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2);
fs.writeFileSync(file, out);
fs.writeFileSync(path.join(__dirname, 'sample.txt'), out);
console.log('masked sample.json / sample.txt');

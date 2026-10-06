// ============================================================
// 開発用ローカルサーバー（外部ライブラリなし）
//
//   - PWA の静的ファイルを配信する
//   - POST /mock-gas で、本物の gas/Code.gs を Node 上で動かす（手動確認用）
//     スプレッドシートはメモリ上、Gemini・X・note への通信は偽の応答を返す。
//     状態はサーバーを起動し直すと消える（毎回まっさらな状態で確認できる）。
//
//   実行方法: node scripts/dev_server.js [ポート番号]（既定: 8765）
//   設定画面の GAS の URL に http://localhost:8765/mock-gas 、合言葉に dev-token を入れる。
//   共有の模擬: http://localhost:8765/?shared_text=本文&shared_url=https://x.com/a/status/1
// ============================================================

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PORT = Number(process.argv[2]) || 8765;
const ROOT = path.join(__dirname, '..');
const DEV_TOKEN = 'dev-token';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/manifest+json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8'
};

// ---- 偽の外部サービス -------------------------------------------

/** 日本時間で n 日後の 'YYYY-MM-DD' */
function tokyoDate(offsetDays) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function fakeResponse(code, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { getResponseCode: () => code, getContentText: () => text, getHeaders: () => ({}) };
}

/** 偽の Gemini（analyze）: 入力本文の先頭行をタイトルに、「日時」を含めば明日のイベントにする */
function fakeGeminiAnalyze(payload) {
  const parts = payload.contents[0].parts;
  const text = parts[0].text.split('本文:\n')[1] || '';
  const hasImage = parts.length > 1;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const isEvent = hasImage || /日時|開催/.test(text);
  // 「開催日時（開始）：2026-10-24 13:00」形式があれば、その日時を使う
  const start = text.match(/開催日時（開始）：\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  const end = text.match(/開催日時（終了）：\s*\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2})/);
  const hybrid = /現地|対面/.test(text) && /オンライン/.test(text);
  const area = (text.match(/高崎|神戸|渋谷/) || [''])[0];
  const result = {
    title: (lines[0] || 'チラシの告知').replace(/^【[^】]*】\s*/, '').slice(0, 30),
    summaryPoints: lines.slice(1, 4).length ? lines.slice(1, 4) : ['チラシの内容'],
    eventDate: start ? start[1] : (isEvent ? tokyoDate(1) : ''),
    startTime: start ? start[2] : (isEvent ? '19:00' : ''),
    endTime: end ? end[1] : '',
    attendance: !isEvent ? 'unknown' : (hybrid ? 'hybrid' : 'in_person'),
    area: isEvent ? (area || '神戸駅前') : '',
    // 本文の URL のうち、配信らしいものを参加 URL、フォームらしいものを申込 URL として返す
    joinUrl: (text.match(/https?:\/\/[^\s]*(youtube|youtu\.be|zoom\.us)[^\s]*/) || [''])[0],
    applyUrl: (text.match(/https?:\/\/[^\s]*(forms\.gle|docs\.google\.com\/forms)[^\s]*/) || [''])[0],
    deadline: '',
    performers: isEvent ? '山田太郎' : '',
    imageText: hasImage ? '（偽の読み取り結果）\n街頭演説会\n明日 19:00〜 神戸駅前' : '',
    // 画像のときは、わざと違う曜日を返して食い違いの警告を確かめられるようにする
    flyerWeekday: hasImage ? '日' : '',
    // 「または」があれば日時未確定として返す（それでも日付を入れてくる AI を想定し、日付は残す）
    dateUncertain: /または|いずれか/.test(text),
    dateNote: /または|いずれか/.test(text) ? '候補が複数あります（偽の応答）' : ''
  };
  const schema = payload.generationConfig.responseSchema.properties;
  if (schema.kind) { result.kind = isEvent ? 'schedule' : 'article'; }
  if (schema.category) { result.category = isEvent ? 'イベント' : 'お知らせ'; }
  if (schema.tags) { result.tags = []; }
  // 使用量の概算を確かめられるよう、本物と同じ形でトークン数も返す（本文の文字数を目安にする）
  return fakeResponse(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }], usageMetadata: { promptTokenCount: 1500 + text.length, candidatesTokenCount: 400, thoughtsTokenCount: 300 } });
}

/** 偽の Gemini（summarize）: 原文の前半を返す（数字が消えて警告が出ることもある） */
function fakeGeminiSummary(payload) {
  const text = payload.contents[0].parts[0].text;
  const summary = text.slice(0, Math.max(20, Math.floor(text.length / 2)));
  return fakeResponse(200, { candidates: [{ content: { parts: [{ text: summary }] } }], usageMetadata: { promptTokenCount: 300 + text.length, candidatesTokenCount: 500 } });
}

function fakeFetch(url, params) {
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    const payload = JSON.parse(params.payload);
    return payload.generationConfig.responseMimeType === 'application/json'
      ? fakeGeminiAnalyze(payload)
      : fakeGeminiSummary(payload);
  }
  if (url.startsWith('https://publish.twitter.com/oembed')) {
    return fakeResponse(200, {
      author_name: '山田太郎',
      html: '<blockquote><p lang="ja">明日19時から神戸駅前で街頭演説を行います。<br>日時: 明日 19:00〜<br>ぜひお越しください！</p>&mdash; 山田太郎</blockquote>'
    });
  }
  if (url.startsWith('https://note.com/api/v3/notes/')) {
    return fakeResponse(200, { data: {
      name: 'noteの記事タイトル',
      user: { nickname: '佐藤花子' },
      body: '<p>noteの記事の1段落目です。活動の報告をします。</p><p>2段落目です。参加者は120名でした。</p>'
    } });
  }
  if (params && params.followRedirects === false) { return fakeResponse(200, ''); }
  return fakeResponse(200, '<html><head><title>一般ページ</title></head><body><article><p>' +
    '一般ページの本文です。開催日時は10月10日18:30、定員50名です。'.repeat(3) + '</p></article></body></html>');
}

// ---- GAS のスタブ ------------------------------------------------

function createSheetStub() {
  const values = [];
  const store = (v) => (typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v);
  return {
    values,
    name: '',
    setName(name) { this.name = name; },
    appendRow(row) { values.push(row.map(store)); },
    deleteRow(n) { values.splice(n - 1, 1); },
    setFrozenRows() {},
    getLastRow() { return values.length; },
    // 見出し行など、いちばん長い行の長さ（実際のスプレッドシートの最終列に相当）
    getLastColumn() { return values.reduce((m, r) => Math.max(m, r ? r.length : 0), 0); },
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        clearContent() {
          for (let r = 0; r < numRows; r++) {
            const line = values[row - 1 + r];
            if (line) { for (let c = 0; c < numCols; c++) { line[col - 1 + c] = ''; } }
          }
          while (values.length && values[values.length - 1].every((v) => v === '' || v === undefined)) { values.pop(); }
        },
        setFontWeight() {},
        setWrapStrategy() {},
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const line = [];
            for (let c = 0; c < numCols; c++) {
              const v = values[row - 1 + r] ? values[row - 1 + r][col - 1 + c] : '';
              line.push(v === undefined || v === null ? '' : v);
            }
            out.push(line);
          }
          return out;
        },
        setValues(rows) {
          rows.forEach((line, r) => {
            while (values.length < row + r) { values.push([]); }
            line.forEach((v, c) => { values[row - 1 + r][col - 1 + c] = store(v); });
          });
        }
      };
    }
  };
}

// 公開用スプレッドシートの中身（GET /mock-public で確かめられる）
let devPublicSheets = {};

function createGasContext() {
  const sheets = {};
  // 公開用スプレッドシート（開発サーバーでは最初から用意し、書き写しを確かめられるようにする）
  const publicSheets = {};
  const publicFile = {
    getId: () => 'dev-public',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/dev-public/edit',
    getSheets: () => Object.values(publicSheets),
    getSheetByName: (name) => publicSheets[name] || null,
    insertSheet: (name) => { publicSheets[name] = createSheetStub(); publicSheets[name].name = name; return publicSheets[name]; }
  };
  devPublicSheets = publicSheets;
  // 公開の一覧（archive.html）も確かめられるよう、開発サーバーでは公開を有効にしておく
  const props = { SHARED_TOKEN: DEV_TOKEN, GEMINI_API_KEY: 'fake-key', ARCHIVE_PUBLIC: 'true', PUBLIC_SPREADSHEET_ID: 'dev-public' };
  const pad = (n) => String(n).padStart(2, '0');
  const context = {
    SpreadsheetApp: {
      WrapStrategy: { CLIP: 'CLIP' },
      openById: (id) => { if (id !== 'dev-public') { throw new Error('ファイルが見つかりません'); } return publicFile; },
      create: () => publicFile,
      getActiveSpreadsheet: () => ({
        getUrl: () => 'https://docs.google.com/spreadsheets/d/dev-sheet-id/edit',
        getSheetByName: (name) => sheets[name] || null,
        insertSheet: (name) => { sheets[name] = createSheetStub(); return sheets[name]; }
      })
    },
    UrlFetchApp: {
      fetch: (url, params) => fakeFetch(url, params || {}),
      fetchAll: (requests) => requests.map((r) => fakeFetch(r.url, r))
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      getUuid: () => require('node:crypto').randomUUID(),
      // 開発サーバーでは待たない（Gemini のやり直しの待ち時間）
      sleep: () => {},
      formatDate: (date, tz, pattern) => {
        const d = new Date(date.getTime() + 9 * 3600 * 1000);
        const map = {
          yyyy: d.getUTCFullYear(), MM: pad(d.getUTCMonth() + 1), dd: pad(d.getUTCDate()),
          HH: pad(d.getUTCHours()), mm: pad(d.getUTCMinutes()), ss: pad(d.getUTCSeconds())
        };
        return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, (k) => map[k]);
      }
    },
    Logger: { log: console.log },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => {
        const out = { getContent: () => text, setMimeType: () => out };
        return out;
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas', 'Config.gs'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas', 'Code.gs'), 'utf8'), context);
  // 議員名タグの確認用（Config.gs の初期値は空）
  vm.runInContext("if (!APP_CONFIG.legislators.length) { APP_CONFIG.legislators = ['山田太郎']; }", context);
  return context;
}

const gas = createGasContext();

// ---- HTTP サーバー -----------------------------------------------

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const urlPath = decodeURIComponent(requestUrl.pathname);

  // 公開の一覧の入口（GET ?action=archive）。合言葉なし
  // 開発用: 公開用スプレッドシートの「記録一覧」タブの中身を JSON で見る
  if (urlPath === '/mock-public' && req.method === 'GET') {
    const tab = devPublicSheets['記録一覧'];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(tab ? tab.values : []));
    return;
  }

  if (urlPath === '/mock-gas' && req.method === 'GET') {
    const parameter = Object.fromEntries(requestUrl.searchParams.entries());
    const output = gas.doGet({ parameter });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(output.getContent());
    return;
  }

  if (urlPath === '/mock-gas' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      // 実機の GAS に近い待ち時間を入れる（読み上げ・ボタンの状態を確かめるため）
      setTimeout(() => {
        const output = gas.doPost({ postData: { contents: body } });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(output.getContent());
      }, 600);
    });
    return;
  }

  const filePath = path.normalize(path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath));
  if (!filePath.startsWith(ROOT) || filePath.includes(path.join(ROOT, '.git'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`開発サーバー起動: http://localhost:${PORT}/`);
  console.log(`設定画面: GAS の URL = http://localhost:${PORT}/mock-gas ／ 合言葉 = ${DEV_TOKEN}`);
});

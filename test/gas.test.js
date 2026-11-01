// ============================================================
// gas/Code.gs（＋ Config.gs）のテスト
//
//   GAS のサービス（SpreadsheetApp・UrlFetchApp など）をスタブに差し替えた
//   vm コンテキストで本物のコードを実行し、doPost の経路を検証する。
//   重点: 合言葉未設定時の拒否、数式インジェクション対策、保存・検索・重複警告、
//   本文取得（Slack・X・note）と Gemini・Jev の呼び出し。
//
//   注意（LESSONS）: vm 内で作られたオブジェクトは JSON 経由で同じレルムにしてから
//   deepStrictEqual で比べる。
// ============================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TOKEN = 'test-token';
const CONFIG_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Config.gs'), 'utf8');
const CODE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');

// ---- スタブ ---------------------------------------------------

/**
 * インメモリのシート。実際のスプレッドシートと同じく、
 * 先頭がアポストロフィの文字列は「アポストロフィを除いた文字列」として保存される。
 * 書き込まれた生の値は raw に残し、テストで数式インジェクション対策を確認できるようにする。
 */
function createSheetStub() {
  const values = [];
  const raw = [];
  const store = (v) => (typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v);
  const sheet = {
    values,
    raw,
    appendRow(row) {
      raw.push(row.slice());
      values.push(row.map(store));
    },
    deleteRow(n) {
      values.splice(n - 1, 1);
      raw.splice(n - 1, 1);
    },
    setFrozenRows() {},
    getLastRow() { return values.length; },
    // 見出し行など、いちばん長い行の長さ（実際のスプレッドシートの最終列に相当）
    getLastColumn() { return values.reduce((m, r) => Math.max(m, r ? r.length : 0), 0); },
    setName(name) { sheet.name = name; },
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        clearContent() {
          for (let r = 0; r < numRows; r++) {
            const line = values[row - 1 + r];
            if (!line) { continue; }
            for (let c = 0; c < numCols; c++) { line[col - 1 + c] = ''; raw[row - 1 + r][col - 1 + c] = ''; }
          }
          // 末尾の空の行を詰める（実際の getLastRow と同じく、値のある最後の行を返すため）
          while (values.length && values[values.length - 1].every((v) => v === '' || v === undefined)) { values.pop(); raw.pop(); }
        },
        setFontWeight() {},
        setWrapStrategy(strategy) { sheet.wrap = strategy; },
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const line = [];
            for (let c = 0; c < numCols; c++) {
              const v = values[row - 1 + r] ? values[row - 1 + r][col - 1 + c] : undefined;
              line.push(v === undefined || v === null ? '' : v);
            }
            out.push(line);
          }
          return out;
        },
        setValues(rows) {
          rows.forEach((line, r) => {
            while (values.length < row + r) { values.push([]); raw.push([]); }
            line.forEach((v, c) => {
              values[row - 1 + r][col - 1 + c] = store(v);
              raw[row - 1 + r][col - 1 + c] = v;
            });
          });
        }
      };
    }
  };
  return sheet;
}

/** UrlFetchApp のレスポンス相当 */
function res(code, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    getResponseCode: () => code,
    getContentText: () => text,
    getHeaders: () => headers
  };
}

/** Gemini の generateContent 応答（JSON テキストを1パートで返す） */
function geminiRes(obj) {
  return res(200, { candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }] });
}

/**
 * Config.gs と Code.gs を読み込んだ vm コンテキストを作る。
 *   props: スクリプトプロパティ（既定は合言葉と Gemini キーを設定済み）
 *   fetch: (url, params) => レスポンス（fetch と fetchAll の両方で使う）
 */
function load({ props, fetch } = {}) {
  const scriptProps = Object.assign({ SHARED_TOKEN: TOKEN, GEMINI_API_KEY: 'gemini-key' }, props || {});
  Object.keys(scriptProps).forEach((k) => { if (scriptProps[k] === undefined) { delete scriptProps[k]; } });
  const calls = [];
  const sheets = {};
  let uuid = 0;
  let clock = 0;
  const handler = fetch || (() => { throw new Error('想定外の通信'); });
  // 公開用スプレッドシートなど、別のファイル（id → { sheets }）
  const files = {};
  let fileCounter = 0;
  const makeFile = (id) => {
    const fileSheets = { 'シート1': createSheetStub() };
    const file = {
      id,
      sheets: fileSheets,
      getId: () => id,
      getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
      getSheets: () => Object.values(fileSheets),
      getSheetByName: (name) => Object.values(fileSheets).find((sh) => (sh.name || Object.keys(fileSheets).find((k) => fileSheets[k] === sh)) === name) || null,
      insertSheet: (name) => { const sh = createSheetStub(); sh.name = name; fileSheets[name] = sh; return sh; }
    };
    fileSheets['シート1'].name = 'シート1';
    files[id] = file;
    return file;
  };
  const context = {
    SpreadsheetApp: {
      WrapStrategy: { CLIP: 'CLIP', WRAP: 'WRAP', OVERFLOW: 'OVERFLOW' },
      openById: (id) => {
        if (!files[id]) { throw new Error('スタブ: ファイルが見つかりません ' + id); }
        return files[id];
      },
      create: () => makeFile('public-' + (++fileCounter)),
      getActiveSpreadsheet: () => ({
        getUrl: () => 'https://docs.google.com/spreadsheets/d/test-sheet-id/edit',
        getSheetByName: (name) => sheets[name] || null,
        insertSheet: (name) => { sheets[name] = createSheetStub(); return sheets[name]; }
      })
    },
    UrlFetchApp: {
      fetch(url, params) {
        calls.push(Object.assign({ url }, params || {}));
        return handler(url, params || {});
      },
      fetchAll(requests) {
        return requests.map((r) => {
          calls.push(r);
          return handler(r.url, r);
        });
      }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (Object.prototype.hasOwnProperty.call(scriptProps, k) ? scriptProps[k] : null),
        setProperty: (k, v) => { scriptProps[k] = v; }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      getUuid: () => 'uuid-' + (++uuid),
      // 本物と同じく、符号つきのバイト列（-128〜127）で返す
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (algorithm, value) => Array.from(require('node:crypto').createHash('sha256').update(String(value), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      // 待つ時間は記録だけして、実際には待たない
      sleep: (ms) => { calls.push({ sleep: ms }); },
      // 保存のたびに1秒進む固定の時計（日時の文字列が決定的になるように）
      formatDate: (date, tz, pattern) => {
        if (pattern === 'yyyy-MM-dd') { return '2026-10-02'; }
        if (pattern === 'yyyy-MM') { return '2026-10'; }
        clock++;
        return '2026-10-02 10:00:' + String(clock).padStart(2, '0');
      }
    },
    Logger: { log() {} },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => {
        const out = { getContent: () => text, setMimeType: () => out };
        return out;
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(CONFIG_SOURCE, context);
  vm.runInContext(CODE_SOURCE, context);
  return {
    context, calls, props: scriptProps, files, makeFile,
    sheet: () => sheets['投稿一覧'],
    usageSheet: () => sheets['利用量']
  };
}

/** doPost を呼んで JSON を返す（合言葉は既定で正しいものを付ける） */
function post(env, body, token = TOKEN) {
  const payload = Object.assign({}, body);
  if (token !== null) { payload.token = token; }
  return JSON.parse(env.context.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
}

/** 見出しの名前で、シートのセルの値を読む（rowIndex は 0 が見出し行。raw=true なら書き込まれた生の値） */
function cell(env, rowIndex, headerName, raw = false) {
  const header = Array.from(env.sheet().values[0]);
  const index = header.indexOf(headerName);
  assert.ok(index !== -1, '見出し「' + headerName + '」が無い');
  const rows = raw ? env.sheet().raw : env.sheet().values;
  return rows[rowIndex][index];
}

/** 保存用の最小限の正しい入力 */
function validPost(overrides = {}) {
  return Object.assign({
    action: 'save', kind: 'article', source: 'slack', category: 'お知らせ',
    title: 'タイトル', summary: '概略', url: 'https://example.com/a', original: '原文',
    tags: [], eventIso: '', place: '', deadline: '', performers: '', memo: ''
  }, overrides);
}

// ---- 合言葉 -----------------------------------------------------

test('合言葉（SHARED_TOKEN）が未設定なら、すべての action を拒否し、通信もシート操作もしない', () => {
  const env = load({ props: { SHARED_TOKEN: undefined } });
  for (const action of ['bootstrap', 'analyze', 'summarize', 'save', 'update', 'delete', 'search', 'addTag']) {
    const r = post(env, { action, text: '本文', title: 'x' }, '');
    assert.strictEqual(r.ok, false, action);
    assert.match(r.error, /SHARED_TOKEN（合言葉）が未設定/, action);
  }
  // 空文字の合言葉を送っても素通しにならない
  assert.strictEqual(post(env, { action: 'bootstrap' }, '').ok, false);
  assert.strictEqual(env.calls.length, 0);
  assert.strictEqual(env.sheet(), undefined);
});

test('合言葉が空白だけの設定も未設定として扱う', () => {
  const env = load({ props: { SHARED_TOKEN: '   ' } });
  assert.match(post(env, { action: 'bootstrap' }, '   ').error, /未設定/);
});

test('合言葉が違う・無い・文字列でないときは拒否する', () => {
  const env = load();
  assert.match(post(env, { action: 'bootstrap' }, 'wrong').error, /合言葉が一致しません/);
  assert.match(post(env, { action: 'bootstrap' }, null).error, /合言葉が一致しません/);
  const r = JSON.parse(env.context.doPost({ postData: { contents: JSON.stringify({ action: 'bootstrap', token: ['test-token'] }) } }).getContent());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(post(env, { action: 'bootstrap' }).ok, true);
});

test('doGet はデータを返さない／不正な JSON・不明な action はエラー', () => {
  const env = load();
  const r = JSON.parse(env.context.doGet({ parameter: { action: 'search', token: TOKEN } }).getContent());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.items, undefined);
  assert.match(JSON.parse(env.context.doPost({ postData: { contents: '{' } }).getContent()).error, /JSON が不正/);
  assert.match(post(env, { action: 'unknown' }).error, /不明な action/);
});

test('bootstrap: 設定・カテゴリ・タグを返し、API キーそのものは返さない', () => {
  const env = load({ props: { TYPESAFE_API_KEY: 'jev-secret' } });
  const r = post(env, { action: 'bootstrap' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.categories, ['イベント', '活動報告', 'お知らせ', '政策・記事', 'その他']);
  assert.strictEqual(r.geminiConfigured, true);
  assert.strictEqual(r.jevConfigured, true);
  assert.strictEqual(r.model, 'gemini-3.1-flash-lite');
  const text = JSON.stringify(r);
  assert.ok(!text.includes('gemini-key') && !text.includes('jev-secret') && !text.includes(TOKEN));
});

// ---- 保存と数式インジェクション対策 -----------------------------------

test('数式インジェクション対策: = + - @ で始まる値も、日付風の値も、文字列として書き込まれ元の値で読み戻せる', () => {
  const env = load();
  const dangerous = {
    title: '=IMPORTXML("https://evil.example/","//a")',
    summary: '+SUM(1,2)',
    original: '-1+2\n=HYPERLINK("https://evil.example")',
    memo: '@メンション',
    place: '2026-10-03',
    performers: '0120-000-000'
  };
  const r = post(env, validPost(dangerous));
  assert.strictEqual(r.ok, true, r.error);
  const rawRow = env.sheet().raw[1];
  rawRow.forEach((cell) => {
    if (cell !== '') { assert.strictEqual(cell.charAt(0), "'", '空でないセルはすべてアポストロフィ付き: ' + cell); }
  });
  const item = post(env, { action: 'search' }).items[0];
  for (const key of Object.keys(dangerous)) {
    assert.strictEqual(item[key], dangerous[key], key);
  }
});

test('save: 1行1件で、見出しの名前どおりの列に書き込む（新しいシートは発信者が種別とソースの間）', () => {
  const env = load();
  const r = post(env, validPost({ kind: 'schedule', tags: [], eventIso: '2026-10-03T19:00+09:00', deadline: '2026-10-01', memo: 'メモ', author: '運営アカウント' }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Array.from(env.sheet().values[0]), [
    '登録日時', '種別', '発信者', 'ソース', 'カテゴリ', 'タイトル', '概略', 'URL',
    'スレッド詳細（原文）', 'タグ', '開催日時（ISO）', '場所', '申込締切', '出演者', 'コメント', 'ID',
    'トーク本文', '参加URL', '申込URL', '発信日', '保存者ID'
  ]);
  assert.strictEqual(cell(env, 1, '種別'), 'スケジュール');
  assert.strictEqual(cell(env, 1, '発信者'), '運営アカウント');
  assert.strictEqual(cell(env, 1, 'ソース'), 'Slack');
  assert.strictEqual(cell(env, 1, '開催日時（ISO）'), '2026-10-03T19:00+09:00');
  assert.strictEqual(cell(env, 1, '申込締切'), '2026-10-01');
  assert.strictEqual(cell(env, 1, 'ID'), r.id);
});

test('save: 入力の検証（タイトル・種別・カテゴリ・タグ・日時の形式・存在しない日付）', () => {
  const env = load();
  assert.match(post(env, validPost({ title: '  ' })).error, /タイトル/);
  assert.match(post(env, validPost({ kind: 'xxx' })).error, /種別/);
  assert.match(post(env, validPost({ source: 'xxx' })).error, /入力元/);
  assert.match(post(env, validPost({ category: '未登録' })).error, /カテゴリ/);
  assert.match(post(env, validPost({ tags: ['未登録タグ'] })).error, /不明なタグ/);
  assert.match(post(env, validPost({ url: 'javascript:alert(1)' })).error, /URL/);
  assert.match(post(env, validPost({ eventIso: '2026/10/03' })).error, /開催日時の形式/);
  assert.match(post(env, validPost({ eventIso: '2026-02-30' })).error, /存在しない日付/);
  assert.match(post(env, validPost({ deadline: '2026-13-01' })).error, /申込締切/);
  assert.match(post(env, validPost({ original: 'あ'.repeat(50000) })).error, /長すぎます/);
  assert.strictEqual(post(env, validPost({ original: 'あ'.repeat(49999) })).ok, true);
});

test('save: 議員名一覧にある名前はタグとして保存できる', () => {
  const env = load();
  vm.runInContext("APP_CONFIG.legislators = ['山田太郎']", env.context);
  assert.strictEqual(post(env, validPost({ tags: ['山田太郎'] })).ok, true);
});

test('save: 同じ URL は警告して止め、force=true なら保存する（twitter.com と x.com、追跡パラメーターの違いも同じとみなす）', () => {
  const env = load();
  assert.strictEqual(post(env, validPost({ url: 'https://x.com/user/status/123' })).ok, true);
  const dup = post(env, validPost({ url: 'https://twitter.com/user/status/123/?s=20&utm_source=line' }));
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.duplicate.title, 'タイトル');
  assert.match(dup.error, /同じ URL/);
  assert.strictEqual(env.sheet().values.length, 2);
  assert.strictEqual(post(env, validPost({ url: 'https://twitter.com/user/status/123', force: true })).ok, true);
  assert.strictEqual(env.sheet().values.length, 3);
  // URL が空の投稿どうしは重複扱いしない
  assert.strictEqual(post(env, validPost({ url: '' })).ok, true);
  assert.strictEqual(post(env, validPost({ url: '' })).ok, true);
});

test('normalizeUrlForCompare_: 正規化の規則', () => {
  const { context } = load();
  const n = context.normalizeUrlForCompare_;
  assert.strictEqual(n('https://WWW.Example.com/a/?utm_source=x&b=2&a=1#top'), 'example.com/a?a=1&b=2');
  assert.strictEqual(n('http://example.com/a'), n('https://example.com/a/'));
  assert.notStrictEqual(n('https://example.com/a?id=1'), n('https://example.com/a?id=2'));
  assert.strictEqual(n(''), '');
  assert.strictEqual(n('not a url'), '');
});

// ---- 編集・削除・検索 --------------------------------------------

test('update: 登録日時と ID は変えずに内容を書き換える／delete: 行を消す', () => {
  const env = load();
  const saved = post(env, validPost());
  const savedAt = cell(env, 1, '登録日時');
  const r = post(env, validPost({ action: 'update', id: saved.id, title: '新タイトル', memo: '=1+1' }));
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(cell(env, 1, '登録日時'), savedAt);
  assert.strictEqual(cell(env, 1, 'タイトル'), '新タイトル');
  assert.strictEqual(cell(env, 1, 'コメント'), '=1+1');
  assert.strictEqual(cell(env, 1, 'コメント', true), "'=1+1");
  assert.strictEqual(cell(env, 1, 'ID'), saved.id);
  assert.match(post(env, validPost({ action: 'update', id: 'none' })).error, /見つかりません/);
  assert.strictEqual(post(env, { action: 'delete', id: saved.id }).ok, true);
  assert.strictEqual(env.sheet().values.length, 1);
  assert.match(post(env, { action: 'delete', id: saved.id }).error, /見つかりません/);
});

test('update: 自分自身の URL は重複扱いしないが、ほかの投稿と同じ URL にすると警告する', () => {
  const env = load();
  const a = post(env, validPost({ url: 'https://example.com/a' }));
  post(env, validPost({ url: 'https://example.com/b' }));
  assert.strictEqual(post(env, validPost({ action: 'update', id: a.id, url: 'https://example.com/a' })).ok, true);
  assert.strictEqual(post(env, validPost({ action: 'update', id: a.id, url: 'https://example.com/b' })).ok, false);
});

test('右側（申込URL の右）に列を追加しても、読み取り・編集は壊れず追加列の値も残る', () => {
  const env = load();
  const saved = post(env, validPost());
  env.sheet().values[0][19] = '投稿済み';
  env.sheet().values[1][19] = 'TRUE';
  assert.strictEqual(post(env, { action: 'search' }).items[0].id, saved.id);
  assert.strictEqual(post(env, validPost({ action: 'update', id: saved.id, title: '更新' })).ok, true);
  assert.strictEqual(env.sheet().values[1][19], 'TRUE');
});

test('既存のシート（以前の15列の並び）には、足りない見出しを右端に足し、古い行も新しい行も名前どおりに読み書きする', () => {
  const env = load();
  post(env, validPost({ url: '' })); // シートを作らせる
  const oldHeader = ['登録日時', '種別', 'ソース', 'カテゴリ', 'タイトル', '概略', 'URL',
    'スレッド詳細（原文）', 'タグ', '開催日時（ISO）', '場所', '申込締切', '出演者', 'メモ', 'ID'];
  const oldRow = ['2026-10-01 10:00:00', '記事', 'note', 'お知らせ', '古い行', '概略', 'https://example.com/old',
    '原文', '', '', '', '', '', '', 'old-id'];
  env.sheet().values.length = 0;
  env.sheet().raw.length = 0;
  env.sheet().values.push(oldHeader.slice(), oldRow.slice());
  env.sheet().raw.push(oldHeader.slice(), oldRow.slice());

  const item = post(env, { action: 'search' }).items[0];
  assert.strictEqual(item.title, '古い行');
  assert.strictEqual(item.source, 'note');
  assert.strictEqual(item.author, '');
  assert.deepStrictEqual(Array.from(env.sheet().values[0]).slice(15), ['発信者', 'トーク本文', '参加URL', '申込URL', '発信日', '保存者ID']);

  assert.strictEqual(post(env, validPost({ url: '', title: '新しい行', author: '運営アカウント', talk: 'トーク' })).ok, true);
  assert.strictEqual(cell(env, 2, 'タイトル'), '新しい行');
  assert.strictEqual(cell(env, 2, '発信者'), '運営アカウント');
  assert.strictEqual(cell(env, 2, 'トーク本文'), 'トーク');
  assert.strictEqual(cell(env, 1, '発信者'), undefined, '古い行の新しい列は空のまま');
});

test('列を並べ替えても、自分で足した列がどこにあっても、名前どおりに読み書きし、足した列には触らない', () => {
  const env = load();
  post(env, validPost({ url: '' })); // シートを作らせる
  // 発信者を2列目へ移し、4列目に自分の列「投稿済み」を足したシートを再現する
  const header = ['登録日時', '発信者', '種別', '投稿済み', 'ソース', 'カテゴリ', 'タイトル', '概略', 'URL',
    'スレッド詳細（原文）', 'タグ', '開催日時（ISO）', '場所', '申込締切', '出演者', 'メモ', 'ID',
    'トーク本文', '参加URL', '申込URL', '発信日', '保存者ID'];
  env.sheet().values.length = 0;
  env.sheet().raw.length = 0;
  env.sheet().values.push(header.slice());
  env.sheet().raw.push(header.slice());

  const saved = post(env, validPost({ url: '', title: 'A', author: '須田英太郎', kind: 'legislator', source: 'note' }));
  assert.strictEqual(saved.ok, true, saved.error);
  assert.strictEqual(cell(env, 1, '発信者'), '須田英太郎');
  assert.strictEqual(cell(env, 1, '種別'), '議員活動');
  assert.strictEqual(cell(env, 1, 'ソース'), 'note');
  assert.strictEqual(cell(env, 1, '投稿済み'), '', '自分の列は空欄のまま');
  assert.strictEqual(env.sheet().values[0].length, header.length, '見出しは増えない');

  // 自分の列に値を入れてから編集しても、その値は残る
  env.sheet().values[1][3] = 'TRUE';
  assert.strictEqual(post(env, validPost({ action: 'update', id: saved.id, url: '', title: 'A2', author: '広報', kind: 'legislator', source: 'note' })).ok, true);
  assert.strictEqual(cell(env, 1, '投稿済み'), 'TRUE');
  assert.strictEqual(cell(env, 1, 'タイトル'), 'A2');
  assert.strictEqual(cell(env, 1, '発信者'), '広報');
  const item = post(env, { action: 'search' }).items[0];
  assert.deepStrictEqual([item.title, item.author, item.kind, item.source], ['A2', '広報', 'legislator', 'note']);
});

test('同じ見出しが2つあれば左の列を使い、見出しが空の列や知らない見出しの列は無視する', () => {
  const env = load();
  post(env, validPost({ url: '' }));
  const { context } = env;
  const sheet = env.sheet();
  sheet.values.length = 0;
  sheet.raw.length = 0;
  sheet.values.push(['タイトル', '', 'タイトル', '別の列']);
  sheet.raw.push(sheet.values[0].slice());
  const ctx = context.openSheet_();
  assert.strictEqual(ctx.cols.title, 1);
  // 足りない項目は右端（5列目以降）に足される
  assert.strictEqual(ctx.cols.savedAt, 5);
  assert.strictEqual(Array.from(sheet.values[0]).length, 4 + 20);
});

test('種別: 画面から追加でき、AI の選択肢・保存・検索・bootstrap に反映される。組み込みは消せない', () => {
  const env = load();
  const added = post(env, { action: 'addKind', label: '募集', description: 'ボランティアの募集', schedule: false });
  assert.strictEqual(added.ok, true);
  const kind = added.kinds.find((k) => k.label === '募集');
  assert.ok(kind && kind.key && kind.builtin === false && kind.schedule === false);
  assert.strictEqual(added.kinds.filter((k) => k.builtin).length, 3);
  assert.deepStrictEqual(post(env, { action: 'bootstrap' }).config.kinds.map((k) => k.label), ['スケジュール', '記事', '議員活動', '募集']);

  // 保存でき、一覧でも同じ種別で読み戻せる。種別で検索もできる
  assert.strictEqual(post(env, validPost({ title: '募集の記録', url: '', kind: kind.key })).ok, true);
  assert.deepStrictEqual(post(env, { action: 'search', kind: kind.key }).items.map((i) => i.title), ['募集の記録']);

  // 重複・空・組み込みの削除は拒否する
  assert.match(post(env, { action: 'addKind', label: '募集' }).error, /同じ名前/);
  assert.match(post(env, { action: 'addKind', label: '記事' }).error, /同じ名前/);
  assert.match(post(env, { action: 'addKind', label: '  ' }).error, /入力してください/);
  assert.match(post(env, { action: 'removeKind', key: 'article' }).error, /組み込み/);
  assert.match(post(env, { action: 'removeKind', key: 'nothing' }).error, /存在しない/);

  const removed = post(env, { action: 'removeKind', key: kind.key });
  assert.deepStrictEqual(removed.kinds.map((k) => k.label), ['スケジュール', '記事', '議員活動']);
});

test('種別: 日時あり（schedule）で追加した種別は schedule フラグを持つ', () => {
  const env = load();
  const added = post(env, { action: 'addKind', label: '講座', schedule: true });
  assert.strictEqual(added.kinds.find((k) => k.label === '講座').schedule, true);
  assert.strictEqual(added.kinds.find((k) => k.label === '講座').description, '講座');
});

test('search: 新しい順・キーワードは原文も対象・カテゴリ/種別/タグで絞り込み・50件ずつ', () => {
  const env = load();
  post(env, { action: 'addTag', name: '街頭' });
  post(env, { action: 'addTag', name: '神戸' });
  post(env, validPost({ title: '古い', url: '', original: '原文にだけある語ABC', tags: ['街頭'] }));
  post(env, validPost({ title: '新しい', url: '', category: 'イベント', kind: 'schedule', tags: ['街頭', '神戸'] }));
  assert.deepStrictEqual(post(env, { action: 'search' }).items.map((i) => i.title), ['新しい', '古い']);
  assert.deepStrictEqual(post(env, { action: 'search', keyword: 'abc' }).items.map((i) => i.title), ['古い']);
  assert.deepStrictEqual(post(env, { action: 'search', category: 'イベント' }).items.map((i) => i.title), ['新しい']);
  assert.deepStrictEqual(post(env, { action: 'search', kind: 'article' }).items.map((i) => i.title), ['古い']);
  // タグは既定が OR（どれか1つでも持つ）。tagMode 'and' ならすべてを持つものだけ
  assert.deepStrictEqual(post(env, { action: 'search', tags: ['街頭', '神戸'] }).items.map((i) => i.title), ['新しい', '古い']);
  assert.deepStrictEqual(post(env, { action: 'search', tags: ['神戸'] }).items.map((i) => i.title), ['新しい']);
  assert.deepStrictEqual(post(env, { action: 'search', tags: ['街頭', '神戸'], tagMode: 'or' }).items.map((i) => i.title), ['新しい', '古い']);
  assert.deepStrictEqual(post(env, { action: 'search', tags: ['街頭', '神戸'], tagMode: 'and' }).items.map((i) => i.title), ['新しい']);
  for (let i = 0; i < 55; i++) { post(env, validPost({ url: '', title: 'n' + i })); }
  const page1 = post(env, { action: 'search' });
  assert.strictEqual(page1.items.length, 50);
  assert.strictEqual(page1.hasMore, true);
  const page2 = post(env, { action: 'search', offset: 50 });
  assert.strictEqual(page2.items.length, 7);
  assert.strictEqual(page2.hasMore, false);
});

// ---- カテゴリ・タグ管理 ----------------------------------------------

test('カテゴリ・タグ: 追加・重複拒否・削除・並べ替え（集合が違えば拒否）・最後のカテゴリは消せない', () => {
  const env = load();
  assert.deepStrictEqual(post(env, { action: 'addTag', name: 'a,b' }).tags, ['a、b']);
  assert.match(post(env, { action: 'addTag', name: 'a,b' }).error, /すでにあります/);
  assert.deepStrictEqual(post(env, { action: 'addTag', name: 'c' }).tags, ['a、b', 'c']);
  assert.deepStrictEqual(post(env, { action: 'reorderTags', tags: ['c', 'a、b'] }).tags, ['c', 'a、b']);
  assert.match(post(env, { action: 'reorderTags', tags: ['c'] }).error, /一致しません/);
  assert.deepStrictEqual(post(env, { action: 'removeTag', name: 'c' }).tags, ['a、b']);
  const cats = post(env, { action: 'bootstrap' }).categories;
  cats.slice(1).forEach((name) => post(env, { action: 'removeCategory', name }));
  assert.match(post(env, { action: 'removeCategory', name: cats[0] }).error, /1つ以上必要/);
});

// ---- analyze ------------------------------------------------------

/** analyze の Gemini 応答のひな形 */
function geminiAnalyze(overrides = {}) {
  return Object.assign({
    title: '街頭演説', summaryPoints: ['1行目', '2行目', '3行目'], kind: 'schedule',
    eventDate: '2026-10-03', startTime: '19:00', endTime: '', attendance: 'in_person', area: '神戸駅前', deadline: '',
    performers: '山田太郎', imageText: '', flyerWeekday: '', category: 'イベント', tags: []
  }, overrides);
}

test('analyze: AI がテレビ出演をオンラインと判定しても、原文にテレビ局の手がかりがあれば「テレビ」にする', () => {
  const run = (text, extra) => {
    const env = load({ fetch: () => geminiRes(geminiAnalyze(Object.assign({ attendance: 'online', area: '', title: '番組出演' }, extra))) });
    return post(env, { action: 'analyze', text }).event.place;
  };
  assert.strictEqual(run('安野貴博党首 BS-TBS「報道1930」出演（19:30〜）'), 'テレビ');
  assert.strictEqual(run('今夜、地上波の番組に出演します'), 'テレビ');
  assert.strictEqual(run('テレビ出演のお知らせ', { attendance: 'unknown' }), 'テレビ');
  assert.strictEqual(run('YouTube で配信します'), 'オンライン', '手がかりが無ければそのまま');
  assert.strictEqual(run('ABS 勉強会をオンラインで開催'), 'オンライン', '英字に続く BS は対象外');
  assert.strictEqual(run('テレビ局の見学会（現地）', { attendance: 'in_person', area: '東京' }), '対面（東京）', '対面は変えない');
});

test('analyze: Slack の URL だけなら、通信せず（Gemini も呼ばず）貼り付けを促す', () => {
  const env = load();
  const r = post(env, { action: 'analyze', url: 'https://team.slack.com/archives/C1/p123' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fetchStatus, 'needs_paste');
  assert.strictEqual(r.source, 'slack');
  assert.strictEqual(r.analyzed, false);
  assert.match(r.warnings[0], /Slack/);
  assert.strictEqual(env.calls.length, 0);
});

test('analyze: 本文を Gemini に渡し、結果を検証して返す（不正な日付・未登録カテゴリは空にする）', () => {
  const env = load({
    fetch: () => geminiRes(geminiAnalyze({ deadline: '2026-02-30', category: '存在しない', endTime: '25:00', flyerWeekday: '(土)' }))
  });
  vm.runInContext("APP_CONFIG.legislators = ['山田太郎', '佐藤花子']", env.context);
  const text = '10月3日19時から神戸駅前で山田太郎が街頭演説します。';
  const r = post(env, { action: 'analyze', source: 'slack', text });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.analyzed, true);
  assert.strictEqual(r.originalText, text);
  assert.strictEqual(r.title, '街頭演説');
  assert.strictEqual(r.kind, 'schedule');
  assert.strictEqual(r.event.date, '2026-10-03');
  assert.strictEqual(r.event.deadline, '');
  assert.strictEqual(r.event.endTime, '');
  assert.strictEqual(r.flyerWeekday, '土');
  assert.strictEqual(r.category, '');
  assert.deepStrictEqual(r.legislatorTags, ['山田太郎']);

  const call = env.calls[0];
  assert.match(call.url, /models\/gemini-3\.1-flash-lite:generateContent$/);
  assert.strictEqual(call.headers['x-goog-api-key'], 'gemini-key');
  const payload = JSON.parse(call.payload);
  assert.strictEqual(payload.generationConfig.responseMimeType, 'application/json');
  assert.ok(payload.generationConfig.responseSchema.properties.kind, 'Jev が無いときは Gemini が分類する');
  assert.ok(payload.contents[0].parts[0].text.includes(text));
  assert.ok(payload.systemInstruction.parts[0].text.includes('2026-10-02'), '今日の日付を渡して絶対日付にさせる');
});

test('analyze: LLM に渡す本文は設定の文字数で切り、原文は切らずに返す', () => {
  const env = load({ fetch: () => geminiRes(geminiAnalyze()) });
  const text = 'あ'.repeat(7000);
  const r = post(env, { action: 'analyze', source: 'other', text });
  assert.strictEqual(r.originalText.length, 7000);
  const sent = JSON.parse(env.calls[0].payload).contents[0].parts[0].text;
  assert.ok(sent.includes('あ'.repeat(6000)) && !sent.includes('あ'.repeat(6001)));
});

test('analyze: GEMINI_MODEL を設定すればそのモデルを使う／キーが無ければエラー', () => {
  const env = load({ props: { GEMINI_MODEL: 'gemini-3.5-flash-lite' }, fetch: () => geminiRes(geminiAnalyze()) });
  post(env, { action: 'analyze', text: '本文' });
  assert.match(env.calls[0].url, /gemini-3\.5-flash-lite:generateContent/);
  const noKey = load({ props: { GEMINI_API_KEY: undefined } });
  assert.match(post(noKey, { action: 'analyze', text: '本文' }).error, /GEMINI_API_KEY/);
});

test('analyze: Gemini の HTTP エラー・ブロック・壊れた JSON は日本語のエラーにする', () => {
  assert.match(post(load({ fetch: () => res(400, 'bad request') }), { action: 'analyze', text: '本文' }).error, /Gemini API エラー（HTTP 400）/);
  assert.match(post(load({ fetch: () => res(200, { promptFeedback: { blockReason: 'SAFETY' } }) }), { action: 'analyze', text: '本文' }).error, /SAFETY/);
  assert.match(post(load({ fetch: () => geminiRes('{壊れた') }), { action: 'analyze', text: '本文' }).error, /JSON として読めません/);
});

test('analyze: 思考パート（thought）は結果に混ぜない', () => {
  const env = load({
    fetch: () => res(200, { candidates: [{ content: { parts: [{ text: '考え中', thought: true }, { text: JSON.stringify(geminiAnalyze()) }] } }] })
  });
  assert.strictEqual(post(env, { action: 'analyze', text: '本文' }).title, '街頭演説');
});

test('analyze: Jev のキーがあれば Gemini と並列（fetchAll）で呼び、種別・カテゴリ・タグは Jev の結果を使う', () => {
  const env = load({
    props: { TYPESAFE_API_KEY: 'jev-key' },
    fetch: (url) => {
      if (url.includes('typesafe')) {
        return res(200, { answers: {
          kind: { type: 'choice', choice: 'c1' },
          category: { type: 'choice', choice: 'c3' },
          tag_0: { type: 'noul', noul: 0.9 },
          tag_1: { type: 'noul', noul: 0.2 }
        } });
      }
      return geminiRes(geminiAnalyze({ kind: undefined, category: undefined }));
    }
  });
  post(env, { action: 'addTag', name: '政策' });
  post(env, { action: 'addTag', name: '街頭' });
  env.calls.length = 0;
  const r = post(env, { action: 'analyze', text: '本文'.repeat(5000) });
  assert.strictEqual(env.calls.length, 2);
  const geminiPayload = JSON.parse(env.calls[0].payload);
  assert.ok(geminiPayload.generationConfig.responseSchema.properties.kind, 'Jev が失敗したときの予備として Gemini にも分類させる');
  const jevPayload = JSON.parse(env.calls[1].payload);
  assert.strictEqual(env.calls[1].headers.Authorization, 'Bearer jev-key');
  assert.strictEqual(jevPayload.state.text.length, 8000, 'Jev に渡す本文は設定の文字数で切る');
  assert.strictEqual(r.kind, 'article');
  assert.strictEqual(r.category, '政策・記事');
  assert.deepStrictEqual(r.tags, ['政策']);
});

test('analyze: Jev が失敗しても全体は失敗にせず、Gemini の分類を使って警告を返す', () => {
  const env = load({
    props: { TYPESAFE_API_KEY: 'jev-key' },
    fetch: (url) => (url.includes('typesafe') ? res(500, 'error') : geminiRes(geminiAnalyze({ kind: 'article', category: 'お知らせ' })))
  });
  const r = post(env, { action: 'analyze', text: '本文' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'article');
  assert.strictEqual(r.category, 'お知らせ');
  assert.ok(r.warnings.some((w) => /Jev による分類に失敗したため、Gemini の判定を使いました/.test(w)));
  assert.ok(r.warnings.some((w) => /testJev/.test(w)));
});

test('analyze: Jev が種別を決められなかった項目は Gemini の判定で埋める', () => {
  const env = load({
    props: { TYPESAFE_API_KEY: 'jev-key' },
    fetch: (url) => (url.includes('typesafe')
      ? res(200, { answers: { kind: { type: 'choice', choice: 'c99' } } })
      : geminiRes(geminiAnalyze({ kind: 'schedule', category: 'イベント' })))
  });
  const r = post(env, { action: 'analyze', text: '本文' });
  assert.strictEqual(r.kind, 'schedule');
  assert.strictEqual(r.category, 'イベント');
});

test('analyze: 種別が決まらなくても開催日が取れていればスケジュール型にする（日時の行を出すため）', () => {
  const env = load({ fetch: () => geminiRes(geminiAnalyze({ kind: '不明な値' })) });
  assert.strictEqual(post(env, { action: 'analyze', text: '本文' }).kind, 'schedule');
  const env2 = load({ fetch: () => geminiRes(geminiAnalyze({ kind: '不明な値', eventDate: '' })) });
  assert.strictEqual(post(env2, { action: 'analyze', text: '本文' }).kind, '');
});

test('analyze: X の URL は oEmbed で本文と投稿者名を取り、末尾が「…」なら途中切れを警告する', () => {
  const oembed = (text) => res(200, {
    author_name: '山田太郎',
    html: '<blockquote class="twitter-tweet"><p lang="ja" dir="ltr">' + text + '</p>&mdash; 山田太郎 (@yamada) <a href="https://x.com/yamada/status/1">2026</a></blockquote>'
  });
  const env = load({
    fetch: (url) => {
      if (url.startsWith('https://publish.twitter.com/')) { return oembed('明日は&amp;街頭演説<br>よろしく&#x1F600;'); }
      if (url.startsWith('https://x.com/')) { return res(200, ''); }
      return geminiRes(geminiAnalyze());
    }
  });
  vm.runInContext("APP_CONFIG.legislators = ['山田太郎']", env.context);
  const r = post(env, { action: 'analyze', url: 'https://x.com/yamada/status/1' });
  assert.strictEqual(r.source, 'x');
  assert.strictEqual(r.author, '山田太郎');
  // 本文に名前が無くても、投稿者名が議員名一覧と一致すればタグを付ける
  assert.deepStrictEqual(r.legislatorTags, ['山田太郎']);
  assert.strictEqual(r.originalText, '明日は&街頭演説\nよろしく😀');
  assert.strictEqual(r.fetchStatus, 'ok');

  const cut = load({
    fetch: (url) => (url.startsWith('https://publish.twitter.com/') ? oembed('長い投稿の途中まで…') : (url.startsWith('https://x.com/') ? res(200, '') : geminiRes(geminiAnalyze())))
  });
  const r2 = post(cut, { action: 'analyze', url: 'https://x.com/a/status/2' });
  assert.ok(r2.warnings.some((w) => /途中までしか取得できません/.test(w)));
});

test('analyze: 共有された本文のほうが長ければ、取得した本文より優先する（X の全文貼り付け）', () => {
  const env = load({
    fetch: (url) => {
      if (url.startsWith('https://publish.twitter.com/')) { return res(200, { author_name: 'A', html: '<p>短い…</p>' }); }
      if (url.startsWith('https://x.com/')) { return res(200, ''); }
      return geminiRes(geminiAnalyze());
    }
  });
  const pasted = '貼り付けた全文です。'.repeat(10);
  assert.strictEqual(post(env, { action: 'analyze', url: 'https://x.com/a/status/1', text: pasted }).originalText, pasted);
});

test('analyze: note の記事は記事 API から本文と著者名を取る', () => {
  const body = '<p name="a">noteの本文1段落目です。十分な長さの文章をここに書いています。</p><p name="b">2段落目<br>改行あり</p>';
  const env = load({
    fetch: (url) => {
      if (url === 'https://note.com/api/v3/notes/nabc123') {
        return res(200, { data: { name: '記事名', body, user: { nickname: '佐藤' } } });
      }
      if (url.startsWith('https://note.com/')) { return res(200, ''); }
      return geminiRes(geminiAnalyze());
    }
  });
  const r = post(env, { action: 'analyze', url: 'https://note.com/sato/n/nabc123' });
  assert.strictEqual(r.source, 'note');
  assert.strictEqual(r.author, '佐藤');
  assert.strictEqual(r.originalText, 'noteの本文1段落目です。十分な長さの文章をここに書いています。\n2段落目\n改行あり');
});

test('analyze: 本文が取れない一般ページは貼り付けを促し、Gemini は呼ばない', () => {
  const env = load({ fetch: () => res(200, '<html><head><title>T</title></head><body><script>x</script>短い</body></html>') });
  const r = post(env, { action: 'analyze', url: 'https://example.com/page' });
  assert.strictEqual(r.fetchStatus, 'needs_paste');
  assert.strictEqual(r.title, 'T');
  assert.ok(env.calls.every((c) => !c.url.includes('generativelanguage')));
});

test('analyze: 短縮 URL はリダイレクトを辿ってから重複チェックする', () => {
  const env = load({
    fetch: (url, params) => {
      if (url === 'https://short.example/x' && params.followRedirects === false) { return res(301, '', { Location: 'https://example.com/a' }); }
      if (url === 'https://example.com/a' && params.followRedirects === false) { return res(200, ''); }
      if (url === 'https://example.com/a') { return res(200, '<article>' + '本文です。'.repeat(20) + '</article>'); }
      return geminiRes(geminiAnalyze());
    }
  });
  post(env, validPost({ url: 'https://example.com/a' }));
  const r = post(env, { action: 'analyze', url: 'https://short.example/x' });
  assert.strictEqual(r.resolvedUrl, 'https://example.com/a');
  assert.ok(r.duplicate && r.duplicate.title === 'タイトル');
});

test('analyze: 画像だけの告知は画像を Gemini に渡し、読み取った文章をスレッド用の原文にする', () => {
  const env = load({ fetch: () => geminiRes(geminiAnalyze({ imageText: 'チラシの文字\n10/3(土) 19:00' })) });
  const r = post(env, { action: 'analyze', image: { mimeType: 'image/jpeg', data: 'QUJD' } });
  assert.strictEqual(r.source, 'flyer');
  assert.strictEqual(r.originalText, 'チラシの文字\n10/3(土) 19:00');
  assert.strictEqual(r.originalFromImage, true);
  const parts = JSON.parse(env.calls[0].payload).contents[0].parts;
  assert.deepStrictEqual(parts[1], { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } });
});

test('analyze: 入力の検証（何もない・不正な URL・未対応の画像形式・大きすぎる画像）', () => {
  const env = load();
  assert.match(post(env, { action: 'analyze' }).error, /どれかを入力/);
  assert.match(post(env, { action: 'analyze', url: 'ftp://x' }).error, /URL の形式/);
  assert.match(post(env, { action: 'analyze', image: { mimeType: 'image/gif', data: 'x' } }).error, /画像形式/);
  assert.match(post(env, { action: 'analyze', image: { mimeType: 'image/png', data: 'x'.repeat(8000001) } }).error, /大きすぎ/);
  assert.match(post(env, { action: 'analyze', text: 'a', source: 'zzz' }).error, /不明な入力元/);
});

// ---- summarize ----------------------------------------------------

test('summarize: 長さの指定を検証し、要約の本文だけを返す', () => {
  const env = load({ fetch: () => geminiRes('要約した文章\n') });
  const r = post(env, { action: 'summarize', text: '原文', length: '3lines' });
  assert.strictEqual(r.summary, '要約した文章');
  const payload = JSON.parse(env.calls[0].payload);
  assert.match(payload.systemInstruction.parts[0].text, /3行程度/);
  assert.match(payload.systemInstruction.parts[0].text, /URL・日付・時刻・数字/);
  assert.match(post(env, { action: 'summarize', text: '原文', length: '10行' }).error, /長さの指定/);
  assert.match(post(env, { action: 'summarize', text: '  ' }).error, /本文がありません/);
});

// ---- 純粋関数 -------------------------------------------------------

test('htmlToText_ / decodeEntities_ / truncateText_', () => {
  const { context } = load();
  assert.strictEqual(context.htmlToText_('<p>a&amp;b</p><p>c<br/>d</p><ul><li>x</li><li>y</li></ul>'), 'a&b\nc\nd\n・x\n・y');
  assert.strictEqual(context.decodeEntities_('&#128512;&#x1F600;&amp;lt;'), '😀😀&lt;');
  assert.strictEqual(context.truncateText_('ab😀', 3), 'ab');
  assert.strictEqual(context.truncateText_('abc', 10), 'abc');
});

test('同じ名前の関数が二重に定義されていない（書き換え時の消し忘れ防止）', () => {
  const names = (CODE_SOURCE.match(/^function\s+(\w+)/gm) || []).map((s) => s.replace(/^function\s+/, ''));
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepStrictEqual(dup, []);
});

// ---- 概略の箇条書き・未確定の日時 ------------------------------------

test('normalizeSummaryBullets_: 行頭の記号を「・」にそろえ、1段落なら句点ごとに分け、末尾の「。」を外す', () => {
  const { context } = load();
  const n = context.normalizeSummaryBullets_;
  assert.strictEqual(n('- 一つ目\n* 二つ目\n\n1. 三つ目\n・四つ目'), '・一つ目\n・二つ目\n・三つ目\n・四つ目');
  assert.strictEqual(n('配信を行います。アーカイブも残します。'), '・配信を行います\n・アーカイブも残します');
  assert.strictEqual(n('・生配信を実施。。\n・アーカイブあり'), '・生配信を実施\n・アーカイブあり');
  // 行の途中の「。」は外さない
  assert.strictEqual(n('・配信。後日アーカイブ\n・二行目'), '・配信。後日アーカイブ\n・二行目');
  assert.strictEqual(n('一文だけ'), '・一文だけ');
  assert.strictEqual(n(''), '');
  assert.strictEqual(n('  \n  '), '');
});

test('概略: 「詳細はスレッドにて ➡️」などの結びは、analyze の結果にも保存にも残さない（トーク本体にだけ付ける）', () => {
  const env = load({
    fetch: () => geminiRes(geminiAnalyze({ summaryPoints: ['生配信を実施', '詳細はスレッドにて ➡️', '初心者歓迎 詳細はスレッドにて➡️'] }))
  });
  assert.strictEqual(post(env, { action: 'analyze', text: '本文' }).summary, '・生配信を実施\n・初心者歓迎');

  const saved = post(env, validPost({ url: '', summary: '・要点A\n・要点B\n詳細はスレッドにて ➡️\n・全文はこちら ⬇️' }));
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(post(env, { action: 'search' }).items[0].summary, '・要点A\n・要点B');
  // 本文中の「スレッド」という語は消さない
  const keep = post(env, validPost({ url: '', title: '別', summary: '・スレッドの使い方を解説' }));
  assert.strictEqual(keep.ok, true);
  assert.strictEqual(post(env, { action: 'search' }).items[0].summary, '・スレッドの使い方を解説');
});

test('analyze: 概略は要点の配列で受け取り、1要点1行の箇条書きにする（要点の中の「・」では分けない）', () => {
  const env = load({
    fetch: () => geminiRes(geminiAnalyze({
      summaryPoints: ['・サポーター・党員限定の生配信。', '現地とオンラインのハイブリッド開催', '', 3, '1. 初心者歓迎']
    }))
  });
  const r = post(env, { action: 'analyze', text: '本文' });
  assert.strictEqual(r.summary, '・サポーター・党員限定の生配信\n・現地とオンラインのハイブリッド開催\n・初心者歓迎');
  const payload = JSON.parse(env.calls[0].payload);
  const schema = payload.generationConfig.responseSchema;
  assert.strictEqual(schema.properties.summaryPoints.type, 'ARRAY');
  assert.match(schema.properties.summaryPoints.description, /体言止め/);
  assert.ok(schema.required.includes('summaryPoints'));
  assert.match(payload.systemInstruction.parts[0].text, /体言止め/);
  assert.match(payload.systemInstruction.parts[0].text, /です・ます体は使わず/);
});

test('analyze: 古い形式（概略が文字列）で返ってきても箇条書きにそろえる', () => {
  const env = load({ fetch: () => geminiRes(geminiAnalyze({ summaryPoints: undefined, summary: '配信を行います。アーカイブも残します。' })) });
  assert.strictEqual(post(env, { action: 'analyze', text: '本文' }).summary, '・配信を行います\n・アーカイブも残します');
});

test('analyze: 場所は開催形式と地名から「対面（渋谷）＆オンライン」の形に組み立てる', () => {
  const cases = [
    [{ attendance: 'hybrid', area: '渋谷' }, '対面（渋谷）＆オンライン'],
    [{ attendance: 'hybrid', area: '' }, '対面＆オンライン'],
    [{ attendance: 'in_person', area: '神戸三宮' }, '対面（神戸三宮）'],
    [{ attendance: 'in_person', area: '' }, '対面'],
    [{ attendance: 'online', area: '渋谷' }, 'オンライン'],
    [{ attendance: 'tv', area: '' }, 'テレビ'],
    [{ attendance: 'tv', area: '東京' }, 'テレビ'],
    [{ attendance: 'unknown', area: '渋谷' }, '渋谷'],
    [{ attendance: 'unknown', area: '' }, '']
  ];
  for (const [input, expected] of cases) {
    const env = load({ fetch: () => geminiRes(geminiAnalyze(input)) });
    assert.strictEqual(post(env, { action: 'analyze', text: '本文' }).event.place, expected, JSON.stringify(input));
  }
  const env = load({ fetch: () => geminiRes(geminiAnalyze()) });
  post(env, { action: 'analyze', text: '本文' });
  const schema = JSON.parse(env.calls[0].payload).generationConfig.responseSchema;
  assert.deepStrictEqual(Array.from(schema.properties.attendance.enum), ['in_person', 'online', 'hybrid', 'tv', 'unknown']);
  assert.strictEqual(schema.properties.place, undefined);
});

test('testJev: 短いテスト文で Jev を1回呼び、HTTP の結果をログに出す（API キーは出さない）', () => {
  const logs = [];
  const env = load({
    props: { TYPESAFE_API_KEY: 'jev-secret-key' },
    fetch: () => res(401, '{"error":"Error communicating with server. Please check your API key and try again."}')
  });
  env.context.Logger.log = (m) => logs.push(String(m));
  env.context.testJev();
  assert.strictEqual(env.calls.length, 1);
  assert.match(env.calls[0].url, /typesafe/);
  assert.ok(logs.some((l) => l === 'HTTP 401'));
  assert.ok(logs.some((l) => /送信する質問: kind, category/.test(l)));
  assert.ok(logs.every((l) => !l.includes('jev-secret-key')));
  // キーが無ければ通信しない
  const env2 = load();
  const logs2 = [];
  env2.context.Logger.log = (m) => logs2.push(String(m));
  env2.context.testJev();
  assert.strictEqual(env2.calls.length, 0);
  assert.match(logs2[0], /未設定/);
});

test('analyze: 日時が未確定なら、AI が日付を入れてきても日時を空にし、候補のメモを返す', () => {
  const env = load({
    fetch: () => geminiRes(geminiAnalyze({
      eventDate: '2026-10-07', startTime: '21:30', endTime: '22:30',
      dateUncertain: true, dateNote: '10月7日または10月8日、21:30〜'
    }))
  });
  const r = post(env, { action: 'analyze', text: '実施日は10月7日または10月8日のいずれかです' });
  assert.strictEqual(r.dateUncertain, true);
  assert.strictEqual(r.dateNote, '10月7日または10月8日、21:30〜');
  assert.strictEqual(r.event.date, '');
  assert.strictEqual(r.event.startTime, '');
  assert.strictEqual(r.event.endTime, '');
  assert.strictEqual(r.event.place, '対面（神戸駅前）', '日時以外の項目は残す');
  const schema = JSON.parse(env.calls[0].payload).generationConfig.responseSchema;
  assert.ok(schema.required.includes('dateUncertain'));
});

test('analyze: 日時が確定していれば dateUncertain は false で、日付はそのまま', () => {
  const env = load({ fetch: () => geminiRes(geminiAnalyze({ dateUncertain: false, dateNote: '余計な値' })) });
  const r = post(env, { action: 'analyze', text: '本文' });
  assert.strictEqual(r.dateUncertain, false);
  assert.strictEqual(r.dateNote, '');
  assert.strictEqual(r.event.date, '2026-10-03');
});

test('analyze: AI がタイトルに付けた外側の【】は外して返す', () => {
  const env = load({ fetch: () => geminiRes(geminiAnalyze({ title: '【限定配信のお知らせ】' })) });
  assert.strictEqual(post(env, { action: 'analyze', text: '本文' }).title, '限定配信のお知らせ');
  const env2 = load({ fetch: () => geminiRes(geminiAnalyze({ title: '【告知】と【報告】' })) });
  assert.strictEqual(post(env2, { action: 'analyze', text: '本文' }).title, '【告知】と【報告】');
});

// ---- 投稿者・発信者の候補 ----------------------------------------------

test('投稿者の候補: 初期値は Config.gs の defaultAuthors、追加・並べ替え・削除ができ、0件も保てる', () => {
  const env = load();
  assert.deepStrictEqual(post(env, { action: 'bootstrap' }).authors, ['運営アカウント']);
  assert.deepStrictEqual(post(env, { action: 'addAuthor', name: '  広報チーム ' }).authors, ['運営アカウント', '広報チーム']);
  assert.match(post(env, { action: 'addAuthor', name: '広報チーム' }).error, /すでにあります/);
  assert.match(post(env, { action: 'addAuthor', name: '  ' }).error, /入力してください/);
  assert.deepStrictEqual(post(env, { action: 'reorderAuthors', authors: ['広報チーム', '運営アカウント'] }).authors, ['広報チーム', '運営アカウント']);
  assert.match(post(env, { action: 'reorderAuthors', authors: ['広報チーム'] }).error, /一致しません/);
  post(env, { action: 'removeAuthor', name: '広報チーム' });
  assert.deepStrictEqual(post(env, { action: 'removeAuthor', name: '運営アカウント' }).authors, []);
  // 全部消しても初期値に戻らない
  assert.deepStrictEqual(post(env, { action: 'bootstrap' }).authors, []);
});

test('投稿者の候補の操作も合言葉が必要', () => {
  const env = load();
  assert.match(post(env, { action: 'addAuthor', name: 'x' }, 'wrong').error, /合言葉が一致しません/);
});

// ---- URL を整える・Instagram/Threads・note の文字数上限 -------------------

test('cleanUrl_: 追跡用パラメーターを取り除き、Amazon は /dp/ASIN にし、必要なパラメーターと # は残す', () => {
  const { context } = load();
  const c = context.cleanUrl_;
  assert.strictEqual(c('https://note.com/btaros/n/n4afd1c591625?sub_rt=share_pw'), 'https://note.com/btaros/n/n4afd1c591625');
  assert.strictEqual(
    c('https://www.amazon.co.jp/%E5%95%86%E5%93%81%E5%90%8D/dp/B0ABCDEFGH/ref=sr_1_1?crid=XYZ&keywords=abc&qid=1'),
    'https://www.amazon.co.jp/dp/B0ABCDEFGH');
  assert.strictEqual(c('https://amazon.co.jp/gp/product/b0abcdefgh?psc=1'), 'https://www.amazon.co.jp/dp/B0ABCDEFGH');
  // ASIN が取れない Amazon のページ（検索結果など）は、追跡用だけ取り除いてそのまま
  assert.strictEqual(c('https://www.amazon.co.jp/s?k=本&utm_source=x'), 'https://www.amazon.co.jp/s?k=本');
  assert.strictEqual(c('https://x.com/user/status/123?s=20&t=abc'), 'https://x.com/user/status/123');
  assert.strictEqual(c('https://www.instagram.com/p/ABC/?igsh=xyz&img_index=2'), 'https://www.instagram.com/p/ABC/?img_index=2');
  assert.strictEqual(c('https://www.threads.net/@u/post/ABC?xmt=1&slof=1'), 'https://www.threads.net/@u/post/ABC');
  assert.strictEqual(c('https://www.youtube.com/watch?v=abc123&si=track&t=30'), 'https://www.youtube.com/watch?v=abc123&t=30');
  assert.strictEqual(c('https://example.com/a?id=5&utm_source=line&fbclid=1#section'), 'https://example.com/a?id=5#section');
  assert.strictEqual(c('https://example.com/a?utm_medium=x'), 'https://example.com/a');
  assert.strictEqual(c('  https://example.com/  '), 'https://example.com/');
  assert.strictEqual(c('URL ではない文字'), 'URL ではない文字');
  assert.strictEqual(c(''), '');
});

test('重複チェック: 整える前後・threads.net と threads.com を同じ URL とみなす', () => {
  const { context } = load();
  const n = context.normalizeUrlForCompare_;
  assert.strictEqual(n('https://note.com/btaros/n/n4afd1c591625?sub_rt=share_pw'), n('https://note.com/btaros/n/n4afd1c591625'));
  assert.strictEqual(n('https://www.threads.com/@u/post/A'), n('https://threads.net/@u/post/A'));
  assert.strictEqual(n('https://www.amazon.co.jp/x/dp/B0ABCDEFGH/ref=1'), n('https://www.amazon.co.jp/dp/B0ABCDEFGH'));
});

test('analyze: 返す URL は整えた形で、重複チェックも整えた URL で行う', () => {
  const env = load({
    fetch: (url) => {
      if (url === 'https://note.com/api/v3/notes/nabc123') {
        return res(200, { data: { name: '記事', body: '<p>' + '本文です。'.repeat(20) + '</p>', user: { nickname: '佐藤' } } });
      }
      if (url.startsWith('https://note.com/')) { return res(200, ''); }
      return geminiRes(geminiAnalyze());
    }
  });
  post(env, validPost({ url: 'https://note.com/sato/n/nabc123' }));
  const r = post(env, { action: 'analyze', url: 'https://note.com/sato/n/nabc123?sub_rt=share_pw' });
  assert.strictEqual(r.resolvedUrl, 'https://note.com/sato/n/nabc123');
  assert.ok(r.duplicate, '整えた URL で重複を見つける');
});

test('analyze: Instagram・Threads の URL は通信せず貼り付けを促し、入力元を判定する', () => {
  for (const [url, source, label] of [
    ['https://www.instagram.com/p/ABC/?igsh=1', 'instagram', 'Instagram'],
    ['https://www.threads.net/@u/post/ABC', 'threads', 'Threads']
  ]) {
    const env = load();
    const r = post(env, { action: 'analyze', url });
    assert.strictEqual(r.source, source);
    assert.strictEqual(r.fetchStatus, 'needs_paste');
    assert.match(r.warnings[0], new RegExp(label + ' の URL からは本文を取得できません'));
    assert.strictEqual(env.calls.length, 0, '通信しない');
  }
  // 本文を貼れば Gemini で整形する（URL は整えた形）
  const env = load({ fetch: () => geminiRes(geminiAnalyze()) });
  const r = post(env, { action: 'analyze', url: 'https://www.instagram.com/p/ABC/?igsh=1', text: '投稿の本文' });
  assert.strictEqual(r.analyzed, true);
  assert.strictEqual(r.resolvedUrl, 'https://www.instagram.com/p/ABC/');
});

test('analyze: note は AI に渡す文字数の上限を 20,000 文字にする（ほかは 6,000 文字のまま）', () => {
  const env = load({ fetch: () => geminiRes(geminiAnalyze()) });
  post(env, { action: 'analyze', source: 'note', text: 'あ'.repeat(25000) });
  const sent = JSON.parse(env.calls[0].payload).contents[0].parts[0].text;
  assert.ok(sent.includes('あ'.repeat(20000)) && !sent.includes('あ'.repeat(20001)));
  const env2 = load({ fetch: () => geminiRes(geminiAnalyze()) });
  post(env2, { action: 'analyze', source: 'slack', text: 'あ'.repeat(25000) });
  const sent2 = JSON.parse(env2.calls[0].payload).contents[0].parts[0].text;
  assert.ok(sent2.includes('あ'.repeat(6000)) && !sent2.includes('あ'.repeat(6001)));
});

test('保存: Instagram・Threads も入力元として保存でき、表示名で書き込む', () => {
  const env = load();
  assert.strictEqual(post(env, validPost({ source: 'instagram', url: 'https://www.instagram.com/p/A/' })).ok, true);
  assert.strictEqual(post(env, validPost({ source: 'threads', url: 'https://www.threads.net/@u/post/B' })).ok, true);
  const items = post(env, { action: 'search' }).items;
  assert.deepStrictEqual(items.map((i) => i.source), ['threads', 'instagram']);
  assert.deepStrictEqual([cell(env, 1, 'ソース'), cell(env, 2, 'ソース')], ['Instagram', 'Threads']);
});

// ---- 記録項目（発信者・トーク本文・参加URL・申込URL） --------------------------

test('保存・更新: 発信者・トーク本文・参加URL・申込URL を保存し、検索結果で復元する', () => {
  const env = load();
  const talk = '【勉強会】\n\n📅 10/24(土) 13:00〜\n=手で直した行\n\nSlackからの転載です。';
  const saved = post(env, validPost({
    author: '運営アカウント', talk,
    joinUrl: 'https://www.youtube.com/live/abc', applyUrl: 'https://forms.gle/xyz'
  }));
  assert.strictEqual(saved.ok, true, saved.error);
  const names = ['発信者', 'トーク本文', '参加URL', '申込URL'];
  assert.deepStrictEqual(names.map((n) => cell(env, 1, n)), ['運営アカウント', talk, 'https://www.youtube.com/live/abc', 'https://forms.gle/xyz']);
  // 数式インジェクション対策は新しい列にも効く
  assert.ok(names.every((n) => cell(env, 1, n, true).charAt(0) === "'"));
  const item = post(env, { action: 'search' }).items[0];
  assert.strictEqual(item.author, '運営アカウント');
  assert.strictEqual(item.talk, talk);
  assert.strictEqual(item.joinUrl, 'https://www.youtube.com/live/abc');
  assert.strictEqual(item.applyUrl, 'https://forms.gle/xyz');

  assert.strictEqual(post(env, validPost({ action: 'update', id: saved.id, author: '広報', talk: '直した文', joinUrl: '', applyUrl: '' })).ok, true);
  const updated = post(env, { action: 'search' }).items[0];
  assert.deepStrictEqual([updated.author, updated.talk, updated.joinUrl, updated.applyUrl], ['広報', '直した文', '', '']);
});

test('検索: 発信者とトーク本文もキーワードの対象', () => {
  const env = load();
  post(env, validPost({ url: '', title: 'A', author: '須田英太郎' }));
  post(env, validPost({ url: '', title: 'B', talk: 'トークにだけある語XYZ' }));
  assert.deepStrictEqual(post(env, { action: 'search', keyword: '須田' }).items.map((i) => i.title), ['A']);
  assert.deepStrictEqual(post(env, { action: 'search', keyword: 'xyz' }).items.map((i) => i.title), ['B']);
});

test('保存: 参加URL・申込URL の形式を検証し、発信者・トーク本文の長さも確かめる', () => {
  const env = load();
  assert.match(post(env, validPost({ joinUrl: 'javascript:alert(1)' })).error, /参加 URL の形式/);
  assert.match(post(env, validPost({ applyUrl: 'ftp://example.com/x' })).error, /申込 URL の形式/);
  assert.match(post(env, validPost({ url: '申込はこちら' })).error, /URL の形式/);
  assert.match(post(env, validPost({ talk: 'あ'.repeat(50000) })).error, /長すぎます/);
});

test('保存: https:// の無い URL は補い、「https://%20…」の空白は取り除いて保存する', () => {
  const env = load();
  const r = post(env, validPost({
    url: 'example.com/post/1',
    joinUrl: 'https://%20meet.google.com/nrg-dicq-brn',
    applyUrl: ' forms.gle/xyz '
  }));
  assert.ok(!r.error, r.error);
  const item = post(env, { action: 'search' }).items[0];
  assert.strictEqual(item.url, 'https://example.com/post/1');
  assert.strictEqual(item.joinUrl, 'https://meet.google.com/nrg-dicq-brn');
  assert.strictEqual(item.applyUrl, 'https://forms.gle/xyz');
});

test('normalizeUrlInput_: https:// を補い、URL でないものは変えない', () => {
  const { context } = load();
  const n = context.normalizeUrlInput_;
  assert.strictEqual(n('meet.google.com/nrg-dicq-brn'), 'https://meet.google.com/nrg-dicq-brn');
  assert.strictEqual(n('https:// meet.google.com/abc'), 'https://meet.google.com/abc');
  assert.strictEqual(n('https://%20meet.google.com/abc'), 'https://meet.google.com/abc');
  assert.strictEqual(n('http://example.com'), 'http://example.com');
  assert.strictEqual(n('javascript:alert(1)'), 'javascript:alert(1)');
  assert.strictEqual(n('申込はこちら'), '申込はこちら');
  assert.strictEqual(n(''), '');
  assert.strictEqual(context.isValidUrl_('https://'), false);
  assert.strictEqual(context.isValidUrl_('https://a.com/x y'), false);
});

test('analyze: 原文に https:// なしで書かれた参加 URL（Google Meet）も拾い、https:// を補う', () => {
  const original = ' Google meet のリンク： meet.google.com/nrg-dicq-brn\n\n今週は火曜日の開催です';
  for (const proposed of ['meet.google.com/nrg-dicq-brn', 'https://meet.google.com/nrg-dicq-brn']) {
    const env = load({ fetch: () => geminiRes(geminiAnalyze({ joinUrl: proposed, applyUrl: '' })) });
    const r = post(env, { action: 'analyze', text: original });
    assert.strictEqual(r.event.joinUrl, 'https://meet.google.com/nrg-dicq-brn', proposed);
    assert.strictEqual(r.originalText, original, '原文はそのまま');
  }
});

test('analyze: 参加URL・申込URL は原文にあるものだけ残し（整えた形）、無いものは外して警告する', () => {
  const original = '配信はこちら https://www.youtube.com/live/abc?si=track 。申込は https://forms.gle/xyz から。';
  const env = load({
    fetch: () => geminiRes(geminiAnalyze({
      joinUrl: 'https://www.youtube.com/live/abc', applyUrl: 'https://forms.gle/xyz'
    }))
  });
  const r = post(env, { action: 'analyze', text: original });
  assert.strictEqual(r.event.joinUrl, 'https://www.youtube.com/live/abc');
  assert.strictEqual(r.event.applyUrl, 'https://forms.gle/xyz');

  const env2 = load({
    fetch: () => geminiRes(geminiAnalyze({ joinUrl: 'https://zoom.us/j/999', applyUrl: 'ftp://bad' }))
  });
  const r2 = post(env2, { action: 'analyze', text: original });
  assert.strictEqual(r2.event.joinUrl, '', '原文に無い URL は捨てる');
  assert.strictEqual(r2.event.applyUrl, '', 'http(s) でないものは捨てる');
  assert.ok(r2.warnings.some((w) => /参加 URLは原文に見つからなかったため、外しました（https:\/\/zoom\.us\/j\/999）/.test(w)));

  const schema = JSON.parse(env.calls[0].payload).generationConfig.responseSchema;
  assert.ok(schema.required.includes('joinUrl') && schema.required.includes('applyUrl'));
  assert.match(JSON.parse(env.calls[0].payload).systemInstruction.parts[0].text, /本文に無い URL を作ったり推測したりしないで/);
});

test('analyze の指示: 収録日は開催日にしない・タイトルに団体名を付けない', () => {
  const env = load({ fetch: () => geminiRes(geminiAnalyze({})) });
  post(env, { action: 'analyze', text: '本文' });
  const system = JSON.parse(env.calls[0].payload).systemInstruction.parts[0].text;
  assert.match(system, /収録日・配信日・公開日.*開催日ではありません/);
  assert.match(system, /タイトル（title）に「チームみらい」などの団体名を付けないでください/);
});

test('findUrlInText_: 追跡用パラメーターや末尾の句読点の違いは同じ URL とみなす', () => {
  const { context } = load();
  const f = context.findUrlInText_;
  assert.strictEqual(f('https://example.com/a', '詳しくは https://example.com/a?utm_source=x。'), 'https://example.com/a?utm_source=x');
  assert.strictEqual(f('https://example.com/a', 'https://example.com/a!'), 'https://example.com/a');
  assert.strictEqual(f('https://example.com/b', 'https://example.com/a'), '');
  assert.strictEqual(f('', 'https://example.com/a'), '');
  // https:// なしで書かれた URL も見つけ、https:// を補って返す
  assert.strictEqual(f('https://meet.google.com/abc-defg-hij', 'リンク： meet.google.com/abc-defg-hij です'), 'https://meet.google.com/abc-defg-hij');
  assert.strictEqual(f('meet.google.com/abc-defg-hij', '参加 https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
  assert.strictEqual(f('meet.google.com/zzz', 'リンク： meet.google.com/abc'), '');
});

test('発信者の候補: 管理画面の名前は「発信者の候補」', () => {
  const env = load();
  assert.match(post(env, { action: 'removeAuthor', name: 'いない人' }).error, /存在しない発信者の候補です/);
});

test('writeCellsInRuns_: 隣り合った列はまとめて書き、離れた列は分けて書く（書き込み回数を減らす）', () => {
  const env = load();
  post(env, validPost({ url: '' }));
  const sheet = env.sheet();
  const calls = [];
  const original = sheet.getRange.bind(sheet);
  sheet.getRange = (row, col, numRows, numCols) => {
    const range = original(row, col, numRows, numCols);
    const setValues = range.setValues;
    range.setValues = (v) => { calls.push([col, numCols]); return setValues(v); };
    return range;
  };
  env.context.writeCellsInRuns_(sheet, 1, [
    { col: 3, value: 'c' }, { col: 2, value: 'b' }, { col: 4, value: 'd' }, { col: 7, value: 'g' }
  ]);
  assert.deepStrictEqual(calls, [[2, 3], [7, 1]]);
  assert.deepStrictEqual([sheet.values[0][1], sheet.values[0][2], sheet.values[0][3], sheet.values[0][6]], ['b', 'c', 'd', 'g']);
});

test('update: 新しいシートの並びなら、編集の書き込みは3回以内で済む', () => {
  const env = load();
  const saved = post(env, validPost());
  const sheet = env.sheet();
  let writes = 0;
  const original = sheet.getRange.bind(sheet);
  sheet.getRange = (row, col, numRows, numCols) => {
    const range = original(row, col, numRows, numCols);
    const setValues = range.setValues;
    range.setValues = (v) => { if (row === 2) { writes++; } return setValues(v); };
    return range;
  };
  assert.strictEqual(post(env, validPost({ action: 'update', id: saved.id, title: '更新' })).ok, true);
  assert.ok(writes >= 1 && writes <= 3, '書き込み回数: ' + writes);
  assert.strictEqual(cell(env, 1, 'タイトル'), '更新');
});

test('bootstrap: 保存先スプレッドシートの URL を返し、合言葉が違えば返さない', () => {
  const env = load();
  assert.strictEqual(post(env, { action: 'bootstrap' }).spreadsheetUrl, 'https://docs.google.com/spreadsheets/d/test-sheet-id/edit');
  const wrong = post(env, { action: 'bootstrap' }, 'wrong');
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(wrong.spreadsheetUrl, undefined);
  const noToken = load({ props: { SHARED_TOKEN: undefined } });
  assert.strictEqual(post(noToken, { action: 'bootstrap' }, '').spreadsheetUrl, undefined);
});

// ---- 記録の一覧（GET ?action=archive） -----------------------------------

/** doGet を ?action=archive で呼ぶ（合言葉なし） */
function getArchive(env) {
  return JSON.parse(env.context.doGet({ parameter: { action: 'archive' } }).getContent());
}

test('記録の一覧: ARCHIVE_PUBLIC が "true" でなければ返さない（初期状態は止めておく）', () => {
  const env = load();
  post(env, validPost({ memo: '秘密のメモ' }));
  const r = getArchive(env);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /公開されていません/);
  assert.strictEqual(r.items, undefined);
  const env2 = load({ props: { ARCHIVE_PUBLIC: 'yes' } });
  assert.strictEqual(getArchive(env2).ok, false, '"true" 以外は止めたまま');
});

test('記録の一覧: 公開してよい項目だけを新しい順に返し、ID は返さない（コメントは出す。合言葉なし）', () => {
  const env = load({ props: { ARCHIVE_PUBLIC: 'TRUE' } });
  post(env, validPost({ url: 'https://example.com/old', title: '古い', memo: '秘密のメモ' }));
  post(env, validPost({
    url: 'https://example.com/new', title: '新しい', memo: '秘密のメモ2', author: '運営アカウント',
    kind: 'schedule', source: 'note', eventIso: '2026-10-24T13:00+09:00', place: '対面（渋谷）＆オンライン',
    talk: 'トーク本文', original: '原文', joinUrl: 'https://www.youtube.com/live/abc', applyUrl: 'https://forms.gle/x'
  }));
  const r = getArchive(env);
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.items.map((i) => i.title), ['新しい', '古い']);
  const item = r.items[0];
  assert.deepStrictEqual(Object.keys(item).sort(), [
    'applyUrl', 'author', 'category', 'comment', 'deadline', 'eventIso', 'joinUrl', 'kind', 'kindLabel', 'original',
    'performers', 'place', 'postedAt', 'savedAt', 'sourceLabel', 'summary', 'tags', 'talk', 'title', 'url'
  ]);
  assert.strictEqual(item.kindLabel, 'スケジュール');
  assert.strictEqual(item.sourceLabel, 'note');
  assert.strictEqual(item.original, '原文');
  const text = JSON.stringify(r);
  assert.strictEqual(item.comment, '秘密のメモ2', 'コメント（スレッドに添えたもの）は出す');
  assert.ok(!/uuid-/.test(text), 'ID は出さない');
  assert.ok(!text.includes(TOKEN) && !text.includes('gemini-key'), '合言葉・API キーは出さない');
});

test('記録の一覧: 公開用スプレッドシートの URL を返す（未設定なら空）', () => {
  const env = load({ props: { ARCHIVE_PUBLIC: 'true', PUBLIC_SPREADSHEET_ID: 'public-sheet-9' } });
  assert.strictEqual(getArchive(env).publicSpreadsheetUrl, 'https://docs.google.com/spreadsheets/d/public-sheet-9/edit');
  assert.strictEqual(getArchive(load({ props: { ARCHIVE_PUBLIC: 'true' } })).publicSpreadsheetUrl, '');
});

test('toPublicItem_: http(s) 以外の URL は空にする', () => {
  const { context } = load();
  const p = context.toPublicItem_({ kind: 'article', source: 'slack', url: 'javascript:alert(1)', joinUrl: 'ftp://x', applyUrl: 'https://ok.example/', tags: [] });
  assert.strictEqual(p.url, '');
  assert.strictEqual(p.joinUrl, '');
  assert.strictEqual(p.applyUrl, 'https://ok.example/');
});

test('toPublicItem_: トーク本文から「詳細はスレッドにて ➡️」だけを取り除く（全文はこちらの URL と原文は残す）', () => {
  const { context } = load();
  const base = { kind: 'article', source: 'slack', tags: [] };
  const pub = (talk) => context.toPublicItem_(Object.assign({}, base, { talk })).talk;
  assert.strictEqual(pub('【勉強会】\n・渋谷で開催\n\n詳細はスレッドにて ➡️'), '【勉強会】\n・渋谷で開催');
  assert.strictEqual(pub('【勉強会】\n・渋谷で開催\n詳細はスレッドで➡'), '【勉強会】\n・渋谷で開催');
  assert.strictEqual(
    pub('【勉強会】\n全文はこちら ⬇️\nhttps://example.com/a'),
    '【勉強会】\n全文はこちら ⬇️\nhttps://example.com/a',
    '「全文はこちら」とその下の URL は残す'
  );
  assert.strictEqual(pub('📅 21:20〜\n📍 渋谷'), '📅 21:20〜\n📍 渋谷', '結びが無ければ変えない');
  assert.strictEqual(pub(''), '');
  assert.strictEqual(
    context.toPublicItem_(Object.assign({}, base, { original: '原文\n詳細はスレッドにて ➡️' })).original,
    '原文\n詳細はスレッドにて ➡️',
    '原文は書き換えない'
  );
});

test('doGet: archive 以外の GET は何も返さない／bootstrap は公開の状態を返す', () => {
  const env = load({ props: { ARCHIVE_PUBLIC: 'true' } });
  const r = JSON.parse(env.context.doGet({ parameter: { action: 'search' } }).getContent());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.items, undefined);
  assert.strictEqual(post(env, { action: 'bootstrap' }).archivePublic, true);
  assert.strictEqual(post(load(), { action: 'bootstrap' }).archivePublic, false);
});

// ---- X の途中切れの判定 ----------------------------------------------

test('isTruncatedXText_: 「…」で終わる・「…」のあとにリンクだけが続く本文を途中切れとみなす', () => {
  const { context } = load();
  const t = context.isTruncatedXText_;
  assert.strictEqual(t('勉強会を開催しました。…'), true);
  assert.strictEqual(t('（AIは民主主義をどう変えるか 一社会の備えと、日本の好機）を開催しました。…\npic.twitter.com/gN7MjgrOs8'), true);
  assert.strictEqual(t('開催しました。… https://t.co/abc https://t.co/def'), true);
  assert.strictEqual(t('短い投稿です。 pic.twitter.com/abc'), false);
  assert.strictEqual(t('途中に…がある投稿です。'), false);
  assert.strictEqual(t(''), false);
  // 切れた URL（https://t.co/abc…）で終わる本文（2026-11-01 に見つかった漏れ）
  assert.strictEqual(t('公開しました！\n\n🔗https://t.co/nZcZLzcR4Q… pic.twitter.com/To94k9HJc6'), true);
  assert.strictEqual(t('公開しました！ https://t.co/nZcZLzcR4Q'), false);
});

test('parseXStatusUrl_: X の投稿の URL からユーザー名と ID を取り出す', () => {
  const { context } = load();
  const p = (u) => JSON.parse(JSON.stringify(context.parseXStatusUrl_(u)));
  assert.deepStrictEqual(p('https://x.com/InaharaM_mirai/status/2116325008939368476?a=imSTzDvwkebh6qCkQvs'), { user: 'InaharaM_mirai', id: '2116325008939368476' });
  assert.deepStrictEqual(p('https://twitter.com/a/status/12'), { user: 'a', id: '12' });
  assert.deepStrictEqual(p('https://mobile.twitter.com/a/status/12'), { user: 'a', id: '12' });
  assert.deepStrictEqual(p('https://x.com/i/status/12'), { user: 'i', id: '12' });
  assert.deepStrictEqual(p('https://x.com/i/web/status/12'), { user: 'i', id: '12' });
  assert.strictEqual(context.parseXStatusUrl_('https://x.com/a'), null);
  assert.strictEqual(context.parseXStatusUrl_('https://example.com/a/status/12'), null);
});

test('analyze: X の長文は、oEmbed が途中で切れていたら fxtwitter から全文を取り、警告を出さない', () => {
  const full = '【自分が払った税金、どこへ行っているか知っていますか？】\n\n公開しました！\n\n🔗https://rs-vis.team-mir.ai/\n\n国の予算データは公開されているものの、資料が膨大でした。';
  const calls = [];
  const env = load({
    fetch: (url) => {
      calls.push(url);
      if (url.startsWith('https://publish.twitter.com/')) {
        return res(200, { author_name: '稲原むねよし', html: '<blockquote><p lang="ja">【自分が払った税金】<br><br>公開しました！<br><br>🔗<a href="https://t.co/nZcZLzcR4Q">https://t.co/nZcZLzcR4Q</a>… <a href="https://t.co/To94k9HJc6">pic.twitter.com/To94k9HJc6</a></p></blockquote>' });
      }
      if (url.startsWith('https://api.fxtwitter.com/')) {
        return res(200, { code: 200, tweet: { text: full, author: { name: '稲原むねよし| チームみらい' } } });
      }
      if (url.startsWith('https://x.com/')) { return res(200, ''); }
      return geminiRes(geminiAnalyze());
    }
  });
  const r = post(env, { action: 'analyze', url: 'https://x.com/InaharaM_mirai/status/2116325008939368476?a=abc' });
  assert.strictEqual(r.originalText, full);
  assert.strictEqual(r.author, '稲原むねよし| チームみらい');
  assert.ok(!r.warnings.some((w) => /途中までしか取得できません/.test(w)), JSON.stringify(r.warnings));
  assert.ok(calls.includes('https://api.fxtwitter.com/InaharaM_mirai/status/2116325008939368476'), JSON.stringify(calls));
});

test('analyze: X の短い投稿は、fxtwitter に問い合わせない', () => {
  const calls = [];
  const env = load({
    fetch: (url) => {
      calls.push(url);
      if (url.startsWith('https://publish.twitter.com/')) { return res(200, { author_name: 'A', html: '<p>明日は街頭演説です。</p>' }); }
      if (url.startsWith('https://x.com/')) { return res(200, ''); }
      return geminiRes(geminiAnalyze());
    }
  });
  post(env, { action: 'analyze', url: 'https://x.com/a/status/5' });
  assert.ok(!calls.some((u) => u.startsWith('https://api.fxtwitter.com/')), JSON.stringify(calls));
});

test('analyze: oEmbed が切れていて fxtwitter も失敗したら、従来どおり全文の貼り付けを促す', () => {
  const env = load({
    fetch: (url) => {
      if (url.startsWith('https://publish.twitter.com/')) { return res(200, { author_name: 'A', html: '<p>長い投稿の途中まで…</p>' }); }
      if (url.startsWith('https://api.fxtwitter.com/')) { return res(500, { code: 500 }); }
      if (url.startsWith('https://x.com/')) { return res(200, ''); }
      return geminiRes(geminiAnalyze());
    }
  });
  const r = post(env, { action: 'analyze', url: 'https://x.com/a/status/6' });
  assert.strictEqual(r.originalText, '長い投稿の途中まで…');
  assert.ok(r.warnings.some((w) => /途中までしか取得できません/.test(w)), JSON.stringify(r.warnings));
});

test('analyze: X の長文（「…」＋画像リンクで終わる）では、全文の貼り付けを促す警告を出す', () => {
  const env = load({
    fetch: (url) => {
      if (url.startsWith('https://publish.twitter.com/')) {
        return res(200, { author_name: '安野貴博', html: '<blockquote><p lang="ja">国会議員向け勉強会を開催しました。… <a href="https://t.co/x">pic.twitter.com/gN7MjgrOs8</a></p></blockquote>' });
      }
      if (url.startsWith('https://x.com/')) { return res(200, ''); }
      return geminiRes(geminiAnalyze());
    }
  });
  const r = post(env, { action: 'analyze', url: 'https://x.com/takahiroanno/status/2105989521020166328' });
  assert.ok(r.warnings.some((w) => /長い投稿は途中までしか取得できません/.test(w) && /さらに表示/.test(w)), JSON.stringify(r.warnings));
});

// ---- 使用量と概算の金額 -------------------------------------------------

/** トークン数（usageMetadata）付きの Gemini の応答 */
function geminiResWithUsage(obj, usageMetadata) {
  return res(200, {
    candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }],
    usageMetadata
  });
}

test('estimateYen_: 料金表（Config.gs の pricing）でトークン数から円を計算する', () => {
  const { context } = load();
  // Gemini 入力 2,500・出力 1,000 → (2500×0.25 + 1000×1.5)/1e6 ドル × 150 = 0.32 円
  assert.strictEqual(context.estimateYen_({ geminiInput: 2500, geminiOutput: 1000, jevInput: 0 }), 0.32);
  // Jev 入力 1,000,000 → 0.042 ドル × 150 = 6.3 円
  assert.strictEqual(context.estimateYen_({ geminiInput: 0, geminiOutput: 0, jevInput: 1000000 }), 6.3);
  assert.strictEqual(context.estimateYen_({ geminiInput: 0, geminiOutput: 0, jevInput: 0 }), 0);
});

test('readUsage_: Gemini の出力は本文と考える過程の合計、Jev は入力だけを読む（読めなければ 0）', () => {
  const { context } = load();
  const u = context.readUsage_(
    geminiResWithUsage('{}', { promptTokenCount: 2000, candidatesTokenCount: 300, thoughtsTokenCount: 500 }),
    res(200, { answers: {}, usage: { input_tokens: 590, output_tokens: 97 } })
  );
  assert.deepStrictEqual(JSON.parse(JSON.stringify(u)), { geminiInput: 2000, geminiOutput: 800, jevInput: 590, provider: 'gemini' });
  const broken = context.readUsage_(res(500, 'error'), res(200, '{壊れた'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(broken)), { geminiInput: 0, geminiOutput: 0, jevInput: 0, provider: 'gemini' });
});

test('analyze: 使用量を「利用量」シートに記録し、今回の概算を返す（Jev の分も含む）', () => {
  const env = load({
    props: { TYPESAFE_API_KEY: 'jev-key' },
    fetch: (url) => (url.includes('typesafe')
      ? res(200, { answers: { kind: { type: 'choice', choice: 'c0' } }, usage: { input_tokens: 10000 } })
      : geminiResWithUsage(geminiAnalyze(), { promptTokenCount: 2500, candidatesTokenCount: 600, thoughtsTokenCount: 400 }))
  });
  const r = post(env, { action: 'analyze', text: '本文' });
  assert.strictEqual(r.ok, true, r.error);
  // (2500×0.25 + 1000×1.5 + 10000×0.042)/1e6 × 150 = 0.38175 → 0.38
  assert.strictEqual(r.usage.yen, 0.38);
  const sheet = env.usageSheet();
  assert.deepStrictEqual(Array.from(sheet.values[0]), ['日時', '操作', 'モデル', 'Gemini入力トークン', 'Gemini出力トークン', 'Jev入力トークン', '概算（円）']);
  assert.deepStrictEqual(Array.from(sheet.values[1]).slice(1), ['文章を整える', 'gemini-3.1-flash-lite', 2500, 1000, 10000, 0.38]);
});

test('analyze: 結果の読み解きに失敗しても、使った分は記録する。トークン数が読めない失敗は記録しない', () => {
  const env = load({ fetch: () => geminiResWithUsage('{壊れた', { promptTokenCount: 100, candidatesTokenCount: 10 }) });
  assert.strictEqual(post(env, { action: 'analyze', text: '本文' }).ok, false);
  assert.strictEqual(env.usageSheet().values.length, 2, '見出し＋1行');
  const env2 = load({ fetch: () => res(429, 'quota') });
  assert.strictEqual(post(env2, { action: 'analyze', text: '本文' }).ok, false);
  assert.strictEqual(env2.usageSheet(), undefined, '0 円の行は作らない');
});

test('summarize: 使用量を「要約」として記録し、概算を返す', () => {
  const env = load({ fetch: () => geminiResWithUsage('要約', { promptTokenCount: 13000, candidatesTokenCount: 1000 }) });
  const r = post(env, { action: 'summarize', text: '原文', length: 'half' });
  assert.strictEqual(r.usage.yen, 0.71);
  assert.strictEqual(env.usageSheet().values[1][1], '要約');
});

test('bootstrap: 今月の概算を集計して返す（先月の行は数えない）', () => {
  const env = load({ fetch: () => geminiResWithUsage(geminiAnalyze(), { promptTokenCount: 2500, candidatesTokenCount: 1000 }) });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(post(env, { action: 'bootstrap' }).usageThisMonth)),
    { month: '2026-10', count: 0, analyzeCount: 0, summarizeCount: 0, yen: 0 });
  post(env, { action: 'analyze', text: '本文' });
  post(env, { action: 'analyze', text: '本文' });
  post(env, { action: 'summarize', text: '原文', length: 'half' });
  env.usageSheet().values.push(['2026-09-30 23:59:00', '文章を整える', 'm', 1, 1, 0, 100]);
  const u = post(env, { action: 'bootstrap' }).usageThisMonth;
  assert.strictEqual(u.month, '2026-10');
  assert.strictEqual(u.count, 3);
  assert.strictEqual(u.analyzeCount, 2);
  assert.strictEqual(u.summarizeCount, 1);
  assert.strictEqual(u.yen, 0.96);
});

test('使用量の記録に失敗しても、文章を整える処理は止めない', () => {
  const env = load({ fetch: () => geminiResWithUsage(geminiAnalyze(), { promptTokenCount: 100, candidatesTokenCount: 10 }) });
  const original = env.context.SpreadsheetApp.getActiveSpreadsheet;
  env.context.SpreadsheetApp.getActiveSpreadsheet = () => {
    const ss = original();
    return Object.assign({}, ss, {
      getSheetByName: (name) => { if (name === '利用量') { throw new Error('書き込めない'); } return ss.getSheetByName(name); }
    });
  };
  const r = post(env, { action: 'analyze', text: '本文' });
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(r.usage.yen >= 0);
});

test('記録の一覧に使用量は出ない', () => {
  const env = load({ props: { ARCHIVE_PUBLIC: 'true' }, fetch: () => geminiResWithUsage(geminiAnalyze(), { promptTokenCount: 100 }) });
  post(env, { action: 'analyze', text: '本文' });
  post(env, validPost());
  const text = env.context.doGet({ parameter: { action: 'archive' } }).getContent();
  assert.ok(!/トークン|概算|usage/.test(text));
});

// ---- 公開用スプレッドシート（記録一覧タブ） --------------------------------------

/** 公開用ファイルを用意し、PUBLIC_SPREADSHEET_ID を設定した環境を作る */
function loadWithPublicSheet(options = {}) {
  const env = load(options);
  const file = env.makeFile('public-sheet-1');
  env.props.PUBLIC_SPREADSHEET_ID = 'public-sheet-1';
  env.publicTab = () => file.getSheetByName('記録一覧');
  return env;
}

test('公開用シート: 保存すると「記録一覧」タブを新しい順に書き直し、決めた列だけを載せる（ID とトーク本文は載せない）', () => {
  const env = loadWithPublicSheet();
  post(env, validPost({ url: 'https://example.com/old', title: '古い', memo: 'コメント1' }));
  const r = post(env, validPost({
    url: 'https://example.com/new', title: '新しい', memo: 'コメント2', author: '運営アカウント', kind: 'schedule',
    eventIso: '2026-10-24T13:00+09:00/2026-10-24T17:00+09:00', deadline: '2026-10-20', place: '対面（渋谷）＆オンライン',
    talk: 'トーク本文はここ', original: '原文', tags: [], joinUrl: 'https://www.youtube.com/live/abc'
  }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.publicSheet)), { ok: true, count: 2 });
  const tab = env.publicTab();
  assert.deepStrictEqual(Array.from(tab.values[0]), [
    '登録日時', '発信日', 'カテゴリ', '発信者／出演者', 'ソース', 'タイトル', '概略', '開催日時', '場所',
    '出演者', '申込締切', '参加URL', '申込URL', '元の投稿のURL', 'タグ', 'スレッド詳細（原文）', 'コメント', '種別'
  ]);
  const row = Array.from(tab.values[1]);
  const header = Array.from(tab.values[0]);
  const at = (name) => row[header.indexOf(name)];
  assert.strictEqual(at('種別'), 'スケジュール');
  assert.strictEqual(at('開催日時'), '2026/10/24(土) 13:00〜17:00');
  assert.strictEqual(at('申込締切'), '2026/10/20(火)');
  assert.strictEqual(at('参加URL'), 'https://www.youtube.com/live/abc');
  assert.strictEqual(at('コメント'), 'コメント2');
  assert.strictEqual(Array.from(tab.values[2])[header.indexOf('コメント')], 'コメント1', '2行目が古い方');
  const text = JSON.stringify(tab.values);
  assert.ok(!text.includes('トーク本文はここ'), 'トーク本文は載せない');
  assert.ok(!/uuid-/.test(text), 'ID は載せない');
  assert.strictEqual(tab.wrap, 'CLIP', '長い文は折り返さず、行の高さをそろえる');
});

test('公開用シート: タイトルは記録の一覧ページでその投稿を開くリンク（数式の中の文字列は安全にする）', () => {
  const env = loadWithPublicSheet();
  post(env, validPost({ url: '', title: '勉強会 "特別回" =1+1' }));
  const tab = env.publicTab();
  const col = Array.from(tab.values[0]).indexOf('タイトル');
  const formula = tab.raw[1][col];
  const savedAt = cell(env, 1, '登録日時');
  assert.strictEqual(formula,
    '=HYPERLINK("https://openchat-post-helper.vercel.app/archive.html?q=' + encodeURIComponent('勉強会 "特別回" =1+1') +
    '&at=' + encodeURIComponent(savedAt) + '","勉強会 ""特別回"" =1+1")');
  // ほかの列は文字列として書く（数式として動かない）
  assert.ok(tab.raw[1].filter((v, i) => i !== col && v !== '').every((v) => String(v).charAt(0) === "'"));
});

test('公開用シート: 更新・削除でも書き直し、前より件数が減ったら余った行は消える', () => {
  const env = loadWithPublicSheet();
  const a = post(env, validPost({ url: '', title: 'A' }));
  post(env, validPost({ url: '', title: 'B' }));
  // タイトルのセルはリンクの数式なので、スプレッドシートで表示される文字（2つ目の引数）を取り出す
  const shown = (v) => {
    const m = String(v).match(/","((?:[^"]|"")*)"\)$/);
    return m ? m[1].replace(/""/g, '"') : v;
  };
  const titleOf = () => env.publicTab().values.slice(1).map((r) => shown(r[Array.from(env.publicTab().values[0]).indexOf('タイトル')]));
  assert.deepStrictEqual(titleOf(), ['B', 'A']);
  assert.strictEqual(post(env, validPost({ action: 'update', id: a.id, url: '', title: 'A2' })).publicSheet.ok, true);
  assert.deepStrictEqual(titleOf(), ['B', 'A2']);
  assert.strictEqual(post(env, { action: 'delete', id: a.id }).publicSheet.count, 1);
  assert.deepStrictEqual(titleOf(), ['B']);
  assert.strictEqual(env.publicTab().getLastRow(), 2);
});

test('公開用シート: ほかのタブには触らず、「記録一覧」タブが無ければ作る', () => {
  const env = loadWithPublicSheet();
  const file = env.files['public-sheet-1'];
  const top = file.insertSheet('はじめに');
  top.appendRow(['トップページの内容']);
  post(env, validPost({ url: '' }));
  assert.deepStrictEqual(Array.from(file.getSheetByName('はじめに').values[0]), ['トップページの内容']);
  assert.ok(env.publicTab(), '記録一覧タブを作る');
});

test('公開用シート: 未設定なら何もしない。書き写しに失敗しても保存は成功し、失敗を返す', () => {
  const env = load();
  const r = post(env, validPost());
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.publicSheet)), { ok: true, skipped: true, count: 0 });

  const broken = load({ props: { PUBLIC_SPREADSHEET_ID: '存在しないID' } });
  const r2 = post(broken, validPost());
  assert.strictEqual(r2.ok, true, '保存自体は成功');
  assert.strictEqual(r2.publicSheet.ok, false);
  assert.match(r2.publicSheet.error, /見つかりません/);
  assert.strictEqual(broken.sheet().values.length, 2, '登録用シートには保存されている');
});

test('公開用シート: 「作り直す」（syncPublicSheet）と bootstrap の URL', () => {
  const env = loadWithPublicSheet();
  post(env, validPost({ url: '' }));
  env.publicTab().values[1][0] = '手で書き換えた値';
  const r = post(env, { action: 'syncPublicSheet' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 1);
  assert.notStrictEqual(env.publicTab().values[1][0], '手で書き換えた値', '作り直すと元に戻る');
  assert.strictEqual(post(env, { action: 'bootstrap' }).publicSpreadsheetUrl, 'https://docs.google.com/spreadsheets/d/public-sheet-1/edit');
  assert.strictEqual(post(load(), { action: 'bootstrap' }).publicSpreadsheetUrl, '');
  assert.match(post(env, { action: 'syncPublicSheet' }, 'wrong').error, /合言葉/);
});

test('createPublicSpreadsheet: 公開用のファイルを作って ID を登録し、記録一覧を書き込む（2回目は作らない）', () => {
  const env = load();
  post(env, validPost({ url: '' }));
  const logs = [];
  env.context.Logger.log = (m) => logs.push(String(m));
  env.context.createPublicSpreadsheet();
  const id = env.props.PUBLIC_SPREADSHEET_ID;
  assert.ok(id, 'ID を登録する');
  const file = env.files[id];
  assert.ok(file.getSheetByName('記録一覧'), '最初のタブを記録一覧にする');
  assert.strictEqual(file.getSheetByName('記録一覧').values.length, 2);
  assert.ok(logs.some((l) => /作りました: https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(l)));
  assert.ok(logs.some((l) => /リンクを知っている全員・閲覧者/.test(l)));
  env.context.createPublicSpreadsheet();
  assert.strictEqual(Object.keys(env.files).length, 1, '2回目は新しく作らない');
});

test('「メモ」→「コメント」: 既存のシートの見出し「メモ」を「コメント」に書き換え、その列を読み書きする', () => {
  const env = load();
  post(env, validPost({ url: '', memo: '前のコメント' }));
  const header = env.sheet().values[0];
  const idx = Array.from(header).indexOf('コメント');
  header[idx] = 'メモ';
  const item = post(env, { action: 'search' }).items[0];
  assert.strictEqual(item.memo, '前のコメント');
  assert.strictEqual(env.sheet().values[0][idx], 'コメント', '見出しを書き換える');
  assert.strictEqual(Array.from(env.sheet().values[0]).filter((h) => h === 'コメント').length, 1, '新しい列は増えない');
});

test('sheetEventLabel_・sheetDateLabel_: 公開用シートの日時の表記', () => {
  const { context } = load();
  assert.strictEqual(context.sheetEventLabel_('2026-10-24'), '2026/10/24(土)');
  assert.strictEqual(context.sheetEventLabel_('2026-10-24T13:00+09:00'), '2026/10/24(土) 13:00〜');
  assert.strictEqual(context.sheetEventLabel_(''), '');
  assert.strictEqual(context.sheetDateLabel_('2026-02-30'), '');
});

// ---- Gemini が混み合っているとき（HTTP 503 など） ----------------------

const BUSY_BODY = { error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } };

test('analyze: Gemini が 503 なら、少し待って1回だけやり直し、通れば結果を返す', () => {
  let geminiCalls = 0;
  const env = load({
    fetch: (url) => {
      geminiCalls++;
      return geminiCalls === 1 ? res(503, BUSY_BODY) : geminiRes(geminiAnalyze());
    }
  });
  const r = post(env, { action: 'analyze', text: '告知の本文' });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.title, '街頭演説');
  assert.strictEqual(geminiCalls, 2);
  assert.ok(env.calls.some((c) => c.sleep === 3000), '送り直す前に待つ');
  // 送り直しにも、同じ中身（本文・API キーのヘッダー）を使う
  const geminiRequests = env.calls.filter((c) => c.url);
  assert.strictEqual(geminiRequests[1].payload, geminiRequests[0].payload);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(geminiRequests[1].headers)), JSON.parse(JSON.stringify(geminiRequests[0].headers)));
});

test('analyze: やり直しても 503 なら、混み合っている旨を日本語で返す（やり直しは1回だけ）', () => {
  let geminiCalls = 0;
  const env = load({ fetch: () => { geminiCalls++; return res(503, BUSY_BODY); } });
  const r = post(env, { action: 'analyze', text: '告知の本文' });
  assert.match(r.error, /AI（Gemini）が混み合っていて、やり直しても応答がありませんでした。少し待ってから、もう一度押してください（HTTP 503）/);
  assert.strictEqual(geminiCalls, 2);
});

test('analyze: 429（回数の上限）はやり直さず、上限に達した旨を返す', () => {
  let geminiCalls = 0;
  const env = load({ fetch: () => { geminiCalls++; return res(429, { error: { code: 429 } }); } });
  const r = post(env, { action: 'analyze', text: '告知の本文' });
  assert.match(r.error, /利用回数が上限に達しました/);
  assert.strictEqual(geminiCalls, 1);
});

test('summarize: Gemini が 503 なら、1回だけやり直す', () => {
  let geminiCalls = 0;
  const env = load({ fetch: () => { geminiCalls++; return geminiCalls === 1 ? res(503, BUSY_BODY) : geminiRes('要約した文'); } });
  const r = post(env, { action: 'summarize', text: '原文', length: '3lines' });
  assert.strictEqual(r.summary, '要約した文');
  assert.strictEqual(geminiCalls, 2);
});

// ---- 発信日（元の投稿の日付） --------------------------------------

/** Instagram・Threads の短い英数字を、指定した時刻（ミリ秒）から作る（postedDateFromUrl_ の逆の計算） */
function instagramCodeAt(ms) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let value = (BigInt(ms) - 1314220021721n) << 23n;
  let code = '';
  while (value > 0n) { code = chars[Number(value % 64n)] + code; value /= 64n; }
  return code;
}

test('postedDateFromUrl_: X・Slack・Instagram・Threads の URL から、日本時間の発信日を計算する', () => {
  const { context } = load();
  const f = (u) => context.postedDateFromUrl_(u);
  // X: 実在の投稿（2022-10-28 03:49 UTC ＝ 日本時間も 10/28）。twitter.com・x.com・mobile・クエリ付きも同じ
  assert.strictEqual(f('https://x.com/elonmusk/status/1585841080431321088'), '2022-10-28');
  assert.strictEqual(f('https://twitter.com/elonmusk/status/1585841080431321088?s=20'), '2022-10-28');
  assert.strictEqual(f('https://mobile.twitter.com/i/status/1585841080431321088'), '2022-10-28');
  // 日本時間に直す: UTC の 2026-10-02 20:00 は日本時間の 10/3
  const ms = Date.UTC(2026, 9, 2, 20, 0, 0);
  const tweetId = ((BigInt(ms) - 1288834974657n) << 22n).toString();
  assert.strictEqual(f('https://x.com/a/status/' + tweetId), '2026-10-03');
  // 日付を含まない古い連番の ID・数字でない ID は空
  assert.strictEqual(f('https://x.com/jack/status/20'), '');
  assert.strictEqual(f('https://x.com/jack/status/abc'), '');
  // Slack: p + 秒（10桁）+ マイクロ秒（6桁）。2026-10-02 20:00:00 UTC ＝ 日本時間 10/3
  assert.strictEqual(f('https://example.slack.com/archives/C0123ABCD/p' + (ms / 1000) + '123456'), '2026-10-03');
  assert.strictEqual(f('https://example.slack.com/archives/C0123ABCD'), '');
  // Instagram・Threads（短い英数字は、時刻から逆算して作った値。実在の投稿での確認は人が行う）
  const code = instagramCodeAt(Date.UTC(2025, 5, 10, 3, 0, 0));
  assert.strictEqual(f('https://www.instagram.com/p/' + code + '/'), '2025-06-10');
  assert.strictEqual(f('https://www.instagram.com/reel/' + code + '/?igsh=xx'), '2025-06-10');
  assert.strictEqual(f('https://www.threads.net/@user/post/' + code), '2025-06-10');
  assert.strictEqual(f('https://www.threads.com/@user/post/' + code), '2025-06-10');
  assert.strictEqual(f('https://www.instagram.com/user/'), '');
  // 範囲外（遠い未来など）や関係のない URL は空
  assert.strictEqual(f('https://x.com/a/status/9223372036854775807'), '');
  assert.strictEqual(f('https://example.com/a'), '');
  assert.strictEqual(f(''), '');
});

test('youtubeVideoId_: YouTube の各種 URL から動画の ID（11文字）を取り出す', () => {
  const { context } = load();
  const f = (u) => context.youtubeVideoId_(u);
  const id = 'dQw4w9WgXcQ';
  assert.strictEqual(f('https://www.youtube.com/watch?v=' + id), id);
  assert.strictEqual(f('https://www.youtube.com/watch?feature=share&v=' + id + '&t=30s'), id);
  assert.strictEqual(f('https://m.youtube.com/watch?v=' + id), id);
  assert.strictEqual(f('https://youtu.be/' + id + '?si=abc'), id);
  assert.strictEqual(f('https://www.youtube.com/live/' + id + '?feature=share'), id);
  assert.strictEqual(f('https://www.youtube.com/shorts/' + id), id);
  assert.strictEqual(f('https://www.youtube.com/embed/' + id), id);
  assert.strictEqual(f('https://www.youtube.com/@channel'), '');
  assert.strictEqual(f('https://www.youtube.com/watch?v=short'), '');
  assert.strictEqual(f('https://example.com/watch?v=' + id), '');
  assert.strictEqual(f('https://notyoutube.com/watch?v=' + id), '');
});

/** analyze 用の偽の通信。YouTube Data API には youtube を、ページ取得には空の HTML を、Gemini には既定の結果を返す */
function youtubeEnv(youtube, props) {
  const apiCalls = [];
  const env = load({
    props,
    fetch: (url) => {
      if (url.indexOf('googleapis.com/youtube/v3/videos') !== -1) { apiCalls.push(url); return youtube(url); }
      if (url.indexOf('generativelanguage') !== -1) { return geminiRes(geminiAnalyze()); }
      return res(200, '<html><head><title>動画</title></head><body>本文</body></html>');
    }
  });
  env.apiCalls = apiCalls;
  return env;
}

test('analyze: Slack の URL からは発信日を入れる（通信なし）', () => {
  const env = load({ fetch: () => geminiRes(geminiAnalyze()) });
  const r = post(env, { action: 'analyze', url: 'https://example.slack.com/archives/C0123ABCD/p1790971200123456', text: '本文' });
  assert.strictEqual(r.postedAt, '2026-10-03');
});

test('analyze: YouTube の URL は YouTube Data API で公開日を取り、日本時間の日付にする（キーは URL の key= で送る）', () => {
  const env = youtubeEnv(() => res(200, { items: [{ snippet: { publishedAt: '2026-10-02T20:30:00Z' } }] }), { YOUTUBE_API_KEY: 'yt-key' });
  const r = post(env, { action: 'analyze', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.strictEqual(r.postedAt, '2026-10-03');
  assert.strictEqual(env.apiCalls.length, 1);
  assert.match(env.apiCalls[0], /id=dQw4w9WgXcQ/);
  assert.match(env.apiCalls[0], /key=yt-key/);
  assert.ok(!Array.from(r.warnings).some((w) => /YouTube/.test(w)), 'YouTube の警告は出さない');
});

test('analyze: YOUTUBE_API_KEY が無ければ YouTube の API を呼ばず、発信日は空で警告も出さない', () => {
  const env = youtubeEnv(() => { throw new Error('呼ばれないはず'); });
  const r = post(env, { action: 'analyze', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.postedAt, '');
  assert.strictEqual(env.apiCalls.length, 0);
  assert.ok(!Array.from(r.warnings).some((w) => /YouTube/.test(w)), 'YouTube の警告は出さない');
});

test('analyze: YouTube の API が失敗・動画なしでも analyze は成功し、発信日を空にして警告する', () => {
  const cases = [
    [() => res(403, { error: { errors: [{ reason: 'quotaExceeded' }] } }), /HTTP 403/],
    [() => res(200, { items: [] }), /見つからないか、非公開/],
    [() => { throw new Error('通信エラー'); }, /通信エラー/]
  ];
  for (const [api, pattern] of cases) {
    const env = youtubeEnv(api, { YOUTUBE_API_KEY: 'yt-key' });
    const r = post(env, { action: 'analyze', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.postedAt, '');
    assert.ok(Array.from(r.warnings).some((w) => pattern.test(w)), String(pattern));
    assert.ok(!JSON.stringify(r).includes('yt-key'), 'API キーを返さない');
  }
});

test('cleanYoutubeDescription_: URL・ハッシュタグ・リンクの見出しだけの行を取り除き、連続する空行をまとめ、上限で切る', () => {
  const context = load().context;
  const description = [
    '安野党首に、AI 時代の政治について聞きました。',
    '',
    '',
    '▼公式サイト https://example.com/shop',
    'https://example.com/only-url',
    '番組の詳しい内容は、概要のとおりです。 #AI #政治',
    '＃全角ハッシュタグ',
    'お問い合わせは www.example.com/contact まで。この行は長いので、URL を取り除いても残る'
  ].join('\r\n');
  const cleaned = context.cleanYoutubeDescription_(description, 2000);
  assert.strictEqual(cleaned, [
    '安野党首に、AI 時代の政治について聞きました。',
    '',
    '番組の詳しい内容は、概要のとおりです。',
    '',
    'お問い合わせは  まで。この行は長いので、URL を取り除いても残る'
  ].join('\n'));
  assert.ok(!/https?:|www\./.test(cleaned), 'URL は残さない');
  assert.strictEqual(context.cleanYoutubeDescription_('あ'.repeat(50), 10), 'あ'.repeat(10));
  assert.strictEqual(context.cleanYoutubeDescription_('', 10), '');
});

/** YouTube の API（タイトル・説明欄つき）・ページ取得・Gemini の呼び出しを区別して記録する偽の通信 */
function youtubeContentEnv(snippet, props) {
  const log = { youtube: 0, page: 0, gemini: [] };
  const env = load({
    props: Object.assign({ YOUTUBE_API_KEY: 'yt-key' }, props || {}),
    fetch: (url, params) => {
      if (url.indexOf('googleapis.com/youtube/v3/videos') !== -1) {
        log.youtube++;
        return res(200, { items: [{ snippet }] });
      }
      if (url.indexOf('generativelanguage') !== -1) {
        log.gemini.push(JSON.parse(params.payload));
        return geminiRes(geminiAnalyze({ title: '安野党首が語る AI と政治', attendance: 'online', area: '' }));
      }
      log.page++;
      throw new Error('YouTube のページは取得しないはず');
    }
  });
  env.log = log;
  return env;
}

const YOUTUBE_SNIPPET = {
  title: 'AI QUEST：安野さんに聞く',
  description: '安野党首に、AI 時代の政治について聞きました。\n▼チャンネル登録 https://example.com/sub\n#AI',
  channelTitle: 'AI QUEST チャンネル',
  publishedAt: '2026-10-02T20:30:00Z'
};

test('analyze: YouTube の URL は API のタイトル・説明欄を AI に渡す（ページは取らない・API は1回・原文には入れない）', () => {
  const env = youtubeContentEnv(YOUTUBE_SNIPPET);
  const r = post(env, { action: 'analyze', url: 'https://m.youtube.com/watch?v=MJk8JDTUoGE' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(env.log.youtube, 1, '発信日と同じ1回の呼び出しで足りる');
  assert.strictEqual(env.log.page, 0);
  assert.strictEqual(r.postedAt, '2026-10-03');
  assert.strictEqual(r.author, 'AI QUEST チャンネル');
  assert.strictEqual(r.fetchStatus, 'ok');
  assert.strictEqual(r.originalText, '', '説明欄はスレッドの原文に入れない');
  assert.strictEqual(r.analyzed, true);

  const request = env.log.gemini[0];
  const userText = request.contents[0].parts[0].text;
  assert.match(userText, /動画のタイトル: AI QUEST：安野さんに聞く/);
  assert.match(userText, /AI 時代の政治について聞きました/);
  assert.ok(!/https?:|#AI/.test(userText.split('本文:')[1]), '説明欄の URL・ハッシュタグは AI に渡さない（動画自身の URL の行は別）');
  assert.match(request.systemInstruction.parts[0].text, /タイトルを基準にし/);
});

test('analyze: YouTube の説明欄に URL しかなくても（タイトルだけでも）AI に渡して整える', () => {
  const env = youtubeContentEnv({ title: '短い動画', description: 'https://example.com/a\nhttps://example.com/b', channelTitle: 'ch', publishedAt: '2026-10-02T20:30:00Z' });
  const r = post(env, { action: 'analyze', url: 'https://youtu.be/MJk8JDTUoGE' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.analyzed, true);
  assert.strictEqual(r.originalText, '');
  const userText = env.log.gemini[0].contents[0].parts[0].text;
  assert.match(userText, /動画のタイトル: 短い動画/);
  assert.ok(!/説明欄:/.test(userText), '残る説明が無ければ説明欄の見出しも付けない');
});

test('analyze: YouTube の URL でも本文を貼り付けていれば、貼り付けを優先する（説明欄は AI に渡さず、指示も足さない）', () => {
  const env = youtubeContentEnv(YOUTUBE_SNIPPET);
  const r = post(env, { action: 'analyze', url: 'https://www.youtube.com/watch?v=MJk8JDTUoGE', text: '貼り付けた本文です' });
  assert.strictEqual(r.originalText, '貼り付けた本文です');
  assert.strictEqual(r.postedAt, '2026-10-03', '発信日は API から入れる');
  const request = env.log.gemini[0];
  assert.match(request.contents[0].parts[0].text, /貼り付けた本文です/);
  assert.ok(!/AI 時代の政治/.test(request.contents[0].parts[0].text));
  assert.ok(!/タイトルを基準にし/.test(request.systemInstruction.parts[0].text));
});

test('analyze: AI が動画自身の URL を参加 URL として返しても、外すだけで警告は出さない（別の URL は警告する）', () => {
  const run = (joinUrl) => {
    const env = load({
      props: { YOUTUBE_API_KEY: 'yt-key' },
      fetch: (url) => {
        if (url.indexOf('googleapis.com/youtube/v3/videos') !== -1) { return res(200, { items: [{ snippet: YOUTUBE_SNIPPET }] }); }
        return geminiRes(geminiAnalyze({ joinUrl }));
      }
    });
    return post(env, { action: 'analyze', url: 'https://m.youtube.com/watch?v=MJk8JDTUoGE' });
  };
  const own = run('https://m.youtube.com/watch?v=MJk8JDTUoGE');
  assert.strictEqual(own.event.joinUrl, '');
  assert.ok(!Array.from(own.warnings).some((w) => /参加 URL/.test(w)), '自分自身の URL は警告しない');
  const other = run('https://zoom.us/j/999');
  assert.strictEqual(other.event.joinUrl, '');
  assert.ok(Array.from(other.warnings).some((w) => /参加 URL/.test(w)), '原文に無い別の URL は警告する');
});

test('analyze: 説明欄は youtubeDescriptionMaxChars で切る', () => {
  const env = youtubeContentEnv({ title: '長い説明', description: 'あ'.repeat(5000), channelTitle: 'ch', publishedAt: '2026-10-02T20:30:00Z' });
  const r = post(env, { action: 'analyze', url: 'https://www.youtube.com/watch?v=MJk8JDTUoGE' });
  assert.strictEqual(r.ok, true, r.error);
  const userText = env.log.gemini[0].contents[0].parts[0].text;
  assert.strictEqual(userText.split('あ').length - 1, 2000);
});

test('保存・更新・検索: 発信日を保存して読み戻し、不正な日付は断る。空のままの古い記録も読める', () => {
  const env = load();
  const saved = post(env, validPost({ postedAt: '2026-10-03' }));
  assert.strictEqual(saved.ok, true, saved.error);
  assert.strictEqual(cell(env, 1, '発信日'), '2026-10-03');
  assert.strictEqual(cell(env, 1, '発信日', true).charAt(0), "'");
  assert.strictEqual(post(env, { action: 'search' }).items[0].postedAt, '2026-10-03');

  assert.match(post(env, validPost({ postedAt: '2026-02-30' })).error, /発信日/);
  assert.match(post(env, validPost({ postedAt: '昨日' })).error, /発信日/);

  assert.strictEqual(post(env, validPost({ action: 'update', id: saved.id, postedAt: '' })).ok, true);
  assert.strictEqual(post(env, { action: 'search' }).items[0].postedAt, '');
  // 発信日を送らない保存（古い画面）も通り、空になる
  const old = validPost({ url: 'https://example.com/old' });
  delete old.postedAt;
  assert.strictEqual(post(env, old).ok, true);
});

test('記録の一覧と公開用シート: 発信日を公開項目として返し、シートには「2026/10/3(土)」の形で載せる', () => {
  const env = load({ props: { ARCHIVE_PUBLIC: 'true', PUBLIC_SPREADSHEET_ID: 'public-sheet-1' } });
  const file = env.makeFile('public-sheet-1');
  const saved = post(env, validPost({ postedAt: '2026-10-03' }));
  assert.strictEqual(saved.ok, true, saved.error);
  const archive = JSON.parse(env.context.doGet({ parameter: { action: 'archive' } }).getContent());
  assert.strictEqual(archive.items[0].postedAt, '2026-10-03');
  const tab = file.getSheetByName('記録一覧');
  const header = Array.from(tab.values[0]);
  assert.ok(header.includes('発信日'), header.join(','));
  assert.strictEqual(tab.values[1][header.indexOf('発信日')], '2026/10/3(土)');
});

test('analyze: YouTube の URL で AI がテレビと判定しても、原文にテレビ局などの手がかりが無ければ「オンライン」にする', () => {
  const run = (url, text, attendance = 'tv', title = '番組出演') => {
    const env = load({
      fetch: (u) => {
        if (u.indexOf('generativelanguage') !== -1) { return geminiRes(geminiAnalyze({ attendance, area: '', title })); }
        return res(200, '<html><head><title>動画</title></head><body>本文</body></html>');
      }
    });
    return post(env, { action: 'analyze', url, text }).event.place;
  };
  const youtube = 'https://m.youtube.com/watch?v=MJk8JDTUoGE';
  assert.strictEqual(run(youtube, '番組初のゲストとして出演しました'), 'オンライン');
  // 説明欄に制作会社名（TBS）や「TBSテレビ入社」などが入っていても、タイトルに手がかりが無ければ「オンライン」
  const description = '番組初のゲストとして出演。TBS CROSS DIG with Bloomberg\n中川雅博 2025年1月にTBSテレビ入社 #tbs';
  assert.strictEqual(run(youtube, description, 'tv', 'AI QUEST：安野さんに聞く'), 'オンライン');
  // タイトルにテレビの手がかりがあれば、そのまま「テレビ」。AI がオンラインと判定していても「テレビ」にする
  assert.strictEqual(run(youtube, '映像です', 'tv', 'BS-TBS「報道1930」に出演'), 'テレビ');
  assert.strictEqual(run(youtube, '映像です', 'online', 'テレビ出演の様子'), 'テレビ');
  assert.strictEqual(run(youtube, 'テレビ出演の様子です', 'online', '出演の様子'), 'オンライン', 'YouTube は原文だけの手がかりでは変えない');
  // YouTube 以外の URL・URL なしは、AI の判定（テレビ）のまま。原文の手がかりでオンラインをテレビにする補正も、従来どおり
  assert.strictEqual(run('https://example.com/a', '番組初のゲストとして出演しました'), 'テレビ');
  assert.strictEqual(run('https://example.com/a', 'TBS の番組です', 'online'), 'テレビ');
  assert.strictEqual(run('', '番組初のゲストとして出演しました'), 'テレビ');
});

test('YouTube の API が失敗したときの警告に、HTTP の番号と原因の名前を入れる。testYoutube はキーをログに出さない', () => {
  const env = youtubeEnv(() => res(403, { error: { code: 403, errors: [{ reason: 'accessNotConfigured', message: 'API has not been used' }] } }), { YOUTUBE_API_KEY: 'yt-secret-key' });
  const r = post(env, { action: 'analyze', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.ok(Array.from(r.warnings).some((w) => /HTTP 403: accessNotConfigured/.test(w)), r.warnings.join('|'));

  const logs = [];
  const env2 = youtubeEnv(() => res(403, { error: { errors: [{ reason: 'keyInvalid', message: 'bad key yt-secret-key' }] } }), { YOUTUBE_API_KEY: 'yt-secret-key' });
  env2.context.Logger = { log: (m) => logs.push(String(m)) };
  env2.context.testYoutube();
  assert.ok(logs.some((l) => /HTTP 403: keyInvalid/.test(l)), logs.join('|'));
  assert.ok(!logs.join('\n').includes('yt-secret-key'), 'API キーをログに出さない');
  const env3 = load();
  const logs3 = [];
  env3.context.Logger = { log: (m) => logs3.push(String(m)) };
  env3.context.testYoutube();
  assert.match(logs3.join(''), /YOUTUBE_API_KEY が未設定/);
});

// ---- Claude への切り替え（Gemini が使えないとき） ---------------------------------

/** Claude の Messages API の成功応答（構造化出力は JSON 文字列を text ブロックで返す） */
function claudeRes(textOrObj, usage = { input_tokens: 3000, output_tokens: 700 }, extra = {}) {
  const text = typeof textOrObj === 'string' ? textOrObj : JSON.stringify(textOrObj);
  return res(200, Object.assign({ type: 'message', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }, extra));
}

/**
 * Gemini は status を返し、Claude は claude() を返す偽の通信。
 * 呼ばれた Claude のリクエスト本文を seen に集める。
 */
function fallbackEnv({ status = 503, claude, props, text } = {}) {
  const seen = { claude: [], gemini: 0 };
  const env = load({
    props: Object.assign({ ANTHROPIC_API_KEY: 'claude-secret-key' }, props || {}),
    fetch: (url, params) => {
      if (url.indexOf('api.anthropic.com') !== -1) {
        seen.claude.push({ url, headers: params.headers, body: JSON.parse(params.payload) });
        return claude ? claude() : claudeRes(geminiAnalyze({ title: 'Claude の結果', attendance: 'online', area: '' }));
      }
      if (url.indexOf('generativelanguage') !== -1) { seen.gemini++; return res(status, { error: { code: status } }); }
      return res(200, '<html></html>');
    }
  });
  env.seen = seen;
  return env;
}

test('geminiSchemaToJsonSchema_: 型を小文字にし、オブジェクトに additionalProperties: false を付ける（入れ子も）', () => {
  const { context } = load();
  const out = JSON.parse(JSON.stringify(context.geminiSchemaToJsonSchema_({
    type: 'OBJECT',
    properties: {
      a: { type: 'STRING', enum: ['x', 'y'], description: '説明' },
      b: { type: 'ARRAY', items: { type: 'STRING', enum: ['p'] } },
      c: { type: 'BOOLEAN' }
    },
    required: ['a']
  })));
  assert.deepStrictEqual(out, {
    type: 'object',
    additionalProperties: false,
    properties: {
      a: { type: 'string', enum: ['x', 'y'], description: '説明' },
      b: { type: 'array', items: { type: 'string', enum: ['p'] } },
      c: { type: 'boolean' }
    },
    required: ['a']
  });
});

test('analyze: Gemini が 503 のままなら Claude Haiku に切り替え、結果・警告・使用量を返す（Gemini のやり直しは1回）', () => {
  const env = fallbackEnv({ status: 503 });
  const r = post(env, { action: 'analyze', text: '告知の本文' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.title, 'Claude の結果');
  assert.strictEqual(r.analyzed, true);
  assert.ok(Array.from(r.warnings).some((w) => /Claude（claude-haiku-5-5）で整えました/.test(w)), r.warnings.join('|'));
  assert.strictEqual(env.seen.gemini, 2, 'Gemini は、最初と、3秒後のやり直しの2回');
  assert.strictEqual(env.seen.claude.length, 1);
  const call = env.seen.claude[0];
  assert.strictEqual(call.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(call.headers['x-api-key'], 'claude-secret-key');
  assert.strictEqual(call.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(call.body.model, 'claude-haiku-5-5');
  assert.strictEqual(call.body.output_config.effort, 'low');
  assert.strictEqual(call.body.output_config.format.type, 'json_schema');
  assert.strictEqual(call.body.output_config.format.schema.additionalProperties, false);
  assert.ok(call.body.output_config.format.schema.properties.attendance.enum.includes('tv'));
  assert.ok(!('temperature' in call.body), 'Haiku 5.5 では temperature を送らない');
  assert.match(call.body.messages[0].content[0].text, /告知の本文/);
  assert.match(call.body.system, /編集者/);
  // 使用量: モデル名は Claude、概算は Claude の料金（入力 3000×0.10 + 出力 700×0.50 = $0.00065 → 150円/ドルで約 0.1 円）
  assert.strictEqual(r.usage.geminiInput, 3000);
  assert.strictEqual(r.usage.geminiOutput, 700);
  assert.strictEqual(r.usage.yen, 0.1);
  const usageRows = env.usageSheet().values;
  assert.strictEqual(usageRows[usageRows.length - 1][2], 'claude-haiku-5-5');
  assert.ok(!JSON.stringify(r).includes('claude-secret-key'), 'API キーを返さない');
});

test('analyze: 500・504・429 でも Claude に切り替える。Gemini が正常（200）のときは Claude を呼ばない', () => {
  for (const status of [500, 504, 429]) {
    const env = fallbackEnv({ status });
    const r = post(env, { action: 'analyze', text: '告知の本文' });
    assert.strictEqual(r.ok, true, status + ': ' + r.error);
    assert.strictEqual(env.seen.claude.length, 1, String(status));
  }
  const calls = [];
  const env = load({
    props: { ANTHROPIC_API_KEY: 'claude-secret-key' },
    fetch: (url) => {
      calls.push(url);
      if (url.indexOf('api.anthropic.com') !== -1) { throw new Error('呼ばれないはず'); }
      return geminiRes(geminiAnalyze());
    }
  });
  const r = post(env, { action: 'analyze', text: '告知の本文' });
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(!calls.some((u) => u.indexOf('api.anthropic.com') !== -1));
  assert.ok(!Array.from(r.warnings).some((w) => /Claude/.test(w)));
});

test('analyze: ANTHROPIC_API_KEY が無ければ切り替えず、いまのエラーのまま', () => {
  const env = fallbackEnv({ status: 503, props: { ANTHROPIC_API_KEY: undefined } });
  const r = post(env, { action: 'analyze', text: '告知の本文' });
  assert.match(r.error, /AI（Gemini）が混み合っていて/);
  assert.ok(!/Claude/.test(r.error));
  assert.strictEqual(env.seen.claude.length, 0);
});

test('analyze: Claude も失敗したら、Gemini のエラーに Claude の失敗を添える（キーは含めない）', () => {
  const cases = [
    [() => res(529, { type: 'error', error: { type: 'overloaded_error', message: 'x claude-secret-key' } }), /HTTP 529: overloaded_error/],
    [() => res(401, { type: 'error', error: { type: 'authentication_error' } }), /HTTP 401: authentication_error/],
    [() => claudeRes('', undefined, { content: [] }), /結果が空でした/],
    [() => claudeRes('{}', undefined, { stop_reason: 'refusal' }), /拒否されました/],
    [() => { throw new Error('通信できません'); }, /通信エラー: 通信できません/]
  ];
  for (const [claude, pattern] of cases) {
    const env = fallbackEnv({ status: 503, claude });
    const r = post(env, { action: 'analyze', text: '告知の本文' });
    assert.match(r.error, /AI（Gemini）が混み合っていて、やり直しても応答がありませんでした/);
    assert.match(r.error, /Claude への切り替えも失敗しました/);
    assert.match(r.error, pattern);
    assert.ok(!r.error.includes('claude-secret-key'), 'エラーにキーを含めない');
  }
});

test('analyze: 画像は、Claude が読める形式（JPEG など）なら一緒に送り、HEIC・HEIF なら切り替えない', () => {
  const jpeg = fallbackEnv({ status: 503 });
  const r1 = post(jpeg, { action: 'analyze', image: { mimeType: 'image/jpeg', data: 'QUJD' } });
  assert.strictEqual(r1.ok, true, r1.error);
  const blocks = jpeg.seen.claude[0].body.messages[0].content;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(blocks[1])), { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });

  const heic = fallbackEnv({ status: 503 });
  const r2 = post(heic, { action: 'analyze', image: { mimeType: 'image/heic', data: 'QUJD' } });
  assert.match(r2.error, /AI（Gemini）が混み合っていて/);
  assert.strictEqual(heic.seen.claude.length, 0);
});

test('summarize: Gemini が 503 のままなら Claude で要約し、モデル名と使用量を返す', () => {
  const env = fallbackEnv({ status: 503, claude: () => claudeRes('Claude の要約', { input_tokens: 1000, output_tokens: 100 }) });
  const r = post(env, { action: 'summarize', text: '長い原文', length: '3lines' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.summary, 'Claude の要約');
  assert.strictEqual(r.fallbackModel, 'claude-haiku-5-5');
  const body = env.seen.claude[0].body;
  assert.ok(!body.output_config.format, '要約は文章で返す（JSON スキーマなし）');
  assert.match(body.system, /3行程度/);
  assert.strictEqual(body.messages[0].content[0].text, '長い原文');
  const rows = env.usageSheet().values;
  assert.strictEqual(rows[rows.length - 1][2], 'claude-haiku-5-5');
});

test('CLAUDE_MODEL でモデルを変えられる。bootstrap は claudeConfigured を返し、キーそのものは返さない', () => {
  const env = fallbackEnv({ status: 503, props: { CLAUDE_MODEL: 'claude-sonnet-5-5' } });
  post(env, { action: 'analyze', text: '告知の本文' });
  assert.strictEqual(env.seen.claude[0].body.model, 'claude-sonnet-5-5');
  const boot = post(load({ props: { ANTHROPIC_API_KEY: 'claude-secret-key' } }), { action: 'bootstrap' });
  assert.strictEqual(boot.claudeConfigured, true);
  assert.ok(!JSON.stringify(boot).includes('claude-secret-key'));
  assert.strictEqual(post(load(), { action: 'bootstrap' }).claudeConfigured, false);
});

test('testClaude: 未設定なら案内を出し、設定済みなら HTTP の番号と要約を出す。キーはログに出さない', () => {
  const logs0 = [];
  const env0 = load();
  env0.context.Logger = { log: (m) => logs0.push(String(m)) };
  env0.context.testClaude();
  assert.match(logs0.join(''), /ANTHROPIC_API_KEY が未設定/);

  const logs = [];
  const env = fallbackEnv({ claude: () => claudeRes('試しの要約') });
  env.context.Logger = { log: (m) => logs.push(String(m)) };
  env.context.testClaude();
  assert.ok(logs.some((l) => /HTTP 200/.test(l)), logs.join('|'));
  assert.ok(logs.some((l) => /読み取れた要約: 試しの要約/.test(l)));
  assert.ok(!logs.join('\n').includes('claude-secret-key'));
  // 構造化出力の試し: 偽の Claude が、整えた結果の JSON を返せば、読み取れた結果がログに出る
  const logs3 = [];
  const env3 = fallbackEnv({ claude: () => claudeRes(geminiAnalyze({ title: '勉強会', attendance: 'hybrid', area: '渋谷' })) });
  env3.context.Logger = { log: (m) => logs3.push(String(m)) };
  env3.context.testClaude();
  assert.ok(logs3.some((l) => /文章を整える形式（構造化出力）: HTTP 200/.test(l)), logs3.join('|'));
  assert.ok(logs3.some((l) => /読み取れた結果: .*勉強会/.test(l)), logs3.join('|'));
  assert.strictEqual(env3.seen.claude.length, 2, '要約と構造化出力の2回');
  assert.ok(env3.seen.claude[1].body.output_config.format.schema, '2回目は JSON スキーマ付き');

  const logs2 = [];
  const env2 = fallbackEnv({ claude: () => res(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key claude-secret-key' } }) });
  env2.context.Logger = { log: (m) => logs2.push(String(m)) };
  env2.context.testClaude();
  assert.ok(logs2.some((l) => /HTTP 401（HTTP 401: authentication_error）/.test(l)), logs2.join('|'));
  assert.ok(!logs2.join('\n').includes('claude-secret-key'));
});

// ---- 入力する人（利用者）の合言葉と権限 --------------------------------

/** 招待を受け取った人が名前を入れて登録する（合言葉なしで呼ぶ） */
function claim(env, code, name) {
  return post(env, { action: 'claimInvite', code, name }, null);
}

/** 管理者が招待を作り、受け取った人が名前を入れて登録する。その人の合言葉と、一覧の上の姿を返す */
function addUser(env, name) {
  const invite = post(env, { action: 'createInvite' });
  assert.strictEqual(invite.ok, true, JSON.stringify(invite));
  const claimed = claim(env, invite.code, name);
  assert.strictEqual(claimed.ok, true, JSON.stringify(claimed));
  const users = post(env, { action: 'listUsers' }).users;
  return { token: claimed.token, user: users.find((u) => u.name === name), users };
}

test('招待: 作ると招待の印が1回だけ返り、GAS には元に戻せない値しか保存しない。一覧には待っている招待が出る', () => {
  const env = load();
  // 本物の UUID（ハイフン込み36文字）で、印が十分な長さの16進になることを確かめる
  env.context.Utilities.getUuid = () => require('node:crypto').randomUUID();
  const invite = post(env, { action: 'createInvite' });
  assert.match(invite.code, /^[0-9a-f]{64}$/);
  assert.ok(!env.props.INVITES_JSON.includes(invite.code), '招待の印そのものを保存してはいけない');
  const listed = post(env, { action: 'listUsers' });
  assert.strictEqual(listed.invites.length, 1);
  assert.strictEqual(listed.invites[0].id, invite.invite.id);
  assert.ok(!JSON.stringify(listed).includes(invite.code));
  assert.ok(!JSON.stringify(listed).includes('hash'));
});

test('招待: 名前を入れると、その人の合言葉が返り、招待は使用済みになる（2回目は使えない）', () => {
  const env = load();
  env.context.Utilities.getUuid = () => require('node:crypto').randomUUID();
  const invite = post(env, { action: 'createInvite' });
  const claimed = claim(env, invite.code, '  花子  ');
  assert.strictEqual(claimed.ok, true, JSON.stringify(claimed));
  assert.match(claimed.token, /^[0-9a-f]{64}$/);
  assert.strictEqual(claimed.name, '花子');
  assert.deepStrictEqual(Object.keys(claimed).sort(), ['name', 'ok', 'token'], 'ほかの情報は返さない');
  assert.ok(!env.props.USERS_JSON.includes(claimed.token), '合言葉そのものを保存してはいけない');
  // 登録した合言葉で使える
  const boot = post(env, { action: 'bootstrap' }, claimed.token);
  assert.strictEqual(boot.role, 'user');
  assert.strictEqual(boot.userName, '花子');
  // 同じリンクは2回目は使えない（複数の人がいるチャットに送られても、先の1人だけ）
  assert.match(claim(env, invite.code, '太郎').error, /この招待リンクは使えません/);
  const listed = post(env, { action: 'listUsers' });
  assert.strictEqual(listed.invites.length, 0);
  assert.deepStrictEqual(listed.users.map((u) => u.name), ['花子']);
});

test('招待: 名前が正しくなければ登録せず、招待は残る（直して同じリンクでやり直せる）', () => {
  const env = load();
  addUser(env, '花子');
  const invite = post(env, { action: 'createInvite' });
  assert.match(claim(env, invite.code, '  ').error, /名前を入力/);
  assert.match(claim(env, invite.code, 'あ'.repeat(31)).error, /30文字以内/);
  assert.match(claim(env, invite.code, '花子').error, /同じ名前/);
  assert.strictEqual(post(env, { action: 'listUsers' }).invites.length, 1);
  assert.strictEqual(claim(env, invite.code, '花子 2').ok, true);
});

test('招待: 取り消した招待・期限切れ（7日）の招待・知らない印は使えない', () => {
  const env = load();
  const cancelled = post(env, { action: 'createInvite' });
  assert.strictEqual(post(env, { action: 'cancelInvite', id: cancelled.invite.id }).invites.length, 0);
  assert.match(claim(env, cancelled.code, '花子').error, /この招待リンクは使えません/);
  assert.match(post(env, { action: 'cancelInvite', id: cancelled.invite.id }).error, /見つかりません/);

  const expired = post(env, { action: 'createInvite' });
  const stored = JSON.parse(env.props.INVITES_JSON);
  const days = (stored[0].expiresAt - Date.now()) / 86400000;
  assert.ok(days > 6.99 && days <= 7, String(days));
  stored[0].expiresAt = Date.now() - 1;
  env.props.INVITES_JSON = JSON.stringify(stored);
  assert.match(claim(env, expired.code, '花子').error, /この招待リンクは使えません/);
  assert.strictEqual(post(env, { action: 'listUsers' }).invites.length, 0, '期限切れは一覧に出ない');

  [undefined, '', 123, 'f'.repeat(64), stored[0].hash].forEach((code) => {
    assert.match(claim(env, code, '花子').error, /この招待リンクは使えません/, String(code));
  });
  assert.strictEqual(post(env, { action: 'listUsers' }).users.length, 0);
});

test('招待: SHARED_TOKEN が未設定なら、名前の登録も拒否する', () => {
  const env = load();
  const invite = post(env, { action: 'createInvite' });
  delete env.props.SHARED_TOKEN;
  assert.match(claim(env, invite.code, '花子').error, /SHARED_TOKEN/);
});

test('招待: 使われていない招待は30件まで', () => {
  const env = load();
  for (let i = 0; i < 30; i++) { assert.strictEqual(post(env, { action: 'createInvite' }).ok, true); }
  assert.match(post(env, { action: 'createInvite' }).error, /30件/);
});

test('利用者: 入力する人の合言葉で、入力・保存・検索ができ、bootstrap は管理者向けの情報を含まない', () => {
  const env = load();
  const { token } = addUser(env, '花子');
  const boot = post(env, { action: 'bootstrap' }, token);
  assert.strictEqual(boot.ok, true);
  assert.strictEqual(boot.role, 'user');
  assert.strictEqual(boot.userName, '花子');
  assert.strictEqual(boot.spreadsheetUrl, '');
  assert.strictEqual(boot.usageThisMonth, null);
  const adminBoot = post(env, { action: 'bootstrap' });
  assert.strictEqual(adminBoot.role, 'admin');
  assert.notStrictEqual(adminBoot.spreadsheetUrl, '');
  assert.strictEqual(post(env, validPost(), token).ok, true);
  assert.strictEqual(post(env, { action: 'search' }, token).items.length, 1);
});

test('利用者: 入力する人は、管理者だけの操作（設定の変更・利用者の管理・公開用シートの同期）ができない', () => {
  const env = load();
  const { token } = addUser(env, '花子');
  const adminOnly = [
    { action: 'addCategory', name: 'X' }, { action: 'removeCategory', name: 'お知らせ' },
    { action: 'reorderCategories', categories: [] }, { action: 'addTag', name: 'X' },
    { action: 'removeTag', name: 'AI' }, { action: 'reorderTags', tags: [] },
    { action: 'addKind', label: 'X' }, { action: 'removeKind', key: 'custom_x' },
    { action: 'addAuthor', name: 'X' }, { action: 'removeAuthor', name: 'X' },
    { action: 'reorderAuthors', authors: [] }, { action: 'syncPublicSheet' },
    { action: 'listUsers' }, { action: 'createInvite' }, { action: 'cancelInvite', id: 'x' },
    { action: 'setUserDisabled', id: 'x', disabled: true }, { action: 'removeUser', id: 'x' }
  ];
  adminOnly.forEach((body) => {
    const result = post(env, body, token);
    assert.strictEqual(result.ok, false, body.action);
    assert.match(result.error, /管理者だけ/, body.action);
  });
  // 管理者の合言葉なら、同じ操作が通る
  assert.strictEqual(post(env, { action: 'addCategory', name: '新カテゴリ' }).ok, true);
});

test('利用者: 編集・削除できるのは、自分が保存した記録だけ（管理者は全部）。保存者の ID は画面に返さない', () => {
  const env = load();
  const hanako = addUser(env, '花子');
  const taro = addUser(env, '太郎');
  const mine = post(env, validPost({ url: 'https://example.com/hanako' }), hanako.token);
  const others = post(env, validPost({ url: 'https://example.com/taro' }), taro.token);
  const adminRecord = post(env, validPost({ url: 'https://example.com/admin' }));
  assert.strictEqual(cell(env, 1, '保存者ID'), hanako.user.id);
  assert.strictEqual(cell(env, 3, '保存者ID'), '');

  // 花子の検索結果: 自分の記録だけ canEdit。保存者の ID・名前は含まれない
  const found = post(env, { action: 'search' }, hanako.token);
  const byUrl = (u) => found.items.find((i) => i.url === u);
  assert.strictEqual(byUrl('https://example.com/hanako').canEdit, true);
  assert.strictEqual(byUrl('https://example.com/taro').canEdit, false);
  assert.strictEqual(byUrl('https://example.com/admin').canEdit, false);
  assert.ok(!JSON.stringify(found).includes('savedBy'));
  assert.ok(!JSON.stringify(found).includes(hanako.user.id));

  // 他の人の記録・管理者の記録は、編集も削除もできない
  [others.id, adminRecord.id].forEach((id) => {
    assert.match(post(env, validPost({ action: 'update', id, title: '書き換え' }), hanako.token).error, /保存した人と管理者だけが編集/);
    assert.match(post(env, { action: 'delete', id }, hanako.token).error, /保存した人と管理者だけが削除/);
  });
  assert.strictEqual(post(env, { action: 'search' }).items.find((i) => i.id === others.id).title, 'タイトル');

  // 自分の記録は編集・削除できる。更新しても保存者は変わらない
  assert.strictEqual(post(env, validPost({ action: 'update', id: mine.id, url: 'https://example.com/hanako', title: '直した' }), hanako.token).ok, true);
  assert.strictEqual(cell(env, 1, 'タイトル'), '直した');
  assert.strictEqual(cell(env, 1, '保存者ID'), hanako.user.id);
  assert.strictEqual(post(env, { action: 'delete', id: mine.id }, hanako.token).ok, true);

  // 管理者は他の人の記録も編集でき、保存者の名前が見える。編集しても保存者は変わらない
  const adminView = post(env, { action: 'search' });
  assert.strictEqual(adminView.items.find((i) => i.id === others.id).savedByName, '太郎');
  assert.strictEqual(adminView.items.find((i) => i.id === others.id).canEdit, true);
  assert.strictEqual(post(env, validPost({ action: 'update', id: others.id, url: 'https://example.com/taro', title: '管理者が直した' })).ok, true);
  assert.strictEqual(cell(env, 1, '保存者ID'), taro.user.id);
});

test('利用者: 止めた人の合言葉は使えなくなり、再開すると使える。消した人の記録は管理者だけが直せる', () => {
  const env = load();
  const hanako = addUser(env, '花子');
  const saved = post(env, validPost(), hanako.token);
  const id = hanako.user.id;

  assert.strictEqual(post(env, { action: 'setUserDisabled', id, disabled: true }).users[0].disabled, true);
  assert.match(post(env, { action: 'bootstrap' }, hanako.token).error, /いまは使えません/);
  assert.strictEqual(post(env, { action: 'setUserDisabled', id, disabled: false }).users[0].disabled, false);
  assert.strictEqual(post(env, { action: 'bootstrap' }, hanako.token).ok, true);

  assert.strictEqual(post(env, { action: 'removeUser', id }).users.length, 0);
  assert.match(post(env, { action: 'bootstrap' }, hanako.token).error, /合言葉が一致しません/);
  // 消した人の記録は残り、管理者の検索では「削除された利用者」と出る
  const item = post(env, { action: 'search' }).items.find((i) => i.id === saved.id);
  assert.strictEqual(item.savedByName, '（削除された利用者）');
  assert.strictEqual(item.canEdit, true);
  assert.match(post(env, { action: 'setUserDisabled', id: 'no-such', disabled: true }).error, /見つかりません/);
});

test('利用者: SHARED_TOKEN が未設定なら、入力する人の合言葉も含めてすべて拒否する', () => {
  const env = load();
  const { token } = addUser(env, '花子');
  delete env.props.SHARED_TOKEN;
  assert.match(post(env, { action: 'bootstrap' }, token).error, /SHARED_TOKEN/);
});

test('利用者: 空・文字列でない・保存されているハッシュそのものを送っても通らない', () => {
  const env = load();
  addUser(env, '花子');
  const stored = JSON.parse(env.props.USERS_JSON)[0].hash;
  const body = { action: 'bootstrap' };
  assert.strictEqual(post(env, body, '').ok, false);
  assert.strictEqual(post(env, body, null).ok, false);
  assert.strictEqual(post(env, body, 12345).ok, false);
  // 保存されている値をそのまま合言葉として送っても、さらにハッシュされるので一致しない
  assert.strictEqual(post(env, body, stored).ok, false);
});

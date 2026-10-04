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
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
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
  const context = {
    SpreadsheetApp: {
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
      // 保存のたびに1秒進む固定の時計（日時の文字列が決定的になるように）
      formatDate: (date, tz, pattern) => {
        if (pattern === 'yyyy-MM-dd') { return '2026-10-02'; }
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
  return { context, calls, props: scriptProps, sheet: () => sheets['投稿一覧'] };
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
    'スレッド詳細（原文）', 'タグ', '開催日時（ISO）', '場所', '申込締切', '出演者', 'メモ', 'ID',
    'トーク本文', '参加URL', '申込URL'
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
  assert.strictEqual(cell(env, 1, 'メモ'), '=1+1');
  assert.strictEqual(cell(env, 1, 'メモ', true), "'=1+1");
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
  assert.deepStrictEqual(Array.from(env.sheet().values[0]).slice(15), ['発信者', 'トーク本文', '参加URL', '申込URL']);

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
    'トーク本文', '参加URL', '申込URL'];
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
  assert.strictEqual(Array.from(sheet.values[0]).length, 4 + 18);
});

test('search: 新しい順・キーワードは原文も対象・カテゴリ/種別/タグ(AND)で絞り込み・50件ずつ', () => {
  const env = load();
  post(env, { action: 'addTag', name: '街頭' });
  post(env, { action: 'addTag', name: '神戸' });
  post(env, validPost({ title: '古い', url: '', original: '原文にだけある語ABC', tags: ['街頭'] }));
  post(env, validPost({ title: '新しい', url: '', category: 'イベント', kind: 'schedule', tags: ['街頭', '神戸'] }));
  assert.deepStrictEqual(post(env, { action: 'search' }).items.map((i) => i.title), ['新しい', '古い']);
  assert.deepStrictEqual(post(env, { action: 'search', keyword: 'abc' }).items.map((i) => i.title), ['古い']);
  assert.deepStrictEqual(post(env, { action: 'search', category: 'イベント' }).items.map((i) => i.title), ['新しい']);
  assert.deepStrictEqual(post(env, { action: 'search', kind: 'article' }).items.map((i) => i.title), ['古い']);
  assert.deepStrictEqual(post(env, { action: 'search', tags: ['街頭', '神戸'] }).items.map((i) => i.title), ['新しい']);
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
  assert.match(post(load({ fetch: () => res(429, 'quota') }), { action: 'analyze', text: '本文' }).error, /Gemini API エラー（HTTP 429）/);
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
  assert.ok(r2.warnings.some((w) => /途中で切れて/.test(w)));
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

test('analyze: 場所は開催形式と地名から「対面（高崎）＆オンライン」の形に組み立てる', () => {
  const cases = [
    [{ attendance: 'hybrid', area: '高崎' }, '対面（高崎）＆オンライン'],
    [{ attendance: 'hybrid', area: '' }, '対面＆オンライン'],
    [{ attendance: 'in_person', area: '神戸三宮' }, '対面（神戸三宮）'],
    [{ attendance: 'in_person', area: '' }, '対面'],
    [{ attendance: 'online', area: '高崎' }, 'オンライン'],
    [{ attendance: 'unknown', area: '高崎' }, '高崎'],
    [{ attendance: 'unknown', area: '' }, '']
  ];
  for (const [input, expected] of cases) {
    const env = load({ fetch: () => geminiRes(geminiAnalyze(input)) });
    assert.strictEqual(post(env, { action: 'analyze', text: '本文' }).event.place, expected, JSON.stringify(input));
  }
  const env = load({ fetch: () => geminiRes(geminiAnalyze()) });
  post(env, { action: 'analyze', text: '本文' });
  const schema = JSON.parse(env.calls[0].payload).generationConfig.responseSchema;
  assert.deepStrictEqual(Array.from(schema.properties.attendance.enum), ['in_person', 'online', 'hybrid', 'unknown']);
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
  assert.match(post(env, validPost({ applyUrl: 'forms.gle/xyz' })).error, /申込 URL の形式/);
  assert.match(post(env, validPost({ talk: 'あ'.repeat(50000) })).error, /長すぎます/);
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

test('findUrlInText_: 追跡用パラメーターや末尾の句読点の違いは同じ URL とみなす', () => {
  const { context } = load();
  const f = context.findUrlInText_;
  assert.strictEqual(f('https://example.com/a', '詳しくは https://example.com/a?utm_source=x。'), 'https://example.com/a?utm_source=x');
  assert.strictEqual(f('https://example.com/a', 'https://example.com/a!'), 'https://example.com/a');
  assert.strictEqual(f('https://example.com/b', 'https://example.com/a'), '');
  assert.strictEqual(f('', 'https://example.com/a'), '');
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

// ---- 公開の一覧（GET ?action=archive） -----------------------------------

/** doGet を ?action=archive で呼ぶ（合言葉なし） */
function getArchive(env) {
  return JSON.parse(env.context.doGet({ parameter: { action: 'archive' } }).getContent());
}

test('公開の一覧: ARCHIVE_PUBLIC が "true" でなければ返さない（初期状態は止めておく）', () => {
  const env = load();
  post(env, validPost({ memo: '秘密のメモ' }));
  const r = getArchive(env);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /公開されていません/);
  assert.strictEqual(r.items, undefined);
  const env2 = load({ props: { ARCHIVE_PUBLIC: 'yes' } });
  assert.strictEqual(getArchive(env2).ok, false, '"true" 以外は止めたまま');
});

test('公開の一覧: 公開してよい項目だけを新しい順に返し、メモと ID は返さない（合言葉なし）', () => {
  const env = load({ props: { ARCHIVE_PUBLIC: 'TRUE' } });
  post(env, validPost({ url: 'https://example.com/old', title: '古い', memo: '秘密のメモ' }));
  post(env, validPost({
    url: 'https://example.com/new', title: '新しい', memo: '秘密のメモ2', author: '運営アカウント',
    kind: 'schedule', source: 'note', eventIso: '2026-10-24T13:00+09:00', place: '対面（高崎）＆オンライン',
    talk: 'トーク本文', original: '原文', joinUrl: 'https://www.youtube.com/live/abc', applyUrl: 'https://forms.gle/x'
  }));
  const r = getArchive(env);
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.items.map((i) => i.title), ['新しい', '古い']);
  const item = r.items[0];
  assert.deepStrictEqual(Object.keys(item).sort(), [
    'applyUrl', 'author', 'category', 'deadline', 'eventIso', 'joinUrl', 'kind', 'kindLabel', 'original',
    'performers', 'place', 'savedAt', 'sourceLabel', 'summary', 'tags', 'talk', 'title', 'url'
  ]);
  assert.strictEqual(item.kindLabel, 'スケジュール');
  assert.strictEqual(item.sourceLabel, 'note');
  assert.strictEqual(item.original, '原文');
  const text = JSON.stringify(r);
  assert.ok(!text.includes('秘密のメモ'), 'メモは出さない');
  assert.ok(!/uuid-/.test(text), 'ID は出さない');
  assert.ok(!text.includes(TOKEN) && !text.includes('gemini-key'), '合言葉・API キーは出さない');
});

test('toPublicItem_: http(s) 以外の URL は空にする', () => {
  const { context } = load();
  const p = context.toPublicItem_({ kind: 'article', source: 'slack', url: 'javascript:alert(1)', joinUrl: 'ftp://x', applyUrl: 'https://ok.example/', tags: [] });
  assert.strictEqual(p.url, '');
  assert.strictEqual(p.joinUrl, '');
  assert.strictEqual(p.applyUrl, 'https://ok.example/');
});

test('doGet: archive 以外の GET は何も返さない／bootstrap は公開の状態を返す', () => {
  const env = load({ props: { ARCHIVE_PUBLIC: 'true' } });
  const r = JSON.parse(env.context.doGet({ parameter: { action: 'search' } }).getContent());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.items, undefined);
  assert.strictEqual(post(env, { action: 'bootstrap' }).archivePublic, true);
  assert.strictEqual(post(load(), { action: 'bootstrap' }).archivePublic, false);
});

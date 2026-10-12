// ============================================================
// js/logic.js（投稿文づくりの純粋関数）のテスト
//
//   重点: 曜日と日付の計算、相対表現、スレッド出力が「前置き＋原文」で
//   原文を一字も変えないこと、分割ロジック、要約の機械チェック。
//   ひな形は本物の gas/Config.gs を読み込んで使う（設定とテストのずれを防ぐ）。
//
//   実行方法: npm test
// ============================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const L = require('../js/logic.js');

/** gas/Config.gs の APP_CONFIG を読み込む（JSON 経由で同じレルムのオブジェクトにする） */
function loadConfig() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'Config.gs'), 'utf8'), context);
  return JSON.parse(vm.runInContext('JSON.stringify(APP_CONFIG)', context));
}
const CONFIG = loadConfig();

// ---- 共有の受け取り・入力元の判定 ------------------------------

test('parseSharedParams: shared_text の本文は URL を含めてそのまま保持する', () => {
  const text = 'お知らせです\n詳しくは https://example.com/a を見てください';
  const r = L.parseSharedParams('?shared_text=' + encodeURIComponent(text));
  assert.strictEqual(r.url, 'https://example.com/a');
  assert.strictEqual(r.text, text);
  assert.strictEqual(r.hasShared, true);
});

test('parseSharedParams: URLだけの共有は本文を空にする', () => {
  const r = L.parseSharedParams('?shared_text=' + encodeURIComponent(' https://x.com/a/status/1 '));
  assert.strictEqual(r.url, 'https://x.com/a/status/1');
  assert.strictEqual(r.text, '');
});

test('parseSharedParams: shared_url を最優先し、何もなければ hasShared=false', () => {
  const r = L.parseSharedParams('?shared_url=' + encodeURIComponent('https://note.com/u/n/n1') +
    '&shared_text=' + encodeURIComponent('タイトル https://other.example/'));
  assert.strictEqual(r.url, 'https://note.com/u/n/n1');
  assert.strictEqual(L.parseSharedParams('').hasShared, false);
});

test('detectSource: ドメインから入力元を推定する', () => {
  assert.strictEqual(L.detectSource('https://x.com/a/status/1'), 'x');
  assert.strictEqual(L.detectSource('https://mobile.twitter.com/a/status/1'), 'x');
  assert.strictEqual(L.detectSource('https://note.com/u/n/nabc'), 'note');
  assert.strictEqual(L.detectSource('https://team.slack.com/archives/C1/p1'), 'slack');
  assert.strictEqual(L.detectSource('https://lin.ee/abc'), 'line');
  assert.strictEqual(L.detectSource('https://example.com/'), '');
  assert.strictEqual(L.detectSource(''), '');
});

// ---- 曜日と日付の計算 ----------------------------------------

test('weekdayOf: 既知の日付の曜日を正しく計算する（うるう日・年またぎ含む）', () => {
  assert.strictEqual(L.weekdayOf('2000-01-01'), '土');
  assert.strictEqual(L.weekdayOf('2024-02-29'), '木');
  assert.strictEqual(L.weekdayOf('2025-01-01'), '水');
  assert.strictEqual(L.weekdayOf('2026-10-03'), '土');
  assert.strictEqual(L.weekdayOf('2026-12-31'), '木');
  assert.strictEqual(L.weekdayOf('2027-01-01'), '金');
});

test('weekdayOf / formatDateJa: 存在しない日付・形式違いは空文字', () => {
  assert.strictEqual(L.weekdayOf('2026-02-29'), '');
  assert.strictEqual(L.weekdayOf('2026-13-01'), '');
  assert.strictEqual(L.weekdayOf('2026/10/03'), '');
  assert.strictEqual(L.weekdayOf(''), '');
  assert.strictEqual(L.formatDateJa('2026-10-03'), '10/3(土)');
  assert.strictEqual(L.formatDateJa('2026-02-30'), '');
});

test('todayIsoInTokyo: UTC では前日でも日本時間の日付を返す', () => {
  // 2026-10-02T15:30Z は日本時間 2026-10-03 00:30
  assert.strictEqual(L.todayIsoInTokyo(new Date('2026-10-02T15:30:00Z')), '2026-10-03');
  assert.strictEqual(L.todayIsoInTokyo(new Date('2026-10-02T14:59:59Z')), '2026-10-02');
});

test('relativeDayLabel: 本日・明日だけを返し、月またぎ・年またぎも正しい', () => {
  assert.strictEqual(L.relativeDayLabel('2026-10-03', '2026-10-03'), '本日');
  assert.strictEqual(L.relativeDayLabel('2026-10-04', '2026-10-03'), '明日');
  assert.strictEqual(L.relativeDayLabel('2026-10-05', '2026-10-03'), '');
  assert.strictEqual(L.relativeDayLabel('2026-10-02', '2026-10-03'), '');
  assert.strictEqual(L.relativeDayLabel('2026-11-01', '2026-10-31'), '明日');
  assert.strictEqual(L.relativeDayLabel('2027-01-01', '2026-12-31'), '明日');
  assert.strictEqual(L.relativeDayLabel('2028-03-01', '2028-02-29'), '明日');
  assert.strictEqual(L.relativeDayLabel('', '2026-10-03'), '');
});

test('buildEventIso / parseEventIso: 往復で元に戻る', () => {
  assert.strictEqual(L.buildEventIso('2026-10-03', '', ''), '2026-10-03');
  assert.strictEqual(L.buildEventIso('2026-10-03', '9:00', ''), '2026-10-03T09:00+09:00');
  const iso = L.buildEventIso('2026-10-03', '19:00', '21:30');
  assert.strictEqual(iso, '2026-10-03T19:00+09:00/2026-10-03T21:30+09:00');
  assert.deepStrictEqual(L.parseEventIso(iso), { date: '2026-10-03', startTime: '19:00', endTime: '21:30' });
  assert.deepStrictEqual(L.parseEventIso('2026-10-03'), { date: '2026-10-03', startTime: '', endTime: '' });
  assert.strictEqual(L.buildEventIso('2026-02-30', '19:00', ''), '');
  assert.strictEqual(L.buildEventIso('2026-10-03', '25:00', ''), '2026-10-03');
  assert.deepStrictEqual(L.parseEventIso('壊れた値'), { date: '', startTime: '', endTime: '' });
});

test('weekdayMismatchWarning: チラシの曜日と計算した曜日の食い違いを警告する', () => {
  assert.strictEqual(L.weekdayMismatchWarning('2026-10-03', '土'), '');
  assert.strictEqual(L.weekdayMismatchWarning('2026-10-03', '(土)'), '');
  assert.match(L.weekdayMismatchWarning('2026-10-03', '日'), /チラシの曜日（日）.*（土）/);
  assert.strictEqual(L.weekdayMismatchWarning('2026-10-03', ''), '');
  assert.strictEqual(L.weekdayMismatchWarning('', '土'), '');
});

// ---- ひな形とトーク本体 ----------------------------------------

test('pickTemplate: 名前が空なら _noAuthor を使い、{author} を残さない', () => {
  assert.strictEqual(L.pickTemplate(CONFIG.sourceLines, 'x', '山田'), 'Xから、{author}さんの投稿です。');
  assert.strictEqual(L.pickTemplate(CONFIG.sourceLines, 'x', ''), 'Xの投稿からの転載です。');
  assert.strictEqual(L.pickTemplate(CONFIG.sourceLines, 'unknown', ''), '');
  // _noAuthor が無く {author} を含むひな形は、名前が空なら other に落とす
  assert.strictEqual(L.pickTemplate({ a: '{author}です', other: 'その他' }, 'a', ''), 'その他');
});

test('isScheduleKind / buildTalkBody: 画面で追加した「日時あり」の種別も、スケジュール型として日時の行を出す', () => {
  const config = Object.assign({}, CONFIG, { kinds: [{ key: 'schedule', schedule: true }, { key: 'article', schedule: false }, { key: 'custom_a', schedule: true }, { key: 'custom_b', schedule: false }] });
  assert.strictEqual(L.isScheduleKind('custom_a', config), true);
  assert.strictEqual(L.isScheduleKind('custom_b', config), false);
  assert.strictEqual(L.isScheduleKind('article', config), false);
  assert.strictEqual(L.isScheduleKind('', config), false);
  // 「日時あり」の印が届かない古い設定（GAS の Config.gs が古いまま等）でも、schedule は日時の行を出す
  assert.strictEqual(L.isScheduleKind('schedule', { kinds: [{ key: 'schedule' }, { key: 'article' }] }), true);
  assert.strictEqual(L.isScheduleKind('article', { kinds: [{ key: 'schedule' }, { key: 'article' }] }), false);
  // 設定に種別の一覧が無い古い状態でも 'schedule' は従来どおり
  assert.strictEqual(L.isScheduleKind('schedule', {}), true);
  const post = { title: 'T', summary: '・要点', kind: 'custom_a', source: 'slack', event: { date: '2026-10-03', startTime: '19:00', endTime: '21:00' } };
  assert.match(L.buildTalkBody(post, config, '2026-10-01'), /📅 10\/3\(土\) 19:00〜21:00/);
  assert.doesNotMatch(L.buildTalkBody(post, config, '2026-10-01'), /・要点/);
  assert.doesNotMatch(L.buildTalkBody(Object.assign({}, post, { kind: 'custom_b' }), config, '2026-10-01'), /📅/);
});

test('buildTalkBody: スケジュール型は概略を載せず「いつ・どこで」を並べ、出典行と定型句を自動で付ける', () => {
  const body = L.buildTalkBody({
    title: 'バイブコーディング勉強会・交流会',
    summary: '・サポーター主催の勉強会\n・初心者歓迎',
    kind: 'schedule',
    source: 'slack',
    author: '',
    event: {
      date: '2026-10-24', startTime: '13:00', endTime: '17:00', place: '対面（高崎）＆オンライン',
      performers: '山田、佐藤', deadline: '2026-10-20'
    }
  }, CONFIG, '2026-10-03');
  assert.strictEqual(body, [
    '【バイブコーディング勉強会・交流会】',
    '',
    '📅 10/24(土) 13:00〜17:00',
    '📍 対面（高崎）＆オンライン',
    '🎤 出演: 山田、佐藤',
    '⏰ 申込締切: 10/20(火)',
    '',
    'Slackからの転載です。',
    '詳細はスレッドにて ➡️'
  ].join('\n'));
});

test('buildTalkBody: スケジュール型でも、日時が空なら日時の行は出さない（未確定の日時を言い切らない）', () => {
  const body = L.buildTalkBody({
    title: '限定配信', summary: '・要点', kind: 'schedule', source: 'slack',
    event: { date: '', startTime: '', endTime: '', place: 'オンライン', performers: '', deadline: '' }
  }, CONFIG, '2026-10-03');
  assert.strictEqual(body, '【限定配信】\n\n📍 オンライン\n\nSlackからの転載です。\n詳細はスレッドにて ➡️');
});

test('buildTalkBody: 相対表現はコピーする日によって変わる（前日なら「明日」、2日前なら無し）', () => {
  const post = { title: 'T', summary: 'S', kind: 'schedule', source: 'other', event: { date: '2026-10-03', startTime: '19:00', endTime: '21:00' } };
  assert.match(L.buildTalkBody(post, CONFIG, '2026-10-02'), /📅 明日 10\/3\(土\) 19:00〜21:00/);
  assert.match(L.buildTalkBody(post, CONFIG, '2026-10-01'), /📅 10\/3\(土\) 19:00〜21:00/);
});

test('buildTalkBody: 記事型は日時行を出さず、X は投稿者名入りの出典行になる', () => {
  const body = L.buildTalkBody({
    title: '政策の解説', summary: '要点です。', kind: 'article', source: 'x', author: '山田太郎',
    event: { date: '2026-10-03' }
  }, CONFIG, '2026-10-03');
  assert.ok(!body.includes('📅'));
  assert.ok(body.includes('Xから、山田太郎さんの投稿です。'));
  // 記事型は概略を載せる
  assert.ok(body.startsWith('【政策の解説】\n要点です。'));
  assert.ok(body.endsWith('詳細はスレッドにて ➡️'));
});

// ---- スレッド: 前置き＋原文、原文を一字も変えない -------------------

test('buildThreadPrefix: 入力元に応じた前置き、要約版は「以下は要約です。」', () => {
  // 初期値（mode 省略）は全文
  assert.strictEqual(L.buildThreadPrefix(CONFIG, 'slack', '', false), '以下はSlackからの転載です。');
  assert.strictEqual(L.buildThreadPrefix(CONFIG, 'x', '山田', false), '↑山田さんの投稿です。');
  assert.strictEqual(L.buildThreadPrefix(CONFIG, 'slack', '', true), '以下は要約です。');
});

test('buildThreadPrefix: 全文と抜粋で書き分け、「（全文）」は付けない', () => {
  const p = (source, author, mode) => L.buildThreadPrefix(CONFIG, source, author, false, mode);
  assert.strictEqual(p('slack', '', 'full'), '以下はSlackからの転載です。');
  assert.strictEqual(p('slack', '', 'excerpt'), '以下はSlackからの抜粋です。');
  assert.strictEqual(p('slack', '運営アカウント', 'excerpt'), '以下はSlackからの抜粋です。発信者は運営アカウントです。');
  assert.strictEqual(p('line', '', 'full'), '以下はLINE公式からの転載です。');
  assert.strictEqual(p('line', '', 'excerpt'), '以下はLINE公式からの抜粋です。');
  assert.strictEqual(p('note', '山田', 'full'), '以下は山田さんのnote記事からの転載です。');
  assert.strictEqual(p('note', '山田', 'excerpt'), '以下は山田さんのnote記事からの抜粋です。');
  assert.strictEqual(p('x', '', 'excerpt'), '↑Xの投稿からの抜粋です。');
  // 要約版は全文・抜粋に関係なく「以下は要約です。」
  assert.strictEqual(L.buildThreadPrefix(CONFIG, 'slack', '', true, 'excerpt'), '以下は要約です。');
  // すべての入力元・発信者の有無・全文/抜粋で、{author} が残らず、「（全文）」も付かない
  CONFIG.sources.forEach((s) => ['', '山田'].forEach((a) => ['full', 'excerpt'].forEach((m) => {
    const text = p(s.key, a, m);
    assert.ok(text && !/\{author\}|（全文）/.test(text), `${s.key}/${a}/${m}: ${text}`);
    assert.strictEqual(/抜粋/.test(text), m === 'excerpt', `${s.key}/${a}/${m}: ${text}`);
  })));
  // 組に分かれていない古い形の設定（フォーク先）もそのまま使える
  assert.strictEqual(L.buildThreadPrefix({ threadPrefixes: { slack: '旧: Slack', other: '旧' } }, 'slack', '', false, 'excerpt'), '旧: Slack');
});

test('normalizeUrl: https:// を補い、空白や %20 を取り除き、URL でないものは変えない', () => {
  assert.strictEqual(L.normalizeUrl('meet.google.com/nrg-dicq-brn'), 'https://meet.google.com/nrg-dicq-brn');
  assert.strictEqual(L.normalizeUrl('https://%20meet.google.com/nrg-dicq-brn'), 'https://meet.google.com/nrg-dicq-brn');
  assert.strictEqual(L.normalizeUrl(' https:// zoom.us/j/1 '), 'https://zoom.us/j/1');
  assert.strictEqual(L.normalizeUrl('HTTP://Example.com/a'), 'HTTP://Example.com/a');
  assert.strictEqual(L.normalizeUrl('localhost:8765'), 'localhost:8765');
  assert.strictEqual(L.normalizeUrl('javascript:alert(1)'), 'javascript:alert(1)');
  assert.strictEqual(L.normalizeUrl(''), '');
  assert.ok(L.isValidUrl('https://meet.google.com/x'));
  assert.ok(!L.isValidUrl('javascript:alert(1)'));
  assert.ok(!L.isValidUrl('https://'));
  assert.ok(!L.isValidUrl('https://a.com/x y'));
});

/** スレッドのメッセージから前置き・コメントを外し、本文部分だけをつなぎ直す */
function bodyFromMessages(messages, prefix, comment) {
  const texts = messages.filter((m) => m.kind === 'text').map((m) => m.text);
  if (prefix) {
    assert.ok(texts[0].startsWith(prefix + '\n\n'), '1通目は前置きで始まる');
    texts[0] = texts[0].slice(prefix.length + 2);
  }
  if (comment) {
    const last = texts.length - 1;
    if (texts[last] === comment) {
      texts.pop();
    } else {
      assert.ok(texts[last].endsWith('\n\n' + comment));
      texts[last] = texts[last].slice(0, -(comment.length + 2));
    }
  }
  return texts;
}

test('buildThreadMessages: 短い原文は「前置き＋原文」の1通で、原文は完全に一致する', () => {
  const original = '  先頭の空白も 全角　スペースも😀絵文字も\nそのまま。\n\n＝数式風の行\n';
  const msgs = L.buildThreadMessages({ source: 'slack', prefix: '以下はSlackからの抜粋転載です。', body: original, maxChars: 1000 });
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].text, '以下はSlackからの抜粋転載です。\n\n' + original.replace(/\n+$/, ''));
});

test('buildThreadMessages: 長文は分割しても、各通の本文をつなぐと原文に一致する（区切り改行以外は不変）', () => {
  const paragraphs = [];
  for (let i = 0; i < 30; i++) {
    paragraphs.push('第' + i + '段落。' + 'あいうえお😀かきくけこ'.repeat(i % 7 + 1));
  }
  const original = paragraphs.join('\n\n');
  const prefix = '以下はnote記事からの抜粋です。';
  const comment = '💬 ぜひ読んでください';
  const msgs = L.buildThreadMessages({ source: 'note', prefix, body: original, maxChars: 200, memo: 'ぜひ読んでください', commentTemplate: CONFIG.commentLine });
  assert.ok(msgs.length > 1);
  msgs.forEach((m) => assert.ok(m.text.length <= 200, '1通の上限を超えない: ' + m.text.length));
  const bodies = bodyFromMessages(msgs, prefix, comment);
  // 区切りの空行で分けているので、空行でつなぎ直すと原文に戻る
  assert.strictEqual(bodies.join('\n\n'), original);
});

test('splitText: どんな入力でも、片をそのままつなぐと元の文字列に完全一致する', () => {
  const samples = [
    '',
    'a',
    '改行なしで、とても長い一続きの文章。'.repeat(40),
    '😀'.repeat(300),
    '\n\n\n先頭に空行\n\n\n\n途中に多い空行\n末尾にも\n\n',
    '一行目\n二行目\n三行目\n'.repeat(50)
  ];
  for (const s of samples) {
    for (const cap of [1, 2, 7, 50, 100]) {
      const chunks = L.splitText(s, cap, cap);
      assert.strictEqual(chunks.join(''), s, 'cap=' + cap);
      chunks.forEach((c) => assert.ok(L.messageText(c).length <= Math.max(cap, 2), 'cap=' + cap + ' len=' + c.length));
    }
  }
});

test('splitText: 絵文字（サロゲートペア）の途中で切らない', () => {
  const chunks = L.splitText('😀'.repeat(10), 3, 3);
  chunks.forEach((c) => {
    assert.ok(!/[\uD800-\uDBFF]$/.test(c), '上位サロゲートで終わらない');
    assert.ok(!/^[\uDC00-\uDFFF]/.test(c), '下位サロゲートで始まらない');
  });
});

test('splitText: 段落の切れ目 → 改行 → 句点 の順で切る', () => {
  const text = 'あ'.repeat(40) + '\n\n' + 'い'.repeat(40) + '\n' + 'う'.repeat(40);
  const chunks = L.splitText(text, 100, 100);
  // 窓（100文字）の中に段落の切れ目と改行の両方があれば、段落の切れ目を優先する
  assert.strictEqual(chunks[0], 'あ'.repeat(40) + '\n\n');
  // 段落の切れ目が無ければ改行で切る
  assert.strictEqual(L.splitText('い'.repeat(40) + '\n' + 'う'.repeat(80), 100, 100)[0], 'い'.repeat(40) + '\n');
  const sentence = 'かきくけこ。'.repeat(10);
  assert.ok(L.splitText(sentence, 20, 20)[0].endsWith('。'));
});

test('buildThreadMessages: X は URL だけの1通と、前置き＋本文の通を分ける', () => {
  const msgs = L.buildThreadMessages({ source: 'x', url: 'https://x.com/a/status/1', prefix: '↑山田さんの投稿です。', body: '投稿の本文', maxChars: 1000 });
  assert.deepStrictEqual(msgs.map((m) => m.kind), ['url', 'text']);
  assert.strictEqual(msgs[0].text, 'https://x.com/a/status/1');
  assert.strictEqual(msgs[1].text, '↑山田さんの投稿です。\n\n投稿の本文');
});

test('buildThreadMessages: コメントが入りきらなければ別の1通にする／本文が空なら前置きだけ', () => {
  const msgs = L.buildThreadMessages({ source: 'other', prefix: 'P', body: 'あ'.repeat(95), maxChars: 100, memo: 'コメントです' });
  assert.strictEqual(msgs[msgs.length - 1].text, '💬 コメントです');
  assert.deepStrictEqual(L.buildThreadMessages({ source: 'other', prefix: 'P', body: '', maxChars: 100 }), [{ kind: 'text', text: 'P' }]);
});

// ---- 要約の機械チェック -----------------------------------------

test('extractFacts: URL・日付・時刻・数字を正規化して取り出す（全角・書き方の違いを吸収）', () => {
  const f = L.extractFacts('2026年10月3日（土）１９：００〜 定員50名、参加費1,000円。https://example.com/e?id=1。10/10も予定');
  assert.deepStrictEqual(f.urls, ['https://example.com/e?id=1']);
  assert.deepStrictEqual(f.dates, ['10/3', '10/10']);
  assert.deepStrictEqual(f.times, ['19:00']);
  assert.deepStrictEqual(f.numbers, ['50', '1000']);
});

test('extractFacts: 「19時半」は時刻、「24時間」は時刻ではなく数字として扱う', () => {
  const f = L.extractFacts('19時半から。24時間受付');
  assert.deepStrictEqual(f.times, ['19:30']);
  assert.deepStrictEqual(f.numbers, ['24']);
});

test('checkSummary: 要約から消えたもの・原文にないものを検出する', () => {
  const original = '10月3日19:00から神戸で開催。定員50名。申込は https://example.com/form から。';
  const good = '10/3 19:00 神戸で開催（定員50名）。申込: https://example.com/form';
  const r1 = L.checkSummary(original, good);
  assert.deepStrictEqual(r1, { missing: [], extra: [] });
  assert.deepStrictEqual(L.summaryWarnings(r1), []);

  const bad = '10/4 19:00 神戸で開催。定員100名。';
  const r2 = L.checkSummary(original, bad);
  assert.deepStrictEqual(r2.missing.map((f) => f.type + ':' + f.value), ['urls:https://example.com/form', 'dates:10/3', 'numbers:50']);
  assert.deepStrictEqual(r2.extra.map((f) => f.type + ':' + f.value), ['dates:10/4', 'numbers:100']);
  const warnings = L.summaryWarnings(r2);
  assert.strictEqual(warnings.length, 2);
  assert.match(warnings[0], /要約から消えています: URL「https:\/\/example.com\/form」/);
  assert.match(warnings[1], /原文にないものが要約にあります: 日付「10\/4」/);
});

test('moveArrayItem: 範囲外の移動は何もしない', () => {
  assert.deepStrictEqual(L.moveArrayItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepStrictEqual(L.moveArrayItem(['a', 'b'], 0, -1), ['a', 'b']);
});

test('uncertainDateWarning: 日付の候補が複数・未定などの表現があれば警告する（コードで検出）', () => {
  assert.match(L.uncertainDateWarning('実施日は10月7日または10月8日のいずれかとなります。'), /確定していない可能性/);
  assert.match(L.uncertainDateWarning('10/7もしくは10/8に開催'), /確定していない/);
  assert.match(L.uncertainDateWarning('日程は未定です。'), /確定していない/);
  assert.match(L.uncertainDateWarning('実施日の確定は直前となる見込みです'), /確定していない/);
  assert.match(L.uncertainDateWarning('詳細は追ってお知らせします'), /確定していない/);
  assert.strictEqual(L.uncertainDateWarning('10月7日 21:30から配信します。'), '');
  // 日付が1つだけなら「または」があっても候補が複数とはみなさない
  assert.strictEqual(L.uncertainDateWarning('10月7日に、YouTubeまたはXで配信します。'), '');
  assert.strictEqual(L.uncertainDateWarning(''), '');
});

test('buildTalkBody: タイトルにすでに【】が付いていても二重にしない', () => {
  const body = L.buildTalkBody({ title: '【限定配信のお知らせ】', summary: '・要点', kind: 'article', source: 'slack' }, CONFIG, '2026-10-03');
  assert.ok(body.startsWith('【限定配信のお知らせ】\n'));
  assert.ok(!body.includes('【【'));
  // 途中に【】がある場合はそのまま（先頭と末尾の両方にあるときだけ外す）
  const body2 = L.buildTalkBody({ title: '【速報】配信のお知らせ', summary: '', kind: 'article', source: 'slack' }, CONFIG, '2026-10-03');
  assert.ok(body2.startsWith('【【速報】配信のお知らせ】'));
  // 「【A】と【B】」は外側だけ外すと壊れるので、そのまま囲む
  const body3 = L.buildTalkBody({ title: '【告知】と【報告】', summary: '', kind: 'article', source: 'slack' }, CONFIG, '2026-10-03');
  assert.ok(body3.startsWith('【【告知】と【報告】】'));
});

test('stripTitleBrackets: 外側の【】・閉じ側が切れた【を外し、中に【】があるものは壊さない', () => {
  assert.strictEqual(L.stripTitleBrackets('【お知らせ】'), 'お知らせ');
  assert.strictEqual(L.stripTitleBrackets(' 【お知らせ '), 'お知らせ');
  assert.strictEqual(L.stripTitleBrackets('【告知】と【報告】'), '【告知】と【報告】');
  assert.strictEqual(L.stripTitleBrackets('【速報】配信'), '【速報】配信');
  assert.strictEqual(L.stripTitleBrackets('お知らせ'), 'お知らせ');
  assert.strictEqual(L.stripTitleBrackets(''), '');
});

test('Slack の前置き: 名前があれば「発信者は○○です。」を足すだけで、全文・抜粋は切り替わらない', () => {
  assert.strictEqual(L.buildThreadPrefix(CONFIG, 'slack', '運営アカウント', false), '以下はSlackからの転載です。発信者は運営アカウントです。');
  assert.strictEqual(L.buildThreadPrefix(CONFIG, 'slack', '', false), '以下はSlackからの転載です。');
  assert.strictEqual(L.buildThreadPrefix(CONFIG, 'slack', '  ', false), '以下はSlackからの転載です。');
  // 要約版は名前に関係なく「以下は要約です。」
  assert.strictEqual(L.buildThreadPrefix(CONFIG, 'slack', '運営アカウント', true), '以下は要約です。');
});

test('Slack のトーク本体の出典行は、名前があっても変えない', () => {
  const body = L.buildTalkBody({ title: 'T', summary: '・要点', kind: 'article', source: 'slack', author: '運営アカウント' }, CONFIG, '2026-10-03');
  assert.ok(body.includes('Slackからの転載です。\n詳細はスレッドにて'));
  assert.ok(!body.includes('運営アカウント'));
});

// ---- スレッドの切り替え・Instagram/Threads ------------------------------

test('detectSource: Instagram・Threads を判定する', () => {
  assert.strictEqual(L.detectSource('https://www.instagram.com/p/ABC/'), 'instagram');
  assert.strictEqual(L.detectSource('https://www.threads.net/@user/post/ABC'), 'threads');
  assert.strictEqual(L.detectSource('https://www.threads.com/@user/post/ABC'), 'threads');
});

test('defaultUseThread: note・一般の Web 記事はスレッドなし、ログインが必要な媒体はあり、URL が無ければ常にあり', () => {
  assert.strictEqual(L.defaultUseThread(CONFIG, 'note', 'https://note.com/a/n/n1'), false);
  assert.strictEqual(L.defaultUseThread(CONFIG, 'other', 'https://example.com/a'), false);
  for (const source of ['slack', 'x', 'instagram', 'threads', 'line', 'legislator', 'flyer']) {
    assert.strictEqual(L.defaultUseThread(CONFIG, source, 'https://example.com/a'), true, source);
  }
  assert.strictEqual(L.defaultUseThread(CONFIG, 'note', ''), true, 'URL が無ければスレッドあり');
  assert.strictEqual(L.defaultUseThread(CONFIG, 'other', '  '), true);
  assert.strictEqual(L.defaultUseThread(CONFIG, '未知の入力元', 'https://example.com/'), true);
});

test('buildTalkBody: スレッドなしなら結びを「全文はこちら ⬇️」＋ URL にし、URL が無ければ結びを出さない', () => {
  const post = {
    title: '国会対策一年史', summary: '・要点1\n・要点2', kind: 'article', source: 'note', author: '須田',
    url: 'https://note.com/btaros/n/n4afd1c591625', useThread: false
  };
  assert.strictEqual(L.buildTalkBody(post, CONFIG, '2026-10-04'), [
    '【国会対策一年史】',
    '・要点1',
    '・要点2',
    '',
    'noteから、須田さんの記事です。',
    '全文はこちら ⬇️',
    'https://note.com/btaros/n/n4afd1c591625'
  ].join('\n'));
  const noUrl = L.buildTalkBody(Object.assign({}, post, { url: '' }), CONFIG, '2026-10-04');
  assert.ok(noUrl.endsWith('noteから、須田さんの記事です。'));
  assert.ok(!noUrl.includes('➡️'));
  // useThread を指定しない（従来の呼び出し）ときはスレッドありとして扱う
  const legacy = L.buildTalkBody(Object.assign({}, post, { useThread: undefined }), CONFIG, '2026-10-04');
  assert.ok(legacy.endsWith('詳細はスレッドにて ➡️'));
});

test('buildThreadMessages: Instagram・Threads も1通目は URL だけ（設定の urlFirstSources に従う）', () => {
  for (const source of ['x', 'instagram', 'threads']) {
    const msgs = L.buildThreadMessages({
      source, url: 'https://example.com/p/1', prefix: '↑投稿です。', body: '本文',
      maxChars: 1000, urlFirstSources: CONFIG.urlFirstSources
    });
    assert.deepStrictEqual(msgs.map((m) => m.kind), ['url', 'text'], source);
  }
  const slack = L.buildThreadMessages({ source: 'slack', url: 'https://example.com/', prefix: 'P', body: '本文', maxChars: 1000, urlFirstSources: CONFIG.urlFirstSources });
  assert.deepStrictEqual(slack.map((m) => m.kind), ['text']);
});

test('ひな形: Instagram・Threads の出典行と前置き（名前あり・なし）', () => {
  assert.strictEqual(L.fillTemplate(L.pickTemplate(CONFIG.sourceLines, 'instagram', '山田'), { author: '山田' }), 'Instagramから、山田さんの投稿です。');
  assert.strictEqual(L.pickTemplate(CONFIG.sourceLines, 'threads', ''), 'Threadsの投稿からの転載です。');
  assert.strictEqual(L.buildThreadPrefix(CONFIG, 'instagram', '山田', false), '↑山田さんのInstagramの投稿です。');
  assert.strictEqual(L.buildThreadPrefix(CONFIG, 'threads', '', false), '↑Threadsの投稿です。');
});

// ---- 参加URL・申込URL・会議URLの警告 -----------------------------------

test('buildTalkBody: スケジュール型は参加URLをトークに出さず、申込URLは申込締切の下に出す', () => {
  const body = L.buildTalkBody({
    title: '勉強会', summary: '', kind: 'schedule', source: 'slack', author: '',
    event: {
      date: '2026-10-24', startTime: '13:00', endTime: '17:00', place: '対面（高崎）＆オンライン',
      joinUrl: 'https://www.youtube.com/live/abc', performers: '', deadline: '2026-10-20',
      applyUrl: 'https://forms.gle/xyz'
    }
  }, CONFIG, '2026-10-04');
  assert.strictEqual(body, [
    '【勉強会】',
    '',
    '📅 10/24(土) 13:00〜17:00',
    '📍 対面（高崎）＆オンライン',
    '⏰ 申込締切: 10/20(火)',
    '📝 申込: https://forms.gle/xyz',
    '',
    'Slackからの転載です。',
    '詳細はスレッドにて ➡️'
  ].join('\n'));
});

test('streamLinkInfo: リンク先で「YouTube で見る」「オンライン会議に参加する」「配信・会議のページを開く」を切り替える', () => {
  const t = (url) => L.streamLinkInfo(url);
  assert.deepStrictEqual(t('https://www.youtube.com/live/abc'), { type: 'youtube', label: 'YouTube で見る' });
  assert.strictEqual(t('https://youtu.be/abc').type, 'youtube');
  assert.strictEqual(t('https://m.youtube.com/watch?v=1').type, 'youtube');
  assert.deepStrictEqual(t('https://us02web.zoom.us/j/123?pwd=x'), { type: 'meeting', label: 'オンライン会議に参加する' });
  assert.strictEqual(t('https://meet.google.com/abc-defg-hij').type, 'meeting');
  assert.strictEqual(t('https://teams.microsoft.com/l/meetup-join/1').type, 'meeting');
  assert.strictEqual(t('https://www.nicovideo.jp/watch/1').label, '配信・会議のページを開く');
  assert.strictEqual(t('https://example.com/youtube.com/').type, 'other', 'パスに含まれるだけなら YouTube ではない');
  assert.strictEqual(t('https://notyoutube.com/').type, 'other', '似た名前のドメインは別物');
  assert.strictEqual(t('').type, 'other');
  assert.strictEqual(t('これはURLではない').type, 'other');
});

test('meetingUrlWarning: Zoom・Meet・Teams などの会議 URL があれば警告し、YouTube などは警告しない', () => {
  assert.match(L.meetingUrlWarning(['https://us02web.zoom.us/j/123?pwd=x']), /オンライン会議の URL/);
  assert.match(L.meetingUrlWarning(['', 'https://meet.google.com/abc-defg-hij']), /meet\.google\.com/);
  assert.match(L.meetingUrlWarning(['https://teams.microsoft.com/l/meetup-join/1']), /公開してよい URL か/);
  assert.strictEqual(L.meetingUrlWarning(['https://www.youtube.com/live/abc', 'https://forms.gle/xyz']), '');
  assert.strictEqual(L.meetingUrlWarning(['https://example.com/zoom.us/']), '', 'パスに含まれるだけなら会議 URL ではない');
  assert.strictEqual(L.meetingUrlWarning([]), '');
});

// ---- 記録の一覧（buildArchiveView） -----------------------------------

const ARCHIVE_ITEMS = [
  { savedAt: '2026-10-04 13:00:00', kindLabel: '議員活動', title: '国会対策の1年', eventIso: '', place: '', author: '須田', talk: 'トーク', original: '長い原文', tags: ['国会'] },
  { savedAt: '2026-10-03 02:00:00', kindLabel: 'スケジュール', title: '勉強会', eventIso: '2026-10-24T13:00+09:00/2026-10-24T17:00+09:00', place: '対面（高崎）＆オンライン', author: '運営', talk: '', original: '', tags: [] },
  { savedAt: '2026-09-28 10:00:00', kindLabel: 'スケジュール', title: 'ポスティング', eventIso: '2026-10-12T10:00+09:00', place: '対面', author: '運営', talk: '', original: '高崎駅前に集合', tags: ['ポスティング'] },
  { savedAt: '2026-09-14 10:00:00', kindLabel: 'スケジュール', title: '説明会', eventIso: '2026-09-20', place: 'オンライン', author: '運営', talk: '', original: '', tags: [] }
];
const titles = (view) => view.rows.filter((r) => r.type === 'item').map((r) => r.item.title);

test('buildArchiveView: 登録日の新しい順に並べ、月が変わるところに区切りを入れる', () => {
  const v = L.buildArchiveView(ARCHIVE_ITEMS, { sortKey: 'saved', dir: 'desc', today: '2026-10-04' });
  assert.deepStrictEqual(v.rows.map((r) => r.type === 'month' ? '#' + r.label : r.item.title),
    ['#2026年10月', '国会対策の1年', '勉強会', '#2026年9月', 'ポスティング', '説明会']);
  assert.strictEqual(v.rows[2].eventLabel, '10/24(土) 13:00〜17:00');
  assert.strictEqual(v.rows[1].savedLabel, '10/4');
  assert.strictEqual(v.total, 4);
  assert.strictEqual(v.hasMore, false);
});

test('buildArchiveView: 検索は原文・タグ・場所も対象で、大文字小文字を区別しない', () => {
  assert.deepStrictEqual(titles(L.buildArchiveView(ARCHIVE_ITEMS, { q: '高崎' })), ['勉強会', 'ポスティング']);
  assert.deepStrictEqual(titles(L.buildArchiveView(ARCHIVE_ITEMS, { q: '国会' })), ['国会対策の1年']);
  assert.deepStrictEqual(titles(L.buildArchiveView(ARCHIVE_ITEMS, { q: '  ' })).length, 4);
  assert.strictEqual(L.buildArchiveView(ARCHIVE_ITEMS, { q: '存在しない語' }).total, 0);
});

test('buildArchiveView: 「開催予定のみ」は開催日が今日以降のものだけ（今日を含む）', () => {
  assert.deepStrictEqual(titles(L.buildArchiveView(ARCHIVE_ITEMS, { upcoming: true, today: '2026-10-04' })), ['勉強会', 'ポスティング']);
  assert.deepStrictEqual(titles(L.buildArchiveView(ARCHIVE_ITEMS, { upcoming: true, today: '2026-10-12' })), ['勉強会', 'ポスティング']);
  assert.deepStrictEqual(titles(L.buildArchiveView(ARCHIVE_ITEMS, { upcoming: true, today: '2026-10-13' })), ['勉強会']);
});

test('buildArchiveView: 開催日の近い順では開催日の無いものを最後にし、月の区切りは入れない', () => {
  const v = L.buildArchiveView(ARCHIVE_ITEMS, { sortKey: 'event', dir: 'asc' });
  assert.deepStrictEqual(titles(v), ['説明会', 'ポスティング', '勉強会', '国会対策の1年']);
  assert.ok(v.rows.every((r) => r.type === 'item'));
  const desc = L.buildArchiveView(ARCHIVE_ITEMS, { sortKey: 'event', dir: 'desc' });
  assert.deepStrictEqual(titles(desc), ['勉強会', 'ポスティング', '説明会', '国会対策の1年'], '降順でも空は最後');
});

test('buildArchiveView: 表示件数の上限と「さらに表示」の判定', () => {
  const v = L.buildArchiveView(ARCHIVE_ITEMS, { sortKey: 'saved', dir: 'desc', limit: 3 });
  assert.strictEqual(v.shown, 3);
  assert.strictEqual(v.total, 4);
  assert.strictEqual(v.hasMore, true);
  assert.deepStrictEqual(titles(v), ['国会対策の1年', '勉強会', 'ポスティング']);
  assert.strictEqual(L.buildArchiveView([], {}).total, 0);
});

const FILTER_ITEMS = [
  { savedAt: '2026-10-05 10:00:00', title: 'A', category: 'イベント', tags: ['AI', '高崎'], eventIso: '', place: '', author: '', talk: '', original: '' },
  { savedAt: '2026-10-04 10:00:00', title: 'B', category: 'イベント', tags: ['AI'], eventIso: '', place: '', author: '', talk: '', original: '' },
  { savedAt: '2026-10-03 10:00:00', title: 'C', category: '活動報告', tags: ['高崎', '街頭'], eventIso: '', place: '', author: '', talk: '', original: '' },
  { savedAt: '2026-10-02 10:00:00', title: 'D', category: '', tags: [], eventIso: '', place: '', author: '', talk: '', original: '' }
];

test('buildArchiveView: カテゴリで絞り込む（空なら全部）', () => {
  assert.deepStrictEqual(titles(L.buildArchiveView(FILTER_ITEMS, { category: 'イベント' })), ['A', 'B']);
  assert.deepStrictEqual(titles(L.buildArchiveView(FILTER_ITEMS, { category: '活動報告' })), ['C']);
  assert.strictEqual(L.buildArchiveView(FILTER_ITEMS, { category: '' }).total, 4);
  assert.strictEqual(L.buildArchiveView(FILTER_ITEMS, { category: '存在しない' }).total, 0);
});

test('buildArchiveView: タグは初期値が OR（どれか1つでも持つ）、and なら全部持つものだけ', () => {
  assert.deepStrictEqual(titles(L.buildArchiveView(FILTER_ITEMS, { tags: ['AI'] })), ['A', 'B']);
  assert.deepStrictEqual(titles(L.buildArchiveView(FILTER_ITEMS, { tags: ['AI', '高崎'] })), ['A', 'B', 'C'], '初期値は OR');
  assert.deepStrictEqual(titles(L.buildArchiveView(FILTER_ITEMS, { tags: ['AI', '高崎'], tagMode: 'or' })), ['A', 'B', 'C']);
  assert.deepStrictEqual(titles(L.buildArchiveView(FILTER_ITEMS, { tags: ['AI', '高崎'], tagMode: 'and' })), ['A']);
  assert.strictEqual(L.buildArchiveView(FILTER_ITEMS, { tags: [] }).total, 4, 'タグを選ばなければ全部');
  assert.strictEqual(L.buildArchiveView(FILTER_ITEMS, { tags: ['存在しない'], tagMode: 'and' }).total, 0);
});

test('buildArchiveView: カテゴリ・タグ・検索・開催予定のみは重ねて（すべて満たすものだけ）効く', () => {
  assert.deepStrictEqual(titles(L.buildArchiveView(FILTER_ITEMS, { category: 'イベント', tags: ['高崎'] })), ['A']);
  assert.deepStrictEqual(titles(L.buildArchiveView(FILTER_ITEMS, { category: 'イベント', tags: ['AI'], q: 'ai' })), ['A', 'B']);
  assert.deepStrictEqual(titles(L.buildArchiveView(FILTER_ITEMS, { category: 'イベント', tags: ['AI'], q: '高崎' })), ['A'], '検索も重なる');
  assert.strictEqual(L.buildArchiveView(FILTER_ITEMS, { category: '活動報告', tags: ['AI'] }).total, 0);
});

test('buildArchiveView: 検索は種別の名前では当たらない（一覧に種別を出さないため）', () => {
  assert.strictEqual(L.buildArchiveView(ARCHIVE_ITEMS, { q: 'スケジュール' }).total, 0);
});

test('archiveFacets: カテゴリとタグを件数の多い順（同数は名前順）に数える。空は除く', () => {
  const f = L.archiveFacets(FILTER_ITEMS);
  assert.deepStrictEqual(f.categories, [{ name: 'イベント', count: 2 }, { name: '活動報告', count: 1 }]);
  assert.deepStrictEqual(f.tags, [{ name: 'AI', count: 2 }, { name: '高崎', count: 2 }, { name: '街頭', count: 1 }]);
  assert.deepStrictEqual(L.archiveFacets([]), { categories: [], tags: [] });
  assert.deepStrictEqual(L.archiveFacets([{ tags: ['x', 'x', ''] }]).tags, [{ name: 'x', count: 1 }], '同じ記録の重複タグは1回');
});

test('formatYen・usageSummaryText: 概算の金額と今月の集計の表示', () => {
  assert.strictEqual(L.formatYen(0), '0 円');
  assert.strictEqual(L.formatYen(0.01), '約 0.1 円未満');
  assert.strictEqual(L.formatYen(0.38), '約 0.4 円');
  assert.strictEqual(L.formatYen(918.4), '約 918 円');
  assert.strictEqual(L.formatYen(12345.6), '約 12,346 円');
  assert.strictEqual(L.usageSummaryText({ month: '2026-10', count: 0, analyzeCount: 0, summarizeCount: 0, yen: 0 }), '2026年10月は、まだ AI を使っていません。');
  assert.strictEqual(L.usageSummaryText({ month: '2026-10', count: 3, analyzeCount: 2, summarizeCount: 1, yen: 0.96 }),
    '2026年10月の概算: 約 1.0 円（文章を整える 2 回・要約 1 回）');
  assert.strictEqual(L.usageSummaryText(null), '');
});

// ---- Slack の絵文字の名前（:○○:）を取り除く --------------------------

test('stripEmojiNames: 行の最後の名前を取り除いたら「。」を付け、途中のものは取り除くだけ', () => {
  const r = L.stripEmojiNames([
    '【今夜は深掘りナイトです:sparkles: 】',
    '交流のためのインタビュー企画です:hand_with_index_finger_and_thumb_crossed:',
    '',
    ' 日時：2026年10月6日(火)21:20~22:00',
    ' ゲスト： @そんちょー さんです:relaxed::clap:',
    '21:20よりスタート致しますので、よろしくお願い致します:mega:',
    '※アーカイブも後日共有致します:+1: （編集済み）'
  ].join('\n'));
  assert.strictEqual(r.text, [
    '【今夜は深掘りナイトです 】',
    '交流のためのインタビュー企画です。',
    '',
    ' 日時：2026年10月6日(火)21:20~22:00',
    ' ゲスト： @そんちょー さんです。',
    '21:20よりスタート致しますので、よろしくお願い致します。',
    '※アーカイブも後日共有致します。'
  ].join('\n'));
  assert.strictEqual(r.count, 6);
});

test('stripEmojiNames: スマホの日本語の名前も取り除き、句読点・閉じかっこで終わる行には「。」を付けない', () => {
  assert.strictEqual(L.stripEmojiNames('企画です:人差し指と親指を交差:').text, '企画です。');
  assert.strictEqual(L.stripEmojiNames('ありがとう！:拍手:').text, 'ありがとう！');
  assert.strictEqual(L.stripEmojiNames('終わりました。 :pray:').text, '終わりました。');
  assert.strictEqual(L.stripEmojiNames('（参加自由）:tada:').text, '（参加自由）');
  // 絵文字だけの行は空の行として残す（「。」だけの行にしない）
  assert.strictEqual(L.stripEmojiNames('上\n:tada::tada:\n下').text, '上\n\n下');
});

test('stripEmojiNames: 時刻・URL・ふつうのコロンは変えない', () => {
  const keep = [
    '時間 21:20~22:00 です',
    '10:30:45 に開始',
    'https://meet.google.com/abc-defg-hij',
    'http://localhost:8765/mock-gas',
    '日時：10月6日',
    '比率は 3:2:1 です',
    '注意:この行は消さない'
  ].join('\n');
  const r = L.stripEmojiNames(keep);
  assert.strictEqual(r.text, keep);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(L.countEmojiNames(keep), 0);
  // 時刻のすぐ後ろの名前は取り除ける
  assert.strictEqual(L.stripEmojiNames('10:30:smile:').text, '10:30。');
});

test('countEmojiNames: 取り除く数と同じ数を返す', () => {
  const text = 'a:sparkles: b:+1::-1:\nc:ピカピカ:';
  assert.strictEqual(L.countEmojiNames(text), 4);
  assert.strictEqual(L.stripEmojiNames(text).count, 4);
  assert.strictEqual(L.countEmojiNames(''), 0);
});

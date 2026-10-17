// ============================================================
// オープンチャット投稿ヘルパー バックエンド（Google Apps Script Webアプリ）
//
//   PWA から本文・URL・画像を受け取り、本文の取得と Gemini による整形
//   （タイトル・概略・種別・日時など）を行い、結果をスプレッドシートに保存する。
//   投稿文の組み立て（出典行・定型句・曜日・「本日」「明日」・分割）は PWA 側で行う。
//
//   前提: このスクリプトは保存先スプレッドシートにコンテナバインドされている。
//   設定（初期カテゴリ・ひな形・議員名一覧など）は Config.gs の APP_CONFIG に置く。
//
//   スクリプトプロパティ（秘密情報はここだけに置く）:
//     SHARED_TOKEN      合言葉（必須。未設定なら全 API を拒否する）
//     GEMINI_API_KEY    Gemini の API キー（必須）
//     GEMINI_MODEL      モデル名（省略時 gemini-3.1-flash-lite）
//     TYPESAFE_API_KEY  Jev の API キー（任意。設定時は種別・カテゴリ・タグを Jev で判定）
//     ARCHIVE_PUBLIC    "true" にすると、記録の一覧（archive.html）用の読み取り専用の入口が動く（任意）
//     PUBLIC_SPREADSHEET_ID  公開用スプレッドシートの ID（任意。createPublicSpreadsheet を実行すると自動で入る）
// ============================================================

// ---- 定数 --------------------------------------------------

var TIME_ZONE = 'Asia/Tokyo';
var DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
var GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
var JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
var JEV_THRESHOLD = 0.5;

var CATEGORIES_PROPERTY = 'CATEGORIES_JSON';
var TAGS_PROPERTY = 'TAGS_JSON';
var AUTHORS_PROPERTY = 'AUTHORS_JSON';
var KINDS_PROPERTY = 'KINDS_JSON';
var MAX_CUSTOM_KINDS = 20;

// 保存先シート。1行1件。
// 列は「見出しの名前」で読み書きする（列の位置は決め打ちしない）。そのため、
//   - スプレッドシート上で列を並べ替えても、アプリはそのまま動く
//   - 利用者が自分で足した列（「投稿済み」など）は、どの位置にあっても触らない
//   - 見出しが見つからない列は、右端に自動で足す
// 見出しの文字を書き換えると、アプリは別の列として扱い、右端に新しい列を作る点に注意
var SHEET_NAME = '投稿一覧';
// 新しくシートを作るときの並び順
var FIELD_ORDER = [
  'savedAt', 'kind', 'author', 'source', 'category', 'title', 'summary', 'url', 'original', 'tags',
  'eventIso', 'place', 'deadline', 'performers', 'memo', 'id', 'talk', 'joinUrl', 'applyUrl', 'postedAt'
];
var FIELD_HEADERS = {
  savedAt: '登録日時', kind: '種別', author: '発信者', source: 'ソース', category: 'カテゴリ',
  title: 'タイトル', summary: '概略', url: 'URL', original: 'スレッド詳細（原文）', tags: 'タグ',
  eventIso: '開催日時（ISO）', place: '場所', deadline: '申込締切', performers: '出演者', memo: 'コメント',
  id: 'ID', talk: 'トーク本文', joinUrl: '参加URL', applyUrl: '申込URL', postedAt: '発信日'
};
var HEADER = FIELD_ORDER.map(function (key) { return FIELD_HEADERS[key]; });
// 以前の見出し（見つかったら今の見出しに書き換える）。memo は、スレッドに添えるコメントの列
var LEGACY_HEADERS = { 'メモ': 'memo' };
var PAGE_SIZE = 50;

// 画像の上限（base64 の文字数。Gemini のリクエスト全体は 20MB まで）
var IMAGE_MAX_BASE64_CHARS = 8000000;
var IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

// 一般的なブラウザに近い UA を名乗る（ボット扱いで拒否されるサイト対策）
var DEFAULT_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) OpenChatPostHelper/1.0';
var MAX_REDIRECT_HOPS = 5;

// 本文として短すぎる（取得に失敗したとみなす）文字数
var MIN_BODY_CHARS = 40;

// ---- エントリポイント ------------------------------------------

/**
 * GET は「記録の一覧」（action=archive）だけを受け付ける。合言葉は不要で、読むだけ。
 * それ以外の API は合言葉を URL に載せてログに残さないよう、すべて POST で受ける。
 */
function doGet(e) {
  var action = String((e && e.parameter && e.parameter.action) || '');
  if (action === 'archive') {
    try {
      return jsonResponse_(handleArchive_());
    } catch (err) {
      return jsonResponse_({ ok: false, error: String((err && err.message) || err) });
    }
  }
  return jsonResponse_({ ok: false, error: 'この URL は PWA から POST で呼び出してください' });
}

/**
 * PWA からの POST を受け取る。本文は JSON（Content-Type は text/plain で届く）。
 * すべての action で、最初に合言葉を照合する。
 */
function doPost(e) {
  try {
    var body = parseJsonBody_(e);
    checkToken_(body.token);

    var action = String(body.action || '');
    switch (action) {
      case 'bootstrap': return jsonResponse_(handleBootstrap_());
      case 'analyze': return jsonResponse_(handleAnalyze_(body));
      case 'summarize': return jsonResponse_(handleSummarize_(body));
      case 'save': return jsonResponse_(withLock_(function () { return handleSave_(body); }));
      case 'update': return jsonResponse_(withLock_(function () { return handleUpdate_(body); }));
      case 'delete': return jsonResponse_(withLock_(function () { return handleDelete_(body); }));
      case 'search': return jsonResponse_(handleSearch_(body));
      case 'addCategory': return jsonResponse_(handleAddListItem_(body, 'category'));
      case 'removeCategory': return jsonResponse_(handleRemoveListItem_(body, 'category'));
      case 'reorderCategories': return jsonResponse_(handleReorderList_(body.categories, 'category'));
      case 'addTag': return jsonResponse_(handleAddListItem_(body, 'tag'));
      case 'removeTag': return jsonResponse_(handleRemoveListItem_(body, 'tag'));
      case 'reorderTags': return jsonResponse_(handleReorderList_(body.tags, 'tag'));
      case 'addKind': return jsonResponse_(withLock_(function () { return handleAddKind_(body); }));
      case 'removeKind': return jsonResponse_(withLock_(function () { return handleRemoveKind_(body); }));
      case 'addAuthor': return jsonResponse_(handleAddListItem_(body, 'author'));
      case 'removeAuthor': return jsonResponse_(handleRemoveListItem_(body, 'author'));
      case 'reorderAuthors': return jsonResponse_(handleReorderList_(body.authors, 'author'));
      case 'syncPublicSheet': return jsonResponse_(withLock_(function () { return syncPublicSheet_(); }));
      default:
        throw new Error('不明な action です: ' + action);
    }
  } catch (err) {
    return jsonResponse_({ ok: false, error: String((err && err.message) || err) });
  }
}

/** POST 本文の JSON を読む。不正なら日本語メッセージの Error を投げる */
function parseJsonBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('リクエスト本文がありません');
  }
  try {
    return JSON.parse(e.postData.contents);
  } catch (parseErr) {
    throw new Error('リクエスト本文の JSON が不正です');
  }
}

/**
 * 合言葉を照合する。SHARED_TOKEN が未設定なら、素通しにせず拒否する。
 */
function checkToken_(token) {
  var expected = getProperty_('SHARED_TOKEN');
  if (!expected) {
    throw new Error('GAS のスクリプトプロパティ SHARED_TOKEN（合言葉）が未設定のため、利用できません。README の手順で設定してください');
  }
  if (typeof token !== 'string' || token !== expected) {
    throw new Error('合言葉が一致しません。PWA の設定画面を確認してください');
  }
}

/** スクリプトプロパティを読む（未設定・読み取り失敗は空文字） */
function getProperty_(key) {
  try {
    return String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
  } catch (e) {
    return '';
  }
}

/** 書き込み系の処理を排他実行する（同時保存で行がずれるのを防ぐ） */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw new Error('ほかの保存処理が混み合っています。少し待ってからやり直してください');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---- bootstrap ---------------------------------------------

/** 画面に渡す設定。種別は、組み込み＋画面で追加したものにする（APP_CONFIG 自体は書き換えない） */
function configForClient_() {
  var copy = {};
  Object.keys(APP_CONFIG).forEach(function (key) { copy[key] = APP_CONFIG[key]; });
  copy.kinds = getKinds_();
  return copy;
}

/**
 * 画面の初期表示に必要な設定を返す（秘密情報は含めない）。
 */
function handleBootstrap_() {
  return {
    ok: true,
    config: configForClient_(),
    categories: getCategories_(),
    tags: getTags_(),
    authors: getAuthors_(),
    geminiConfigured: !!getProperty_('GEMINI_API_KEY'),
    jevConfigured: !!getProperty_('TYPESAFE_API_KEY'),
    model: getProperty_('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL,
    // 保存先スプレッドシートの URL（開けるかどうかは、シートの共有設定と開く人のログインで決まる）
    spreadsheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    archivePublic: getProperty_('ARCHIVE_PUBLIC').toLowerCase() === 'true',
    usageThisMonth: summarizeUsageThisMonth_(),
    publicSpreadsheetUrl: publicSpreadsheetUrl_()
  };
}

// ---- analyze（本文の取得と Gemini による整形） --------------------

/**
 * 入力（URL・本文・画像）から、投稿文の材料を作る。
 * 1. URL があれば本文を取得する（note は本文 API、X は oEmbed、Slack は取得しない）
 * 2. Gemini でタイトル・概略・種別・日時などを構造化 JSON で受け取る
 *    Jev のキーがあれば、種別・カテゴリ・タグは Jev で判定し、Gemini と並列に呼ぶ
 * 3. 議員名タグは議員名一覧との文字列一致で付ける（AI は使わない）
 * 原文（originalText）はここで加工しない。
 */
function handleAnalyze_(body) {
  var input = normalizeAnalyzeInput_(body);
  var warnings = [];

  var fetched = input.url
    ? fetchSourceContent_(input.url)
    : { status: 'none', resolvedUrl: '', text: '', author: '', pageTitle: '', note: '' };
  if (fetched.note) { warnings.push(fetched.note); }

  // 追跡用のパラメーターなどを取り除いた URL を、表示・保存・重複チェックに使う
  var cleanedUrl = cleanUrl_(fetched.resolvedUrl || input.url);
  var postedAt = derivePostedAt_(cleanedUrl, warnings);
  var source = input.source ||
    detectSourceFromUrl_(cleanedUrl) ||
    (input.image ? 'flyer' : 'other');
  var original = chooseOriginal_(input.text, fetched.text);

  var result = {
    ok: true,
    source: source,
    resolvedUrl: cleanedUrl,
    postedAt: postedAt,
    fetchStatus: fetched.status,
    author: fetched.author || '',
    originalText: original,
    originalFromImage: false,
    title: fetched.pageTitle || '',
    summary: '',
    kind: '',
    event: { date: '', startTime: '', endTime: '', place: '', deadline: '', performers: '' },
    imageText: '',
    flyerWeekday: '',
    dateUncertain: false,
    dateNote: '',
    category: '',
    tags: [],
    legislatorTags: [],
    duplicate: findDuplicateByUrl_(cleanedUrl, ''),
    warnings: warnings,
    analyzed: false
  };

  // 本文も画像もない（Slack の URL だけ等）場合は、API を呼ばずに貼り付けを促す
  if (!original && !input.image) {
    if (result.fetchStatus === 'ok' || result.fetchStatus === 'none') {
      result.fetchStatus = 'needs_paste';
    }
    return result;
  }

  var apiKey = getProperty_('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GAS のスクリプトプロパティ GEMINI_API_KEY が未設定です');
  }
  var model = getProperty_('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
  var jevKey = getProperty_('TYPESAFE_API_KEY');
  var limits = APP_CONFIG.limits;
  var categories = getCategories_();
  var tags = getTags_();
  var useJev = !!jevKey && !!original;

  var requests = [buildGeminiAnalyzeRequest_({
    apiKey: apiKey,
    model: model,
    text: truncateText_(original, (limits.llmInputMaxCharsBySource || {})[source] || limits.llmInputMaxChars),
    image: input.image,
    url: result.resolvedUrl,
    source: source,
    today: Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd'),
    categories: categories,
    tags: tags
  })];
  if (useJev) {
    requests.push(buildJevRequest_(jevKey, {
      url: result.resolvedUrl,
      text: truncateText_(original, limits.jevInputMaxChars)
    }, categories, tags));
  }

  var responses = retryGeminiIfBusy_(UrlFetchApp.fetchAll(requests), requests, 0);
  // 使用量は、結果を読み解く前に記録する（読み解きに失敗しても、使った分は残す）
  result.usage = recordUsage_('文章を整える', model, readUsage_(responses[0], useJev ? responses[1] : null));
  var gemini = parseGeminiAnalyzeResponse_(responses[0], categories, tags);

  result.title = gemini.title || result.title;
  result.summary = gemini.summary;
  result.event = gemini.event;
  result.imageText = gemini.imageText;
  result.flyerWeekday = gemini.flyerWeekday;
  result.dateUncertain = gemini.dateUncertain;
  result.dateNote = gemini.dateNote;

  // 種別・カテゴリ・タグは、Jev が使えれば Jev の判定を、使えなければ Gemini の判定を使う
  var classification = { kind: gemini.kind, category: gemini.category, tags: gemini.tags };
  if (useJev) {
    try {
      var jev = parseJevResponse_(responses[1], categories, tags);
      classification = {
        kind: jev.kind || gemini.kind,
        category: jev.category || gemini.category,
        tags: jev.tags
      };
    } catch (jevErr) {
      warnings.push('Jev による分類に失敗したため、Gemini の判定を使いました（GAS エディタで testJev を実行すると詳しい原因がわかります）: ' + jevErr.message);
    }
  }
  result.kind = classification.kind;
  result.category = classification.category;
  result.tags = classification.tags;
  // 開催日が取れているのに種別が決まらないときは、日時の行を出すためスケジュール型として扱う
  if (!result.kind && result.event.date) {
    result.kind = 'schedule';
  }

  // 画像だけの告知は、画像から読み取った文章をスレッド用の原文にする
  if (!original && result.imageText) {
    result.originalText = result.imageText;
    result.originalFromImage = true;
  }

  // 参加 URL・申込 URL は、原文（または画像の読み取り結果）に実際にある URL だけを残す
  var urlSourceText = [result.originalText, result.imageText].join('\n');

  // AI がテレビ出演をオンライン（または不明）と判定しても、原文にテレビ局・番組の手がかりがあれば「テレビ」にする
  var attendance = result.event.attendance;
  delete result.event.attendance;
  if ((attendance === 'online' || attendance === 'unknown') && mentionsTv_([result.title, urlSourceText].join('\n'))) {
    result.event.place = buildPlaceLabel_('tv', '');
  }
  [['joinUrl', '参加 URL'], ['applyUrl', '申込 URL']].forEach(function (pair) {
    var proposed = result.event[pair[0]];
    if (!proposed) { return; }
    var found = findUrlInText_(proposed, urlSourceText);
    result.event[pair[0]] = found ? cleanUrl_(found) : '';
    if (!found) {
      warnings.push('AI が示した' + pair[1] + 'は原文に見つからなかったため、外しました（' + proposed + '）');
    }
  });

  result.legislatorTags = matchLegislators_(
    // 発信者名も対象にする（議員本人の X 投稿・note 記事にもタグを付けるため）
    [result.author, result.title, result.originalText, result.imageText].join('\n'),
    APP_CONFIG.legislators
  );
  result.analyzed = true;
  return result;
}

/** analyze の入力を検証して整える */
function normalizeAnalyzeInput_(body) {
  var url = normalizeUrlInput_(body.url);
  if (url && !isValidUrl_(url)) {
    throw new Error('URL の形式が正しくありません: ' + url);
  }
  var source = String(body.source || '').trim();
  if (source && !findByKey_(APP_CONFIG.sources, source)) {
    throw new Error('不明な入力元です: ' + source);
  }
  var image = null;
  if (body.image && body.image.data) {
    var mimeType = String(body.image.mimeType || '').toLowerCase();
    if (IMAGE_MIME_TYPES.indexOf(mimeType) === -1) {
      throw new Error('対応していない画像形式です: ' + mimeType);
    }
    var data = String(body.image.data);
    if (data.length > IMAGE_MAX_BASE64_CHARS) {
      throw new Error('画像が大きすぎます。小さい画像を選んでください');
    }
    image = { mimeType: mimeType, data: data };
  }
  var text = String(body.text || '');
  if (!url && !text.trim() && !image) {
    throw new Error('URL・本文・画像のどれかを入力してください');
  }
  return { url: url, text: text, source: source, image: image };
}

/**
 * 共有・入力された本文と、URL から取得した本文のうち、長いほうを原文にする。
 * （Chrome の共有は「タイトル URL」だけのことが多く、取得した本文のほうが長い。
 *   逆に X の全文を手で貼った場合は、貼った本文のほうが長い）
 */
function chooseOriginal_(inputText, fetchedText) {
  var a = String(inputText || '');
  var b = String(fetchedText || '');
  if (!a.trim()) { return b; }
  if (!b.trim()) { return a; }
  return b.length > a.length ? b : a;
}

/** 先頭から maxChars 文字に切る（サロゲートペアの途中では切らない） */
function truncateText_(text, maxChars) {
  var value = String(text || '');
  var limit = Number(maxChars) || 0;
  if (!limit || value.length <= limit) { return value; }
  var end = limit;
  var code = value.charCodeAt(end);
  if (code >= 0xDC00 && code <= 0xDFFF) { end--; }
  return value.slice(0, end);
}

/** 配列 [{key,...}] から key が一致する要素を返す（無ければ null） */
function findByKey_(list, key) {
  for (var i = 0; i < (list || []).length; i++) {
    if (list[i].key === key) { return list[i]; }
  }
  return null;
}

/** 配列 [{key,label}] から label が一致する要素を返す（無ければ null） */
function findByLabel_(list, label) {
  for (var i = 0; i < (list || []).length; i++) {
    if (list[i].label === label) { return list[i]; }
  }
  return null;
}

// ---- 本文の取得 --------------------------------------------------

/** URL のドメインから入力元を推定する（js/logic.js の detectSource と同じ規則） */
function detectSourceFromUrl_(url) {
  var m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
  if (!m) { return ''; }
  var host = m[1].toLowerCase().replace(/^www\./, '').replace(/^mobile\./, '');
  if (host === 'x.com' || host === 'twitter.com') { return 'x'; }
  if (host === 'note.com' || /\.note\.jp$/.test(host)) { return 'note'; }
  if (host === 'slack.com' || /\.slack\.com$/.test(host)) { return 'slack'; }
  if (host === 'line.me' || /\.line\.me$/.test(host) || host === 'lin.ee') { return 'line'; }
  if (host === 'instagram.com' || host === 'instagr.am') { return 'instagram'; }
  if (host === 'threads.net' || host === 'threads.com') { return 'threads'; }
  return '';
}

/**
 * URL から本文を取得する。失敗しても例外は投げず、status で知らせる。
 *   status: 'ok'（取得できた）／'needs_paste'（取得できない。本文の貼り付けが必要）
 */
function fetchSourceContent_(url) {
  var empty = function (resolvedUrl, note) {
    return { status: 'needs_paste', resolvedUrl: resolvedUrl, text: '', author: '', pageTitle: '', note: note || '' };
  };

  // ログインが必要で本文を取得できない媒体は、通信せずに貼り付けを促す
  var loginRequired = { slack: 'Slack', instagram: 'Instagram', threads: 'Threads' };
  var loginSource = detectSourceFromUrl_(url);
  if (loginRequired[loginSource]) {
    return empty(url, loginRequired[loginSource] + ' の URL からは本文を取得できません。本文を貼り付けてください');
  }

  var resolvedUrl = resolveFinalUrl_(url);
  var source = detectSourceFromUrl_(resolvedUrl);
  try {
    if (source === 'x') { return fetchXPost_(resolvedUrl); }
    if (source === 'note' && /\/n\/n[0-9a-z]+/i.test(resolvedUrl)) { return fetchNoteArticle_(resolvedUrl); }
    return fetchGenericPage_(resolvedUrl);
  } catch (err) {
    return empty(resolvedUrl, '本文を取得できませんでした（' + String((err && err.message) || err) + '）。本文を貼り付けてください');
  }
}

/**
 * X の投稿本文を oEmbed で取得する。
 * 長い投稿は約250字で切れて返る（無料で全文を取れる経路は無い）。途中切れなら全文の貼り付けを促す。
 */
function fetchXPost_(url) {
  var endpoint = 'https://publish.twitter.com/oembed?omit_script=true&lang=ja&url=' + encodeURIComponent(url);
  var response = UrlFetchApp.fetch(endpoint, { muteHttpExceptions: true, followRedirects: true });
  if (response.getResponseCode() !== 200) {
    throw new Error('X の oEmbed が HTTP ' + response.getResponseCode() + ' を返しました');
  }
  var data = JSON.parse(response.getContentText());
  var parsed = extractXPostText_(String(data.html || ''));
  if (!parsed) {
    throw new Error('X の投稿本文が見つかりませんでした');
  }
  var note = isTruncatedXText_(parsed)
    ? 'X の長い投稿は途中までしか取得できません。X で「さらに表示」を開いて本文をすべてコピーし、本文欄に貼って、もう一度「文章を整える」を押してください'
    : '';
  return {
    status: 'ok',
    resolvedUrl: url,
    text: parsed,
    author: String(data.author_name || ''),
    pageTitle: '',
    note: note
  };
}

/**
 * oEmbed の本文が途中で切れているかを判定する純粋関数。
 * 切れた本文は「…」で終わるか、「…」のあとに画像や URL のリンク（pic.twitter.com/… や https://t.co/…）だけが続く。
 */
function isTruncatedXText_(text) {
  var tail = String(text || '').replace(/(?:\s*(?:https?:\/\/\S+|pic\.twitter\.com\/\S+))+\s*$/, '');
  return /…\s*$/.test(tail);
}

/** oEmbed の HTML（<blockquote><p>本文</p>— 名前 ...</blockquote>）から本文だけを取り出す純粋関数 */
function extractXPostText_(html) {
  var m = String(html || '').match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!m) { return ''; }
  return htmlToText_(m[1]);
}

/** note の記事本文を、記事 API（/api/v3/notes/{key}）から取得する */
function fetchNoteArticle_(url) {
  var key = url.match(/\/n\/(n[0-9a-z]+)/i)[1];
  var response = UrlFetchApp.fetch('https://note.com/api/v3/notes/' + key, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': DEFAULT_USER_AGENT }
  });
  if (response.getResponseCode() !== 200) {
    // 記事 API が使えない場合は、通常のページとして取得を試みる
    return fetchGenericPage_(url);
  }
  var data = (JSON.parse(response.getContentText()) || {}).data || {};
  var text = htmlToText_(String(data.body || ''));
  if (text.length < MIN_BODY_CHARS) {
    return { status: 'needs_paste', resolvedUrl: url, text: text, author: '', pageTitle: String(data.name || ''),
      note: 'note の本文を取得できませんでした（有料記事など）。本文を貼り付けてください' };
  }
  return {
    status: 'ok',
    resolvedUrl: url,
    text: text,
    author: String((data.user && data.user.nickname) || ''),
    pageTitle: String(data.name || ''),
    note: ''
  };
}

/** 一般の Web ページから本文らしき部分を取り出す */
function fetchGenericPage_(url) {
  var response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'User-Agent': DEFAULT_USER_AGENT }
  });
  if (response.getResponseCode() >= 400) {
    throw new Error('ページが HTTP ' + response.getResponseCode() + ' を返しました');
  }
  var html = response.getContentText();
  var charset = detectCharset_(response.getHeaders(), html);
  if (charset && charset.toLowerCase() !== 'utf-8') {
    html = response.getContentText(charset);
  }
  var text = extractMainText_(html);
  var title = extractTitle_(html);
  if (text.length < MIN_BODY_CHARS) {
    return { status: 'needs_paste', resolvedUrl: url, text: '', author: '', pageTitle: title,
      note: 'ページから本文を取得できませんでした。本文を貼り付けてください' };
  }
  return { status: 'ok', resolvedUrl: url, text: text, author: '', pageTitle: title, note: '' };
}

/**
 * HTML から本文らしき部分（<article> → <main> → <body> の順）を取り出してテキストにする純粋関数。
 * script・style・nav・header・footer・aside は除く。
 */
function extractMainText_(html) {
  var cleaned = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|nav|header|footer|aside|form|svg)\b[\s\S]*?<\/\1>/gi, '');
  var tags = ['article', 'main', 'body'];
  for (var i = 0; i < tags.length; i++) {
    var m = cleaned.match(new RegExp('<' + tags[i] + '\\b[^>]*>([\\s\\S]*?)<\\/' + tags[i] + '>', 'i'));
    if (m) {
      var text = htmlToText_(m[1]);
      if (text.length >= MIN_BODY_CHARS || tags[i] === 'body') { return text; }
    }
  }
  return htmlToText_(cleaned);
}

/**
 * HTML 断片をテキストにする純粋関数。
 * 改行（<br>）とブロック要素の終わりを改行にし、タグを除いて実体参照を戻す。
 */
function htmlToText_(html) {
  var text = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '・')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|figure|figcaption|pre|ul|ol|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities_(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * 短縮・リダイレクト URL を、最終的な URL へ解決する（最大 MAX_REDIRECT_HOPS 回）。
 * 解決できなければ、その時点の URL を返す。
 */
function resolveFinalUrl_(url) {
  var currentUrl = url;
  for (var i = 0; i < MAX_REDIRECT_HOPS; i++) {
    var response;
    try {
      response = UrlFetchApp.fetch(currentUrl, {
        muteHttpExceptions: true,
        followRedirects: false,
        headers: { 'User-Agent': DEFAULT_USER_AGENT }
      });
    } catch (fetchErr) {
      return currentUrl;
    }
    var code = response.getResponseCode();
    if (code < 300 || code >= 400) { return currentUrl; }
    var headers = response.getHeaders();
    var location = headers['Location'] || headers['location'];
    if (!location) { return currentUrl; }
    currentUrl = resolveRelativeUrl_(currentUrl, location);
  }
  return currentUrl;
}

/** Location ヘッダの値を、遷移元 URL を基準に絶対 URL へ直す純粋関数 */
function resolveRelativeUrl_(baseUrl, location) {
  if (/^https?:\/\//i.test(location)) { return location; }
  var m = baseUrl.match(/^(https?:\/\/[^/]+)/i);
  var origin = m ? m[1] : '';
  if (location.charAt(0) === '/') { return origin + location; }
  return origin + '/' + location;
}

/** Content-Type ヘッダまたは meta タグから charset を探す（無ければ空文字） */
function detectCharset_(headers, html) {
  var contentType = String(headers['Content-Type'] || headers['content-type'] || '');
  var m = contentType.match(/charset=["']?([\w-]+)/i);
  if (m) { return m[1]; }
  m = String(html || '').match(/<meta[^>]+charset=["']?([\w-]+)/i);
  return m ? m[1] : '';
}

/** HTML からページタイトルを取り出す純粋関数（<title> → og:title） */
function extractTitle_(html) {
  if (!html) { return ''; }
  var m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  var title = m ? m[1] : '';
  if (!title.replace(/\s/g, '')) {
    m = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i);
    title = m ? m[1] : '';
  }
  return decodeEntities_(title).replace(/\s+/g, ' ').trim();
}

/** 代表的な HTML 実体参照と数値文字参照を戻す純粋関数（&amp; は最後に戻す） */
function decodeEntities_(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, function (all, hex) { return codePointToString_(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function (all, dec) { return codePointToString_(parseInt(dec, 10)); })
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&');
}

/** コードポイントを文字にする（絵文字などの補助面の文字にも対応） */
function codePointToString_(code) {
  if (!(code > 0 && code <= 0x10FFFF)) { return ''; }
  if (code <= 0xFFFF) { return String.fromCharCode(code); }
  var offset = code - 0x10000;
  return String.fromCharCode(0xD800 + (offset >> 10), 0xDC00 + (offset & 0x3FF));
}

// ---- Gemini -------------------------------------------------------

/**
 * analyze 用の Gemini リクエスト（UrlFetchApp.fetchAll に渡す形）を作る純粋関数。
 * 種別・カテゴリ・タグも毎回判定させる（Jev があれば Jev を優先し、Gemini の判定は失敗時の予備にする）。
 */
function buildGeminiAnalyzeRequest_(options) {
  var kindKeys = getKinds_().map(function (k) { return k.key; });
  var properties = {
    title: { type: 'STRING', description: '投稿のタイトル。30文字以内。【】は付けない' },
    summaryPoints: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: '概略の要点を2〜5個。1要素に1つの要点を、短く体言止めで（例: サポーター・党員限定の生配信）。行頭の「・」、です・ます体、文末の「。」は付けない。出典や「詳細はスレッドにて」は書かない'
    },
    eventDate: { type: 'STRING', description: '開催日。YYYY-MM-DD の絶対日付。無ければ空文字' },
    startTime: { type: 'STRING', description: '開始時刻。HH:MM（24時間制）。無ければ空文字' },
    endTime: { type: 'STRING', description: '終了時刻。HH:MM（24時間制）。無ければ空文字' },
    attendance: {
      type: 'STRING',
      enum: ['in_person', 'online', 'hybrid', 'tv', 'unknown'],
      description: '開催形式。in_person=対面（現地）のみ、online=オンラインのみ、hybrid=対面とオンラインの両方、tv=テレビ番組への出演・テレビ放送（YouTube やオンライン会議の配信はオンライン）、unknown=開催の告知でない・書かれていない'
    },
    area: { type: 'STRING', description: '対面の場合の地名を数文字で（例: 高崎、神戸三宮、渋谷）。会場名・住所・階数は書かない。対面でなければ空文字' },
    deadline: { type: 'STRING', description: '申込締切日。YYYY-MM-DD の絶対日付。無ければ空文字' },
    joinUrl: { type: 'STRING', description: '参加用の URL（配信・オンライン会議）。本文に書かれている URL をそのまま書き写す。無ければ空文字' },
    applyUrl: { type: 'STRING', description: '申込用の URL（申込フォームなど）。本文に書かれている URL をそのまま書き写す。無ければ空文字' },
    performers: { type: 'STRING', description: '出演者・登壇者。複数なら「、」区切り。無ければ空文字' },
    imageText: { type: 'STRING', description: '画像がある場合、画像内の文字を読みやすく整えた文章。事実は変えない。画像が無ければ空文字' },
    flyerWeekday: { type: 'STRING', description: '画像やチラシに書かれている開催日の曜日（日・月・火・水・木・金・土のどれか1文字）。書かれていなければ空文字' },
    dateUncertain: { type: 'BOOLEAN', description: '開催日時が確定していない（「AまたはB」「いずれか」「未定」「調整中」など）なら true。そのとき eventDate・startTime・endTime は空文字にする' },
    dateNote: { type: 'STRING', description: 'dateUncertain が true のとき、原文に書かれた日時の候補や状況をそのまま短く（例: 10月7日または10月8日、21:30〜）。それ以外は空文字' }
  };
  var required = ['title', 'summaryPoints', 'eventDate', 'startTime', 'endTime', 'attendance', 'area', 'deadline', 'joinUrl', 'applyUrl', 'performers', 'imageText', 'flyerWeekday', 'dateUncertain', 'dateNote'];

  properties.kind = { type: 'STRING', enum: kindKeys, description: '種別' };
  required.push('kind');
  if (options.categories.length) {
    properties.category = { type: 'STRING', enum: options.categories, description: 'カテゴリ' };
    required.push('category');
  }
  if (options.tags.length) {
    properties.tags = { type: 'ARRAY', items: { type: 'STRING', enum: options.tags }, description: '当てはまるタグ（0個以上）' };
    required.push('tags');
  }

  var kindGuide = getKinds_().map(function (k) { return '- ' + k.key + ': ' + k.description; }).join('\n');
  var system = [
    'あなたは「' + APP_CONFIG.teamName + '」の支援者向けに、告知や記事を LINE オープンチャットへ投稿する文章の材料を作る編集者です。',
    '入力の内容だけを根拠にし、書かれていないことを補ったり推測で足したりしないでください。',
    '日付は今日（' + options.today + '）を基準に、年を補って YYYY-MM-DD の絶対日付にしてください。「明日」などの相対表現は使わないでください。',
    '曜日は計算しないでください。画像やチラシに曜日が書かれている場合だけ、書かれている曜日を flyerWeekday に入れてください。',
    '日時が確定していない場合（候補が複数ある、未定、調整中など）は、日付を1つに決めつけず、dateUncertain を true にして eventDate・startTime・endTime を空にしてください。',
    '概略（summaryPoints）は要点を1つずつ配列にし、簡潔に書きます。各要点はできるだけ体言止めにし（例: 「配信を行います。」ではなく「生配信を実施」）、です・ます体は使わず、文末の「。」も付けません。あいさつや前置きは省きます。出典（「Slackからの転載です」等）や「詳細はスレッドにて」は書かないでください。',
    '参加 URL（joinUrl）と申込 URL（applyUrl）は、本文に書かれている URL をそのまま書き写してください。本文に無い URL を作ったり推測したりしないでください。',
    '開催場所は、開催形式（attendance）と、対面の場合の短い地名（area）に分けてください。会場名や住所はスレッドの原文に残るので、area には書きません。',
    'テレビ番組への出演・テレビでの放送（BS・地上波を含む。例: 「BS-TBS 報道1930 出演」）は、オンラインではなく attendance を tv にしてください。YouTube やオンライン会議の配信だけの場合は online です。',
    '種別の定義:\n' + kindGuide
  ].join('\n');

  var userText = [
    '入力元: ' + options.source,
    options.url ? 'URL: ' + options.url : '',
    '本文:',
    options.text || '（本文なし。画像を読み取ってください）'
  ].join('\n');

  var parts = [{ text: userText }];
  if (options.image) {
    parts.push({ inlineData: { mimeType: options.image.mimeType, data: options.image.data } });
  }

  return {
    url: GEMINI_ENDPOINT + encodeURIComponent(options.model) + ':generateContent',
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': options.apiKey },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: parts }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: properties, required: required }
      }
    })
  };
}

/** Gemini が一時的に混み合っているときの HTTP 番号（自動で1回だけやり直す） */
var GEMINI_BUSY_CODES = [500, 503, 504];
/** やり直す前に待つ時間（ミリ秒） */
var GEMINI_RETRY_WAIT_MS = 3000;

/**
 * fetchAll の結果のうち、Gemini の応答（index 番目）が混み合いのエラーなら、
 * 少し待って1回だけ送り直し、結果を差し替える。
 */
function retryGeminiIfBusy_(responses, requests, index) {
  if (GEMINI_BUSY_CODES.indexOf(responses[index].getResponseCode()) === -1) { return responses; }
  Utilities.sleep(GEMINI_RETRY_WAIT_MS);
  var request = requests[index];
  var params = {};
  Object.keys(request).forEach(function (key) { if (key !== 'url') { params[key] = request[key]; } });
  responses[index] = UrlFetchApp.fetch(request.url, params);
  return responses;
}

/** Gemini の応答から本文テキスト（思考パートは除く）を取り出す。失敗時は日本語の Error */
function readGeminiText_(response) {
  var code = response.getResponseCode();
  var raw = response.getContentText();
  if (GEMINI_BUSY_CODES.indexOf(code) !== -1) {
    throw new Error('AI（Gemini）が混み合っていて、やり直しても応答がありませんでした。少し待ってから、もう一度押してください（HTTP ' + code + '）');
  }
  if (code === 429) {
    throw new Error('AI（Gemini）の利用回数が上限に達しました。しばらく待ってから、もう一度押してください（HTTP 429）');
  }
  if (code !== 200) {
    throw new Error('Gemini API エラー（HTTP ' + code + '）: ' + String(raw).slice(0, 300));
  }
  var data = JSON.parse(raw);
  var candidate = data.candidates && data.candidates[0];
  if (!candidate || !candidate.content || !candidate.content.parts) {
    var reason = (candidate && candidate.finishReason) ||
      (data.promptFeedback && data.promptFeedback.blockReason) || '不明';
    throw new Error('Gemini から結果が返りませんでした（理由: ' + reason + '）');
  }
  return candidate.content.parts
    .filter(function (p) { return typeof p.text === 'string' && !p.thought; })
    .map(function (p) { return p.text; })
    .join('');
}

/**
 * analyze の Gemini 応答を解析し、値を検証・整形する。
 * 日付・時刻は形式が不正なら空にする（画面で必ず確認させる）。
 * カテゴリ・タグは登録済みのものだけを残す。
 */
function parseGeminiAnalyzeResponse_(response, categories, tags) {
  var json;
  try {
    json = JSON.parse(readGeminiText_(response));
  } catch (err) {
    if (/Gemini/.test(err.message)) { throw err; }
    throw new Error('Gemini の応答を JSON として読めませんでした');
  }
  var str = function (v) { return typeof v === 'string' ? v.trim() : ''; };
  var date = function (v) { return isValidIsoDate_(str(v)) ? str(v) : ''; };
  var time = function (v) { return /^([01]?\d|2[0-3]):[0-5]\d$/.test(str(v)) ? str(v) : ''; };
  var kindKey = str(json.kind);
  var weekday = str(json.flyerWeekday).match(/[日月火水木金土]/);
  // 日時が未確定なら、AI が日付を入れてきてもコード側で空にする（1つに決めつけた告知を防ぐ）
  var uncertain = json.dateUncertain === true;
  return {
    // トーク本体で【】を付けるので、AI が付けてきた外側の【】は外す（中にも【】があるものはそのまま）
    title: str(json.title).replace(/^【([^【】]*)】?$/, '$1').trim(),
    // 要点の配列で返させる（改行の有無に左右されないため）。古い形式の文字列にも対応する
    summary: stripThreadGuide_(Object.prototype.toString.call(json.summaryPoints) === '[object Array]'
      ? joinSummaryPoints_(json.summaryPoints)
      : normalizeSummaryBullets_(str(json.summary))),
    kind: findByKey_(getKinds_(), kindKey) ? kindKey : '',
    event: {
      date: uncertain ? '' : date(json.eventDate),
      startTime: uncertain ? '' : time(json.startTime),
      endTime: uncertain ? '' : time(json.endTime),
      place: buildPlaceLabel_(str(json.attendance), str(json.area)) || str(json.place),
      attendance: str(json.attendance),
      deadline: date(json.deadline),
      // 原文に https:// なしで書かれた URL（meet.google.com/… など）も受け取る
      joinUrl: isValidUrl_(normalizeUrlInput_(json.joinUrl)) ? normalizeUrlInput_(json.joinUrl) : '',
      applyUrl: isValidUrl_(normalizeUrlInput_(json.applyUrl)) ? normalizeUrlInput_(json.applyUrl) : '',
      performers: str(json.performers)
    },
    imageText: str(json.imageText),
    flyerWeekday: weekday ? weekday[0] : '',
    dateUncertain: uncertain,
    dateNote: uncertain ? str(json.dateNote) : '',
    category: categories.indexOf(str(json.category)) !== -1 ? str(json.category) : '',
    tags: (Object.prototype.toString.call(json.tags) === '[object Array]' ? json.tags : [])
      .filter(function (t) { return tags.indexOf(t) !== -1; })
  };
}

/**
 * 概略を「・」で始まる箇条書きにそろえる純粋関数。
 * 行頭の記号（・ - * • ● 1. など）は「・」に統一し、空行は除く。
 * 改行のない1段落で返ってきた場合は、句点「。」ごとに分けて箇条書きにする。
 * 体言止めに合わせて、各行の末尾の「。」は外す（です・ます体の書き換えは AI への指示に任せる）。
 */
function normalizeSummaryBullets_(text) {
  var lines = String(text || '').split(/\r?\n/)
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line; });
  if (lines.length === 1) {
    var sentences = lines[0].match(/[^。]+。?/g) || [];
    sentences = sentences.map(function (x) { return x.trim(); }).filter(function (x) { return x; });
    if (sentences.length > 1) { lines = sentences; }
  }
  return lines.map(function (line) {
    return '・' + line.replace(/^(?:[・\-*•●○■◆▪]|\d+[.)．、])\s*/, '').replace(/。+$/, '');
  }).join('\n');
}

/**
 * 概略から、トーク用の結び（「詳細はスレッドにて ➡️」「全文はこちら ⬇️」）を取り除く。
 * 結びはトーク本体にだけ付けるもの。AI が概略に混ぜてきたときや、手で入ったときのために、保存前にも通す。
 * その行だけなら行ごと、行の最後に付いていればその部分だけを消す。元から空の行はそのまま残す。
 * detailsOnly が true のときは、「詳細はスレッドにて」だけを消す（「全文はこちら ⬇️」とその下の URL は残す）。
 */
function stripThreadGuide_(text, detailsOnly) {
  var tail = detailsOnly
    ? /[\s　]*詳細はスレッド(?:にて|で)?[\s　]*[➡⬇→↓️]*[\s　]*$/
    : /[\s　]*(?:詳細はスレッド(?:にて|で)?|全文はこちら)[\s　]*[➡⬇→↓️]*[\s　]*$/;
  var out = [];
  String(text === undefined || text === null ? '' : text).split(/\r?\n/).forEach(function (line) {
    var stripped = line.replace(tail, '');
    // 結びだけの行（「・」だけが残る行を含む）は行ごと捨てる
    if (stripped !== line && !stripped.replace(/^[\s　・]+/, '')) { return; }
    out.push(stripped);
  });
  return out.join('\n');
}

/**
 * 概略の要点の配列を「・」の箇条書きにする純粋関数。
 * 要素の中の「・」（「サポーター・党員」など）は区切りとして扱わない。
 */
function joinSummaryPoints_(points) {
  return points
    .filter(function (p) { return typeof p === 'string'; })
    .map(function (p) {
      return p.trim().replace(/^(?:[・\-*•●○■◆▪]|\d+[.)．、])\s*/, '').replace(/。+$/, '').trim();
    })
    .filter(function (p) { return p; })
    .map(function (p) { return '・' + p; })
    .join('\n');
}

/**
 * 開催形式と地名から、トーク用の短い場所の表記を作る純粋関数（書式は Config.gs の placeLabels）。
 *   hybrid + 高崎 → 対面（高崎）＆オンライン ／ online → オンライン ／ tv → テレビ ／ in_person + 高崎 → 対面（高崎）
 *   形式が不明で地名だけあれば地名をそのまま、どちらも無ければ空文字
 */
function buildPlaceLabel_(attendance, area) {
  var labels = APP_CONFIG.placeLabels || {};
  var name = String(area || '').trim();
  var pick = function (key) {
    var template = name ? labels[key] : labels[key + '_noArea'];
    if (template === undefined) { template = labels[key] || ''; }
    return String(template).replace(/\{area\}/g, name);
  };
  if (attendance === 'online') { return labels.online || 'オンライン'; }
  if (attendance === 'tv') { return labels.tv || 'テレビ'; }
  if (attendance === 'in_person' || attendance === 'hybrid') { return pick(attendance); }
  return name;
}

/**
 * 文章に、テレビ出演・放送の手がかり（「テレビ」「地上波」「BS-TBS」「日テレ」など）があるかを返す純粋関数。
 * 「BS」は英字に続くもの（ABS など）を除く。
 */
function mentionsTv_(text) {
  return /テレビ|地上波|日テレ|テレ朝|テレ東|TBS|(?:^|[^A-Za-z])BS[-‐‑ー\s]?(?:朝日|フジ|\d)/.test(String(text || ''));
}

/**
 * 入力された URL を整える純粋関数（js/logic.js の normalizeUrl と同じ規則）。
 *   - 前後の空白を除き、「https://」の直後の空白（%20 を含む）を取り除く
 *   - 「meet.google.com/…」のように https:// が無いドメインの形なら、https:// を補う
 * URL らしくないもの（javascript: など）は変えずに返す（形式の検査は isValidUrl_ で行う）。
 */
function normalizeUrlInput_(text) {
  var s = String(text || '').trim();
  if (!s) { return ''; }
  s = s.replace(/^(https?:\/\/)(?:\s|%20)+/i, '$1');
  if (/^https?:\/\//i.test(s)) { return s; }
  if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(s)) {
    return 'https://' + s;
  }
  return s;
}

/** URL が使える形（http:// か https:// で始まり、空白を含まない）か */
function isValidUrl_(text) {
  return /^https?:\/\/[^\s/?#]+\S*$/i.test(String(text || ''));
}

/**
 * 文章の中から、指定の URL と同じもの（追跡用パラメーターなどの違いは無視）を探して返す純粋関数。
 * 見つからなければ空文字。AI が原文に無い URL を作っていないかを確かめるために使う。
 * 原文に「meet.google.com/…」のように https:// なしで書かれた URL も探し、https:// を補って返す。
 */
function findUrlInText_(url, text) {
  var target = normalizeUrlForCompare_(normalizeUrlInput_(url));
  if (!target) { return ''; }
  var candidates = String(text || '').match(
    /(?:https?:\/\/[^\s"'<>。、「」『』（）]+|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?\/[^\s"'<>。、「」『』（）]*)/gi
  ) || [];
  for (var i = 0; i < candidates.length; i++) {
    var candidate = normalizeUrlInput_(candidates[i].replace(/[.,!?！？]+$/, ''));
    if (normalizeUrlForCompare_(candidate) === target) { return candidate; }
  }
  return '';
}

/** 'YYYY-MM-DD' が実在する日付か */
function isValidIsoDate_(text) {
  var m = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) { return false; }
  var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// ---- 発信日（元の投稿の日付） ------------------------------------

// X の ID（Snowflake）の起点（2010-11-04）。これより小さい ID は連番で、日付を含まない
var X_EPOCH_MS = 1288834974657;
var X_SNOWFLAKE_MIN_ID = '29700859247';
// Instagram・Threads の投稿の番号の起点（2011-08-24）
var INSTAGRAM_EPOCH_MS = 1314220021721;
var INSTAGRAM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** ミリ秒（UTC の時刻）を、日本時間の 'YYYY-MM-DD' にする純粋関数。範囲外なら空文字 */
function msToJstDate_(ms) {
  var min = Date.UTC(2005, 0, 1);
  var max = Date.now() + 24 * 60 * 60 * 1000;
  if (typeof ms !== 'number' || !isFinite(ms) || ms < min || ms > max) { return ''; }
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 投稿の URL に含まれる番号から、発信日（日本時間の 'YYYY-MM-DD'）を計算する純粋関数。通信はしない。
 *   X: 投稿の番号（ID）に時刻が入っている ／ Instagram・Threads: 投稿の短い英数字に時刻が入っている
 *   Slack: メッセージのリンクの p＋数字（秒＋マイクロ秒）
 * 分からなければ空文字。
 */
function postedDateFromUrl_(url) {
  var text = String(url || '');
  var m = text.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/?#]+\/status(?:es)?\/(\d{1,19})/i);
  if (m) {
    var id = BigInt(m[1]);
    if (id < BigInt(X_SNOWFLAKE_MIN_ID)) { return ''; }
    return msToJstDate_(Number((id >> BigInt(22)) + BigInt(X_EPOCH_MS)));
  }

  m = text.match(/^https?:\/\/(?:www\.)?(?:instagram\.com|threads\.(?:net|com))\/(?:[^/?#]+\/)?(?:p|reel|reels|tv|post)\/([A-Za-z0-9_-]{6,11})(?:[/?#]|$)/i);
  if (m) {
    var value = BigInt(0);
    for (var i = 0; i < m[1].length; i++) {
      value = value * BigInt(64) + BigInt(INSTAGRAM_CODE_CHARS.indexOf(m[1].charAt(i)));
    }
    return msToJstDate_(Number((value >> BigInt(23)) + BigInt(INSTAGRAM_EPOCH_MS)));
  }

  m = text.match(/^https?:\/\/(?:[^/?#]+\.)?slack\.com\/archives\/[A-Za-z0-9]+\/p(\d{16})(?:[/?#]|$)/i);
  if (m) { return msToJstDate_(Number(m[1].slice(0, 10)) * 1000); }
  return '';
}

/** YouTube の URL から動画の ID（11文字）を取り出す純粋関数。YouTube でなければ空文字 */
function youtubeVideoId_(url) {
  var m = String(url || '').match(/^https?:\/\/([^/?#]+)([^#]*)/i);
  if (!m) { return ''; }
  var host = m[1].toLowerCase().replace(/^www\./, '').replace(/^m\./, '').replace(/^music\./, '');
  var rest = m[2];
  var id = null;
  if (host === 'youtu.be') {
    id = rest.match(/^\/([A-Za-z0-9_-]{11})(?:[/?]|$)/);
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = rest.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/) ||
      rest.match(/^\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})(?:&|$)/);
  }
  return id ? id[1] : '';
}

/**
 * YouTube Data API（videos.list。1回 1 単位。1日の上限は初期値で 10,000 単位）で、動画の公開日を取る。
 * キー（スクリプトプロパティ YOUTUBE_API_KEY）が無ければ何もしない。失敗しても例外は投げず、note で知らせる。
 * @returns {{ date: string, note: string }}
 */
function fetchYoutubePostedDate_(videoId) {
  var key = getProperty_('YOUTUBE_API_KEY');
  if (!key || !videoId) { return { date: '', note: '' }; }
  try {
    var response = UrlFetchApp.fetch(
      'https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + encodeURIComponent(videoId) +
      '&key=' + encodeURIComponent(key),
      { muteHttpExceptions: true }
    );
    var code = response.getResponseCode();
    if (code !== 200) {
      return { date: '', note: 'YouTube の発信日を取得できませんでした（HTTP ' + code + '）。入力欄に手で入れられます' };
    }
    var items = JSON.parse(response.getContentText()).items || [];
    var published = items.length && items[0].snippet ? String(items[0].snippet.publishedAt || '') : '';
    if (!published) {
      return { date: '', note: 'YouTube の動画が見つからないか、非公開のため、発信日を取得できませんでした' };
    }
    var date = msToJstDate_(Date.parse(published));
    return { date: date, note: date ? '' : 'YouTube の発信日の形式を読み取れませんでした' };
  } catch (err) {
    return { date: '', note: 'YouTube の発信日を取得できませんでした（' + String((err && err.message) || err) + '）' };
  }
}

/** URL から発信日を求める。失敗しても analyze 全体は止めない（空文字を返し、必要なら warnings に足す） */
function derivePostedAt_(url, warnings) {
  try {
    var date = postedDateFromUrl_(url);
    if (date) { return date; }
    var videoId = youtubeVideoId_(url);
    if (!videoId) { return ''; }
    var result = fetchYoutubePostedDate_(videoId);
    if (result.note) { warnings.push(result.note); }
    return result.date;
  } catch (err) {
    return '';
  }
}

// ---- summarize（要約ボタン） --------------------------------------

var SUMMARY_LENGTH_GUIDES = {
  half: '原文のおよそ半分の長さ',
  '3lines': '3行程度'
};

/**
 * 要約ボタンが押されたときだけ呼ばれる。結果は画面で編集できる下書きとして表示する。
 * URL・日付・数字の欠落チェックは画面側のコードで行う（LLM には頼らない）。
 */
function handleSummarize_(body) {
  var text = String(body.text || '');
  if (!text.trim()) {
    throw new Error('要約する本文がありません');
  }
  var length = String(body.length || 'half');
  if (!SUMMARY_LENGTH_GUIDES[length]) {
    throw new Error('要約の長さの指定が不正です: ' + length);
  }
  var apiKey = getProperty_('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GAS のスクリプトプロパティ GEMINI_API_KEY が未設定です');
  }
  var request = buildGeminiSummaryRequest_(
    apiKey,
    getProperty_('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL,
    truncateText_(text, APP_CONFIG.limits.summaryInputMaxChars),
    length
  );
  var response = retryGeminiIfBusy_(UrlFetchApp.fetchAll([request]), [request], 0)[0];
  var usage = recordUsage_('要約', getProperty_('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL, readUsage_(response, null));
  return { ok: true, summary: readGeminiText_(response).trim(), length: length, usage: usage };
}

/** 要約用の Gemini リクエストを作る純粋関数 */
function buildGeminiSummaryRequest_(apiKey, model, text, length) {
  var system = [
    '次の文章を日本語で' + SUMMARY_LENGTH_GUIDES[length] + 'に要約してください。',
    'URL・日付・時刻・数字・人名・地名は、原文の表記のまま残してください。',
    '原文に書かれていないことは書かないでください。',
    '前置き（「以下は要約です」など）や見出しは付けず、要約の本文だけを出力してください。'
  ].join('\n');
  return {
    url: GEMINI_ENDPOINT + encodeURIComponent(model) + ':generateContent',
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: text }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'text/plain' }
    })
  };
}

// ---- Jev（種別・カテゴリ・タグの判定） -----------------------------

/**
 * Jev のリクエストを作る純粋関数。
 * 種別・カテゴリは choice（選択肢のキーは c0, c1… にして、名前の記号の影響を避ける）、
 * タグは1つずつ noul（当てはまる確率）で聞く。
 */
function buildJevRequest_(apiKey, state, categories, tags) {
  var questions = {
    kind: {
      type: 'choice',
      instructions: 'この投稿の種別はどれですか？',
      criteria: choiceCriteria_(getKinds_().map(function (k) { return k.label + '（' + k.description + '）'; }))
    }
  };
  if (categories.length) {
    questions.category = {
      type: 'choice',
      instructions: 'この投稿に最も合うカテゴリはどれですか？',
      criteria: choiceCriteria_(categories)
    };
  }
  tags.forEach(function (tag, index) {
    questions['tag_' + index] = {
      type: 'noul',
      instructions: 'この投稿にタグ「' + tag + '」は当てはまりますか？'
    };
  });
  return {
    url: JEV_ENDPOINT,
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    muteHttpExceptions: true,
    payload: JSON.stringify({ model: 'jev-latest', state: state, questions: questions })
  };
}

/** 選択肢の配列を { c0: 説明, c1: 説明, … } にする */
function choiceCriteria_(descriptions) {
  var criteria = {};
  descriptions.forEach(function (d, i) { criteria['c' + i] = d; });
  return criteria;
}

/** Jev の応答から 種別キー・カテゴリ名・タグ名の配列 を取り出す */
function parseJevResponse_(response, categories, tags) {
  var code = response.getResponseCode();
  var raw = response.getContentText();
  if (code !== 200) {
    throw new Error('Jev API エラー（HTTP ' + code + '）: ' + String(raw).slice(0, 200));
  }
  var answers = (JSON.parse(raw) || {}).answers || {};
  var pick = function (answer, list) {
    var m = answer && typeof answer.choice === 'string' ? answer.choice.match(/^c(\d+)$/) : null;
    return m && list[Number(m[1])] !== undefined ? list[Number(m[1])] : '';
  };
  var kind = pick(answers.kind, getKinds_());
  return {
    kind: kind ? kind.key : '',
    category: pick(answers.category, categories),
    tags: tags.filter(function (tag, index) {
      var a = answers['tag_' + index];
      return a && typeof a.noul === 'number' && a.noul >= JEV_THRESHOLD;
    })
  };
}

// ---- 議員名タグ（文字列一致。AI は使わない） ------------------------

/** 本文に議員名が文字列として含まれていれば、その名前を返す（重複なし・一覧の順） */
function matchLegislators_(text, legislators) {
  var haystack = String(text || '');
  var hits = [];
  (legislators || []).forEach(function (name) {
    var n = String(name || '').trim();
    if (n && haystack.indexOf(n) !== -1 && hits.indexOf(n) === -1) { hits.push(n); }
  });
  return hits;
}

// ---- 保存・一覧（スプレッドシート） ---------------------------------

/**
 * 保存先シートと、列の対応表（項目名 → 列番号。1始まり）を返す。
 * シートが無ければ作り、空なら見出し行を書く。見出しが見つからない項目は右端に足す。
 */
function openSheet_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
    sheet.setFrozenRows(1);
  }
  return { sheet: sheet, cols: ensureColumns_(sheet) };
}

/**
 * 1行目の見出しを読み、項目ごとの列番号を返す。同じ見出しが複数あれば左の列を使う。
 * 見出しが見つからない項目は、右端の空いている列に見出しを書き足す（既存のデータは動かさない）。
 */
function ensureColumns_(sheet) {
  var width = Math.max(sheet.getLastColumn(), 1);
  var header = sheet.getRange(1, 1, 1, width).getValues()[0];
  var keyByHeader = {};
  FIELD_ORDER.forEach(function (key) { keyByHeader[FIELD_HEADERS[key]] = key; });

  var cols = {};
  header.forEach(function (value, index) {
    var key = keyByHeader[String(value === undefined || value === null ? '' : value).trim()];
    if (key && !cols[key]) { cols[key] = index + 1; }
  });
  // 以前の見出し（「メモ」など）があれば、その列を使い、見出しを今の名前に書き換える
  header.forEach(function (value, index) {
    var key = LEGACY_HEADERS[String(value === undefined || value === null ? '' : value).trim()];
    if (key && !cols[key]) {
      cols[key] = index + 1;
      sheet.getRange(1, index + 1, 1, 1).setValues([[FIELD_HEADERS[key]]]);
    }
  });
  var next = width + 1;
  FIELD_ORDER.forEach(function (key) {
    if (!cols[key]) {
      sheet.getRange(1, next, 1, 1).setValues([[FIELD_HEADERS[key]]]);
      cols[key] = next;
      next++;
    }
  });
  return cols;
}

/** データ行（2行目以降）をすべて読み、{ rowNumber, item } の配列で返す */
function readEntries_(ctx) {
  var lastRow = ctx.sheet.getLastRow();
  if (lastRow < 2) { return []; }
  var width = ctx.sheet.getLastColumn();
  return ctx.sheet.getRange(2, 1, lastRow - 1, width).getValues().map(function (row, index) {
    return { rowNumber: index + 2, item: rowToItem_(row, ctx.cols) };
  });
}

/**
 * セルに書く文字列を無害化する純粋関数。
 * 空でない文字列には先頭にアポストロフィを付けて「文字列」として書き込む。
 *   - =, +, -, @ で始まる値が数式として実行されるのを防ぐ（数式インジェクション対策）
 *   - 「2026-10-03」「0120…」などが日付・数値に自動変換されるのを防ぐ
 * アポストロフィはセルの値には含まれない（読み出すと元の文字列に戻る）。
 */
function sanitizeCellText_(text) {
  var value = String(text === undefined || text === null ? '' : text);
  return value ? "'" + value : '';
}

/** 画面から送られた保存内容を検証し、シートに書く形に整える */
function validatePostInput_(body) {
  var limit = APP_CONFIG.limits.cellMaxChars;
  var str = function (v) { return String(v === undefined || v === null ? '' : v); };
  var item = {
    kind: str(body.kind).trim(),
    source: str(body.source).trim(),
    category: str(body.category).trim(),
    title: str(body.title).trim(),
    summary: stripThreadGuide_(str(body.summary)),
    url: normalizeUrlInput_(body.url),
    original: str(body.original),
    tags: normalizeTagsInput_(body.tags),
    eventIso: str(body.eventIso).trim(),
    place: str(body.place).trim(),
    deadline: str(body.deadline).trim(),
    performers: str(body.performers).trim(),
    memo: str(body.memo),
    author: str(body.author).trim(),
    talk: str(body.talk),
    joinUrl: normalizeUrlInput_(body.joinUrl),
    applyUrl: normalizeUrlInput_(body.applyUrl),
    postedAt: str(body.postedAt).trim()
  };

  if (!item.title) { throw new Error('タイトルを入力してください'); }
  if (!findByKey_(getKinds_(), item.kind)) { throw new Error('種別を選んでください'); }
  if (!findByKey_(APP_CONFIG.sources, item.source)) { throw new Error('入力元を選んでください'); }
  if (getCategories_().indexOf(item.category) === -1) { throw new Error('カテゴリを選んでください'); }
  if (item.url && !isValidUrl_(item.url)) { throw new Error('URL の形式が正しくありません'); }
  if (item.joinUrl && !isValidUrl_(item.joinUrl)) { throw new Error('参加 URL の形式が正しくありません'); }
  if (item.applyUrl && !isValidUrl_(item.applyUrl)) { throw new Error('申込 URL の形式が正しくありません'); }
  if (item.eventIso && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}\+09:00(\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+09:00)?)?$/.test(item.eventIso)) {
    throw new Error('開催日時の形式が正しくありません: ' + item.eventIso);
  }
  if (item.eventIso && !isValidIsoDate_(item.eventIso.slice(0, 10))) {
    throw new Error('開催日が存在しない日付です: ' + item.eventIso.slice(0, 10));
  }
  if (item.deadline && !isValidIsoDate_(item.deadline)) {
    throw new Error('申込締切の日付が正しくありません: ' + item.deadline);
  }
  if (item.postedAt && !isValidIsoDate_(item.postedAt)) {
    throw new Error('発信日の日付が正しくありません: ' + item.postedAt);
  }

  var allowedTags = getTags_().concat(APP_CONFIG.legislators || []);
  item.tags.forEach(function (tag) {
    if (allowedTags.indexOf(tag) === -1) { throw new Error('不明なタグです: ' + tag); }
  });

  ['title', 'summary', 'original', 'memo', 'place', 'performers', 'author', 'talk'].forEach(function (key) {
    // アポストロフィの1文字分を見込む
    if (item[key].length + 1 > limit) {
      throw new Error('「' + key + '」が長すぎます（スプレッドシートの1セルは ' + limit + ' 文字まで）');
    }
  });
  return item;
}

/** タグ入力（配列）を、前後空白を除き重複と空を除いた配列にする */
function normalizeTagsInput_(raw) {
  if (Object.prototype.toString.call(raw) !== '[object Array]') { return []; }
  var out = [];
  raw.forEach(function (t) {
    var tag = String(t || '').trim();
    if (tag && out.indexOf(tag) === -1) { out.push(tag); }
  });
  return out;
}

/** 保存内容を、項目ごとのセルの値（無害化済み）にする */
function buildCells_(item, savedAt, id) {
  var cells = {
    savedAt: savedAt,
    kind: findByKey_(getKinds_(), item.kind).label,
    author: item.author,
    source: findByKey_(APP_CONFIG.sources, item.source).label,
    category: item.category,
    title: item.title,
    summary: item.summary,
    url: item.url,
    original: item.original,
    tags: item.tags.join(', '),
    eventIso: item.eventIso,
    place: item.place,
    deadline: item.deadline,
    performers: item.performers,
    memo: item.memo,
    id: id,
    talk: item.talk,
    joinUrl: item.joinUrl,
    applyUrl: item.applyUrl,
    postedAt: item.postedAt
  };
  Object.keys(cells).forEach(function (key) { cells[key] = sanitizeCellText_(cells[key]); });
  return cells;
}

/** シートの1行を、列の対応表に従って画面に返す形のオブジェクトにする */
function rowToItem_(row, cols) {
  var str = function (key) {
    var v = row[cols[key] - 1];
    if (v instanceof Date) {
      return Utilities.formatDate(v, TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
    }
    return String(v === undefined || v === null ? '' : v);
  };
  var kind = findByLabel_(getKinds_(), str('kind'));
  var source = findByLabel_(APP_CONFIG.sources, str('source'));
  return {
    id: str('id').trim(),
    savedAt: str('savedAt'),
    kind: kind ? kind.key : '',
    source: source ? source.key : 'other',
    category: str('category'),
    title: str('title'),
    summary: str('summary'),
    url: str('url'),
    original: str('original'),
    tags: str('tags').split(',').map(function (t) { return t.trim(); }).filter(function (t) { return t; }),
    eventIso: str('eventIso'),
    place: str('place'),
    deadline: str('deadline'),
    performers: str('performers'),
    memo: str('memo'),
    author: str('author'),
    talk: str('talk'),
    joinUrl: str('joinUrl'),
    applyUrl: str('applyUrl'),
    // 手でシートに日付を入れると Date になり「yyyy-MM-dd HH:mm:ss」に直されるので、日付の部分だけ使う。読めなければ空
    postedAt: (function (v) { return isValidIsoDate_(v) ? v : ''; })(str('postedAt').trim().slice(0, 10))
  };
}

// 取り除く追跡用パラメーター（どのサイトでも記事の特定に関係しないもの）
var TRACKING_PARAMS = [
  'fbclid', 'gclid', 'yclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid',
  'ref_src', 'ref_url', 'sub_rt', 'igsh', 'igshid', 'si', '_hsenc', '_hsmi'
];
// サイトごとに取り除くパラメーター（共有ボタンが付けるもの）
var HOST_TRACKING_PARAMS = {
  'x.com': ['s', 't'],
  'twitter.com': ['s', 't'],
  'threads.net': ['xmt', 'slof'],
  'threads.com': ['xmt', 'slof']
};

/**
 * URL を「整える」純粋関数（外部の短縮サービスは使わず、行き先を変えずに短くする）。
 *   - utm_… や fbclid などの追跡用パラメーターと、共有ボタンが付けるパラメーターを取り除く
 *   - Amazon の商品ページは、商品番号（ASIN）だけの公式の短い形（/dp/ASIN）にする
 *   - 記事の特定に必要なパラメーター（YouTube の v= など）と、# 以降は残す
 * URL として読めなければ、前後の空白を除いてそのまま返す。
 */
function cleanUrl_(url) {
  var text = String(url || '').trim();
  var m = text.match(/^(https?:\/\/)([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i);
  if (!m) { return text; }
  var bareHost = m[2].toLowerCase().replace(/^(www|mobile|m)\./, '');

  if (/^amazon\.(co\.jp|com|co\.uk|de|fr|it|es|ca|com\.au|in)$/.test(bareHost)) {
    var asin = m[3].match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})(?:\/|$)/i);
    if (asin) { return 'https://www.' + bareHost + '/dp/' + asin[1].toUpperCase(); }
  }

  var hostParams = HOST_TRACKING_PARAMS[bareHost] || [];
  var query = (m[4] || '').replace(/^\?/, '').split('&').filter(function (pair) {
    if (!pair) { return false; }
    var key = pair.split('=')[0].toLowerCase();
    if (/^utm_/.test(key)) { return false; }
    return TRACKING_PARAMS.indexOf(key) === -1 && hostParams.indexOf(key) === -1;
  }).join('&');
  return m[1] + m[2] + m[3] + (query ? '?' + query : '') + (m[5] || '');
}

/**
 * 重複チェック用に URL を正規化する純粋関数。
 * cleanUrl_ で整えたうえで、ホストの大文字小文字・www.・twitter.com/x.com の違い、
 * http/https の違い、末尾のスラッシュ、パラメーターの順序、# 以降を無視する。
 */
function normalizeUrlForCompare_(url) {
  var m = cleanUrl_(url).match(/^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!m) { return ''; }
  var host = m[1].toLowerCase().replace(/^(www|mobile|m)\./, '');
  if (host === 'twitter.com') { host = 'x.com'; }
  if (host === 'threads.com') { host = 'threads.net'; }
  var pathPart = m[2].replace(/\/+$/, '');
  var query = (m[3] || '').replace(/^\?/, '').split('&').filter(function (pair) { return pair; }).sort().join('&');
  return host + pathPart + (query ? '?' + query : '');
}

/** 同じ URL の保存済み記事を探す（excludeId の行は除く）。無ければ null */
function findDuplicateByUrl_(url, excludeId) {
  var target = normalizeUrlForCompare_(url);
  if (!target) { return null; }
  var entries = readEntries_(openSheet_());
  for (var i = entries.length - 1; i >= 0; i--) {
    var item = entries[i].item;
    if (item.id !== excludeId && normalizeUrlForCompare_(item.url) === target) {
      return { id: item.id, title: item.title, savedAt: item.savedAt };
    }
  }
  return null;
}

/** 保存（action=save）。同じ URL があれば force=true のときだけ保存する */
function handleSave_(body) {
  var item = validatePostInput_(body);
  var duplicate = findDuplicateByUrl_(item.url, '');
  if (duplicate && body.force !== true) {
    return { ok: false, duplicate: duplicate, error: '同じ URL がすでに保存されています（' + duplicate.title + '）' };
  }
  var savedAt = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
  var id = Utilities.getUuid();
  var ctx = openSheet_();
  var cells = buildCells_(item, savedAt, id);
  // 自分で足した列は空欄のまま、アプリの列だけを見出しの位置に入れる
  var row = [];
  for (var c = 0; c < ctx.sheet.getLastColumn(); c++) { row.push(''); }
  FIELD_ORDER.forEach(function (key) { row[ctx.cols[key] - 1] = cells[key]; });
  ctx.sheet.appendRow(row);
  return { ok: true, id: id, savedAt: savedAt, publicSheet: syncPublicSheetSafely_() };
}

/**
 * 1行の中の複数のセルを書き込む。隣り合った列はまとめて1回で書き、書き込みの回数を減らす。
 * targets: [{ col: 列番号（1始まり）, value: 値 }]
 */
function writeCellsInRuns_(sheet, rowNumber, targets) {
  var sorted = targets.slice().sort(function (a, b) { return a.col - b.col; });
  var i = 0;
  while (i < sorted.length) {
    var start = sorted[i].col;
    var values = [sorted[i].value];
    while (i + 1 < sorted.length && sorted[i + 1].col === sorted[i].col + 1) {
      i++;
      values.push(sorted[i].value);
    }
    sheet.getRange(rowNumber, start, 1, values.length).setValues([values]);
    i++;
  }
}

/** ID から行（{ rowNumber, item }）を探す。無ければ null */
function findEntryById_(ctx, id) {
  var entries = readEntries_(ctx);
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].item.id === id) { return entries[i]; }
  }
  return null;
}

/** 編集（action=update）。登録日時と ID はそのまま残す */
function handleUpdate_(body) {
  var id = String(body.id || '').trim();
  if (!id) { throw new Error('編集する投稿が指定されていません'); }
  var item = validatePostInput_(body);
  var ctx = openSheet_();
  var entry = findEntryById_(ctx, id);
  if (!entry) { throw new Error('編集する投稿が見つかりません（削除された可能性があります）'); }

  var duplicate = findDuplicateByUrl_(item.url, id);
  if (duplicate && body.force !== true) {
    return { ok: false, duplicate: duplicate, error: '同じ URL がほかの投稿に保存されています（' + duplicate.title + '）' };
  }
  // アプリの列だけを書き換える（自分で足した列の値や数式は触らない）。登録日時と ID は変えない
  var cells = buildCells_(item, entry.item.savedAt, id);
  var targets = FIELD_ORDER
    .filter(function (key) { return key !== 'savedAt' && key !== 'id'; })
    .map(function (key) { return { col: ctx.cols[key], value: cells[key] }; });
  writeCellsInRuns_(ctx.sheet, entry.rowNumber, targets);
  return { ok: true, id: id, publicSheet: syncPublicSheetSafely_() };
}

/** 削除（action=delete）。行ごと削除する（スプレッドシートの版の履歴からは戻せる） */
function handleDelete_(body) {
  var id = String(body.id || '').trim();
  if (!id) { throw new Error('削除する投稿が指定されていません'); }
  var ctx = openSheet_();
  var entry = findEntryById_(ctx, id);
  if (!entry) { throw new Error('削除する投稿が見つかりません'); }
  ctx.sheet.deleteRow(entry.rowNumber);
  return { ok: true, id: id, publicSheet: syncPublicSheetSafely_() };
}

/**
 * 一覧・検索（action=search）。カテゴリを横断して新しい順に返す。
 *   keyword: タイトル・概略・原文・メモ・タグ・場所・出演者・発信者・トーク本文のどれかに部分一致（大文字小文字を区別しない）
 *   category / kind: 指定したものだけ（空なら全部）
 *   tags: 選んだタグ。tagMode が 'and' ならすべてを持つもの、それ以外（既定）はどれか1つでも持つもの（OR）
 *   offset: 何件目から（PAGE_SIZE 件ずつ）
 */
function handleSearch_(body) {
  var keyword = String(body.keyword || '').trim().toLowerCase();
  var category = String(body.category || '').trim();
  var kind = String(body.kind || '').trim();
  var tags = normalizeTagsInput_(body.tags);
  var matchAll = String(body.tagMode || '').toLowerCase() === 'and';
  var offset = Math.max(0, parseInt(body.offset, 10) || 0);

  var entries = readEntries_(openSheet_());
  var items = [];
  var matched = 0;
  var hasMore = false;
  for (var i = entries.length - 1; i >= 0; i--) {
    var item = entries[i].item;
    if (category && item.category !== category) { continue; }
    if (kind && item.kind !== kind) { continue; }
    if (tags.length) {
      var hasTag = function (t) { return item.tags.indexOf(t) !== -1; };
      if (!(matchAll ? tags.every(hasTag) : tags.some(hasTag))) { continue; }
    }
    if (keyword) {
      var haystack = [item.title, item.summary, item.original, item.memo, item.tags.join(','), item.place, item.performers, item.author, item.talk]
        .join('\n').toLowerCase();
      if (haystack.indexOf(keyword) === -1) { continue; }
    }
    matched++;
    if (matched <= offset) { continue; }
    if (items.length >= PAGE_SIZE) { hasMore = true; break; }
    items.push(item);
  }
  return { ok: true, items: items, offset: offset, hasMore: hasMore };
}

// ---- 公開用スプレッドシート（記録一覧タブ） ---------------------------------

// 公開用シートの列の見出し（Config.gs の publicSheet.columns の key → 見出し）
var PUBLIC_COLUMN_HEADERS = {
  savedAt: '登録日時', postedAt: '発信日', kind: '種別', author: '発信者／出演者', source: 'ソース', category: 'カテゴリ',
  title: 'タイトル', summary: '概略', event: '開催日時', place: '場所', performers: '出演者',
  deadline: '申込締切', joinUrl: '参加URL', applyUrl: '申込URL', url: '元の投稿のURL', tags: 'タグ',
  original: 'スレッド詳細（原文）', comment: 'コメント', talk: 'トーク本文'
};
var WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** 数式の文字列リテラルの中に安全に入れられるよう、ダブルクォートを2つ重ねる純粋関数 */
function escapeFormulaString_(text) {
  return String(text === undefined || text === null ? '' : text).replace(/"/g, '""');
}

/** 'YYYY-MM-DD' を「2026/10/24(土)」にする純粋関数（読めなければ空文字） */
function sheetDateLabel_(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m || !isValidIsoDate_(m[0])) { return ''; }
  var day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return m[1] + '/' + Number(m[2]) + '/' + Number(m[3]) + '(' + WEEKDAYS_JA[day] + ')';
}

/** 開催日時（ISO）を「2026/10/24(土) 13:00〜17:00」にする純粋関数 */
function sheetEventLabel_(eventIso) {
  var text = String(eventIso || '');
  var date = sheetDateLabel_(text);
  if (!date) { return ''; }
  var start = text.match(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/);
  var end = text.match(/\/\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/);
  return start ? date + ' ' + start[1] + '〜' + (end ? end[1] : '') : date;
}

/** 記録の一覧ページで、その投稿を開いた状態にするリンク（archiveUrl が無ければ空文字） */
function archiveDetailUrl_(publicItem) {
  var base = String((APP_CONFIG.publicSheet || {}).archiveUrl || '');
  if (!/^https?:\/\/\S+$/i.test(base)) { return ''; }
  return base + '?q=' + encodeURIComponent(publicItem.title || '') + '&at=' + encodeURIComponent(publicItem.savedAt || '');
}

/**
 * 公開用シートの1セルの値を作る純粋関数。
 * タイトルは記録の一覧ページへのリンク（HYPERLINK の数式。文字列はダブルクォートを重ねて安全にする）。
 * それ以外は sanitizeCellText_ で文字列として書く（数式インジェクション対策）。
 */
function publicCellValue_(key, p) {
  if (key === 'title') {
    var link = archiveDetailUrl_(p);
    if (link) {
      return '=HYPERLINK("' + escapeFormulaString_(link) + '","' + escapeFormulaString_(p.title) + '")';
    }
    return sanitizeCellText_(p.title);
  }
  var values = {
    kind: p.kindLabel, source: p.sourceLabel, event: sheetEventLabel_(p.eventIso), postedAt: sheetDateLabel_(p.postedAt),
    deadline: sheetDateLabel_(p.deadline), tags: (p.tags || []).join('、')
  };
  var value = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : p[key];
  return sanitizeCellText_(value === undefined || value === null ? '' : value);
}

/** 公開用スプレッドシートの URL（未設定なら空文字）。ファイルを開かずに組み立てる */
function publicSpreadsheetUrl_() {
  var id = getProperty_('PUBLIC_SPREADSHEET_ID');
  return id ? 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(id) + '/edit' : '';
}

/**
 * 公開用スプレッドシートの「記録一覧」タブを、登録用のシートの内容で丸ごと書き直す。
 * 載せるのは記録の一覧と同じ「公開してよい項目」から、Config.gs の publicSheet.columns の列だけ（ID は載せない）。
 * PUBLIC_SPREADSHEET_ID が未設定なら何もしない。ほかのタブには触らない。
 */
function syncPublicSheet_() {
  var id = getProperty_('PUBLIC_SPREADSHEET_ID');
  if (!id) { return { ok: true, skipped: true, count: 0 }; }
  var conf = APP_CONFIG.publicSheet || {};
  var tabName = conf.tabName || '記録一覧';
  var columns = (conf.columns || []).filter(function (key) { return PUBLIC_COLUMN_HEADERS[key]; });
  if (!columns.length) { throw new Error('公開用シートの列（Config.gs の publicSheet.columns）がありません'); }

  var file = SpreadsheetApp.openById(id);
  var tab = file.getSheetByName(tabName) || file.insertSheet(tabName);
  var entries = readEntries_(openSheet_());
  var rows = [columns.map(function (key) { return PUBLIC_COLUMN_HEADERS[key]; })];
  for (var i = entries.length - 1; i >= 0; i--) {
    var p = toPublicItem_(entries[i].item);
    rows.push(columns.map(function (key) { return publicCellValue_(key, p); }));
  }

  var oldRows = tab.getLastRow();
  var oldCols = tab.getLastColumn();
  if (oldRows > 0 && oldCols > 0) {
    tab.getRange(1, 1, oldRows, oldCols).clearContent();
  }
  tab.getRange(1, 1, rows.length, columns.length).setValues(rows);
  tab.setFrozenRows(1);
  tab.getRange(1, 1, 1, columns.length).setFontWeight('bold');
  // 長い文でも行の高さがそろうよう、折り返さずにセルの幅で切って表示する
  tab.getRange(1, 1, rows.length, columns.length).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  return { ok: true, count: rows.length - 1 };
}

/** 保存・更新・削除のあとに呼ぶ。失敗しても保存自体は止めず、結果を返す */
function syncPublicSheetSafely_() {
  try {
    return syncPublicSheet_();
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 初回セットアップ用: GAS エディタでこの関数を1回実行すると、公開用スプレッドシートを作り、
 * スクリプトプロパティ PUBLIC_SPREADSHEET_ID に登録して、「記録一覧」タブを書き込む。
 * すでに登録済みなら、新しくは作らずに書き直すだけ。
 */
function createPublicSpreadsheet() {
  var tabName = (APP_CONFIG.publicSheet || {}).tabName || '記録一覧';
  if (!getProperty_('PUBLIC_SPREADSHEET_ID')) {
    var file = SpreadsheetApp.create(APP_CONFIG.teamName + ' オープンチャット 記録一覧（公開用）');
    file.getSheets()[0].setName(tabName);
    PropertiesService.getScriptProperties().setProperty('PUBLIC_SPREADSHEET_ID', file.getId());
    Logger.log('公開用スプレッドシートを作りました: ' + publicSpreadsheetUrl_());
  } else {
    Logger.log('公開用スプレッドシートはすでに登録されています: ' + publicSpreadsheetUrl_());
  }
  var result = syncPublicSheet_();
  Logger.log('「' + tabName + '」タブに ' + result.count + ' 件を書き込みました');
  Logger.log('次に、このスプレッドシートの共有を「リンクを知っている全員・閲覧者」にしてください');
}

// ---- 使用量と概算の金額 -----------------------------------------------

var USAGE_SHEET_NAME = '利用量';
var USAGE_HEADER = ['日時', '操作', 'モデル', 'Gemini入力トークン', 'Gemini出力トークン', 'Jev入力トークン', '概算（円）'];

/**
 * Gemini・Jev の応答から、使ったトークン数を読む純粋関数（読めなければ 0）。
 * Gemini の出力は、本文（candidatesTokenCount）と内部の考える過程（thoughtsTokenCount）の合計。
 */
function readUsage_(geminiResponse, jevResponse) {
  var usage = { geminiInput: 0, geminiOutput: 0, jevInput: 0 };
  var num = function (v) { return typeof v === 'number' && v > 0 ? v : 0; };
  try {
    var meta = (JSON.parse(geminiResponse.getContentText()) || {}).usageMetadata || {};
    usage.geminiInput = num(meta.promptTokenCount);
    usage.geminiOutput = num(meta.candidatesTokenCount) + num(meta.thoughtsTokenCount);
  } catch (e) { /* 読めなければ 0 のまま */ }
  if (jevResponse) {
    try {
      usage.jevInput = num(((JSON.parse(jevResponse.getContentText()) || {}).usage || {}).input_tokens);
    } catch (e2) { /* 読めなければ 0 のまま */ }
  }
  return usage;
}

/** トークン数から概算の金額（円）を計算する純粋関数。小数第2位まで */
function estimateYen_(usage) {
  var price = APP_CONFIG.pricing || {};
  var usd = (usage.geminiInput * (price.geminiInputUsdPerMTok || 0) +
    usage.geminiOutput * (price.geminiOutputUsdPerMTok || 0) +
    usage.jevInput * (price.jevInputUsdPerMTok || 0)) / 1000000;
  return Math.round(usd * (price.yenPerUsd || 0) * 100) / 100;
}

/**
 * 使用量を「利用量」シートに1行記録し、画面に返す形（トークン数＋概算の円）にする。
 * 記録に失敗しても、本来の処理（文章を整える・要約）は止めない。
 */
function recordUsage_(operation, model, usage) {
  var yen = estimateYen_(usage);
  // エラーなどでトークン数が読めなかったときは記録しない（0 円の行を増やさない）
  if (!usage.geminiInput && !usage.geminiOutput && !usage.jevInput) {
    return { geminiInput: 0, geminiOutput: 0, jevInput: 0, yen: 0 };
  }
  try {
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = spreadsheet.getSheetByName(USAGE_SHEET_NAME) || spreadsheet.insertSheet(USAGE_SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(USAGE_HEADER);
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([
      sanitizeCellText_(Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss')),
      sanitizeCellText_(operation),
      sanitizeCellText_(model),
      usage.geminiInput, usage.geminiOutput, usage.jevInput, yen
    ]);
  } catch (e) {
    // 記録できなくても続ける
  }
  return { geminiInput: usage.geminiInput, geminiOutput: usage.geminiOutput, jevInput: usage.jevInput, yen: yen };
}

/**
 * 今月（日本時間）の使用量を集計する。シートが無い・読めないときは 0 件として返す。
 * @returns {{ month: string, count: number, analyzeCount: number, summarizeCount: number, yen: number }}
 */
function summarizeUsageThisMonth_() {
  var month = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM');
  var summary = { month: month, count: 0, analyzeCount: 0, summarizeCount: 0, yen: 0 };
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USAGE_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) { return summary; }
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, USAGE_HEADER.length).getValues();
    rows.forEach(function (row) {
      var at = row[0] instanceof Date ? Utilities.formatDate(row[0], TIME_ZONE, 'yyyy-MM') : String(row[0]).slice(0, 7);
      if (at !== month) { return; }
      summary.count++;
      if (String(row[1]) === '要約') { summary.summarizeCount++; } else { summary.analyzeCount++; }
      summary.yen += Number(row[6]) || 0;
    });
    summary.yen = Math.round(summary.yen * 100) / 100;
  } catch (e) {
    // 集計できなくても続ける
  }
  return summary;
}

// ---- 記録の一覧（合言葉なしで読める、読み取り専用） --------------------------

/**
 * 記録の一覧（archive.html）に渡す記録を、新しい順に返す。
 * スクリプトプロパティ ARCHIVE_PUBLIC が "true" のときだけ動く（初期状態は止めておく）。
 * 返すのは公開してよい項目だけ（toPublicItem_ の一覧）。ID は返さない。
 */
function handleArchive_() {
  if (getProperty_('ARCHIVE_PUBLIC').toLowerCase() !== 'true') {
    throw new Error('記録の一覧は、いまは公開されていません');
  }
  var entries = readEntries_(openSheet_());
  var items = [];
  for (var i = entries.length - 1; i >= 0; i--) {
    items.push(toPublicItem_(entries[i].item));
  }
  // publicSpreadsheetUrl: 公開用スプレッドシートの URL（未設定なら空）。一覧ページの「表として見る」リンクに使う
  return { ok: true, teamName: APP_CONFIG.teamName, publicSpreadsheetUrl: publicSpreadsheetUrl_(), items: items };
}

/**
 * 記録の1件を、公開してよい項目だけのオブジェクトにする純粋関数。
 * ここに無い項目（ID など）は、記録の一覧には出ない。URL は http(s) のものだけ残す。
 */
function toPublicItem_(item) {
  var safeUrl = function (u) { return /^https?:\/\/\S+$/i.test(String(u || '')) ? String(u) : ''; };
  var kind = findByKey_(getKinds_(), item.kind);
  var source = findByKey_(APP_CONFIG.sources, item.source);
  return {
    savedAt: item.savedAt,
    postedAt: item.postedAt,
    kind: item.kind,
    kindLabel: kind ? kind.label : '',
    sourceLabel: source ? source.label : '',
    category: item.category,
    title: item.title,
    summary: item.summary,
    tags: item.tags,
    eventIso: item.eventIso,
    place: item.place,
    deadline: item.deadline,
    performers: item.performers,
    author: item.author,
    // 記録の一覧では「詳細はスレッドにて ➡️」は不要（スレッドは別に読める）。末尾に残る空行も落とす
    talk: stripThreadGuide_(item.talk, true).replace(/\s+$/, ''),
    original: item.original,
    url: safeUrl(item.url),
    joinUrl: safeUrl(item.joinUrl),
    applyUrl: safeUrl(item.applyUrl),
    // スレッドに添えて投稿したコメント（投稿した内容の一部なので公開する）
    comment: item.memo
  };
}

// ---- カテゴリ・タグ・発信者の候補の管理（スクリプトプロパティ） ----------------

var LIST_DEFS = {
  category: { property: CATEGORIES_PROPERTY, label: 'カテゴリ', key: 'categories' },
  tag: { property: TAGS_PROPERTY, label: 'タグ', key: 'tags' },
  author: { property: AUTHORS_PROPERTY, label: '発信者の候補', key: 'authors' }
};

// ---- 種別の管理（組み込み＋画面で追加したもの） ------------------------------

/** 画面で追加した種別（スクリプトプロパティ）。形が不正な要素は無視する */
function getCustomKinds_() {
  return (readJsonList_(KINDS_PROPERTY) || []).filter(function (k) {
    return k && typeof k.key === 'string' && typeof k.label === 'string' && k.key && k.label;
  });
}

/**
 * 種別の一覧 [{key, label, description, schedule, builtin}]。
 * 組み込み（Config.gs）を先に、画面で追加したものを後に並べる。
 */
function getKinds_() {
  var builtin = APP_CONFIG.kinds.map(function (k) {
    return { key: k.key, label: k.label, description: k.description, schedule: !!k.schedule || k.key === 'schedule', builtin: true };
  });
  var custom = getCustomKinds_().map(function (k) {
    return { key: k.key, label: k.label, description: String(k.description || k.label), schedule: !!k.schedule, builtin: false };
  });
  return builtin.concat(custom);
}

/** 種別を追加する。key は自動で振る（保存時の値ではなく、シートには名前を書く） */
function handleAddKind_(body) {
  var label = String(body.label || '').trim();
  var description = String(body.description || '').trim();
  if (!label) { throw new Error('種別の名前を入力してください'); }
  if (label.length > 20) { throw new Error('種別の名前は20文字以内にしてください'); }
  if (findByLabel_(getKinds_(), label)) { throw new Error('同じ名前の種別がすでにあります: ' + label); }
  var custom = getCustomKinds_();
  if (custom.length >= MAX_CUSTOM_KINDS) { throw new Error('追加できる種別は' + MAX_CUSTOM_KINDS + '個までです'); }
  var key;
  do {
    key = 'custom_' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  } while (findByKey_(getKinds_(), key));
  custom.push({ key: key, label: label, description: description || label, schedule: body.schedule === true });
  writeJsonList_(KINDS_PROPERTY, custom);
  return { ok: true, kinds: getKinds_() };
}

/** 画面で追加した種別を一覧から外す（組み込みは外せない）。保存済みの行の種別名は残るが、読み込み時は「未選択」になる */
function handleRemoveKind_(body) {
  var key = String(body.key || '').trim();
  if (findByKey_(APP_CONFIG.kinds, key)) { throw new Error('組み込みの種別は削除できません'); }
  var custom = getCustomKinds_();
  var rest = custom.filter(function (k) { return k.key !== key; });
  if (rest.length === custom.length) { throw new Error('存在しない種別です'); }
  writeJsonList_(KINDS_PROPERTY, rest);
  return { ok: true, kinds: getKinds_() };
}

/** カテゴリ一覧。未初期化・壊れていれば Config.gs の初期カテゴリで初期化する */
function getCategories_() {
  var list = readJsonList_(CATEGORIES_PROPERTY);
  if (!list || !list.length) {
    list = APP_CONFIG.defaultCategories.slice();
    writeJsonList_(CATEGORIES_PROPERTY, list);
  }
  return list;
}

/** タグ一覧。未初期化・壊れていれば空で初期化する（0件も正常） */
function getTags_() {
  var list = readJsonList_(TAGS_PROPERTY);
  if (!list) {
    list = [];
    writeJsonList_(TAGS_PROPERTY, list);
  }
  return list;
}

/**
 * 発信者の候補一覧。未初期化・壊れていれば Config.gs の初期値で初期化する。
 * 全部消して0件にした状態も正常として扱う（初期値に戻さない）。
 */
function getAuthors_() {
  var list = readJsonList_(AUTHORS_PROPERTY);
  if (!list) {
    list = (APP_CONFIG.defaultAuthors || []).slice();
    writeJsonList_(AUTHORS_PROPERTY, list);
  }
  return list;
}

function readJsonList_(property) {
  var raw = PropertiesService.getScriptProperties().getProperty(property);
  if (!raw) { return null; }
  try {
    var list = JSON.parse(raw);
    return Object.prototype.toString.call(list) === '[object Array]' ? list : null;
  } catch (e) {
    return null;
  }
}

function writeJsonList_(property, list) {
  PropertiesService.getScriptProperties().setProperty(property, JSON.stringify(list));
}

function getList_(type) {
  if (type === 'category') { return getCategories_(); }
  return type === 'author' ? getAuthors_() : getTags_();
}

/** 名前を整える（タグはカンマ区切りで保存するため , を 、 に置き換える） */
function sanitizeListName_(name, type) {
  var value = String(name || '').trim();
  return type === 'tag' ? value.replace(/,/g, '、') : value;
}

function handleAddListItem_(body, type) {
  var def = LIST_DEFS[type];
  var name = sanitizeListName_(body.name, type);
  if (!name) { throw new Error(def.label + '名を入力してください'); }
  var list = getList_(type);
  if (list.indexOf(name) !== -1) { throw new Error('同じ名前の' + def.label + 'がすでにあります: ' + name); }
  list.push(name);
  writeJsonList_(def.property, list);
  var result = { ok: true };
  result[def.key] = list;
  return result;
}

/** 一覧から外すだけで、保存済みの行は変更しない */
function handleRemoveListItem_(body, type) {
  var def = LIST_DEFS[type];
  var name = String(body.name || '').trim();
  var list = getList_(type);
  var index = list.indexOf(name);
  if (index === -1) { throw new Error('存在しない' + def.label + 'です: ' + name); }
  if (type === 'category' && list.length === 1) { throw new Error('カテゴリは1つ以上必要です'); }
  list.splice(index, 1);
  writeJsonList_(def.property, list);
  var result = { ok: true };
  result[def.key] = list;
  return result;
}

/** 並べ替え。要素の集合が現在と同じ（順序だけが違う）ときだけ受け付ける */
function handleReorderList_(requested, type) {
  var def = LIST_DEFS[type];
  if (Object.prototype.toString.call(requested) !== '[object Array]') {
    throw new Error('並べ替え後の' + def.label + '一覧が指定されていません');
  }
  var normalized = requested.map(function (n) { return String(n); });
  var current = getList_(type);
  if (normalized.length !== current.length ||
      JSON.stringify(normalized.slice().sort()) !== JSON.stringify(current.slice().sort())) {
    throw new Error('並べ替えの内容が現在の' + def.label + '一覧と一致しません。画面を開き直してください');
  }
  writeJsonList_(def.property, normalized);
  var result = { ok: true };
  result[def.key] = normalized;
  return result;
}

// ---- 診断用 -----------------------------------------------------

/**
 * Jev への接続を試す（GAS エディタで実行し、「実行ログ」を見る）。
 * 実際の analyze と同じ形のリクエストを、短いテスト文で1回だけ送る。API キーはログに出さない。
 */
function testJev() {
  var key = getProperty_('TYPESAFE_API_KEY');
  if (!key) {
    Logger.log('TYPESAFE_API_KEY が未設定です');
    return;
  }
  var categories = getCategories_();
  var tags = getTags_();
  var request = buildJevRequest_(key, {
    url: '',
    text: '10月24日（土）13時から高崎で勉強会を開催します。オンラインでも参加できます。'
  }, categories, tags);
  Logger.log('送信する質問: ' + Object.keys(JSON.parse(request.payload).questions).join(', ') +
    '（カテゴリ ' + categories.length + ' 件、タグ ' + tags.length + ' 件）');
  var response = UrlFetchApp.fetchAll([request])[0];
  Logger.log('HTTP ' + response.getResponseCode());
  Logger.log('応答: ' + String(response.getContentText()).slice(0, 1000));
  try {
    Logger.log('判定結果: ' + JSON.stringify(parseJevResponse_(response, categories, tags)));
  } catch (err) {
    Logger.log('判定結果を読めませんでした: ' + err.message);
  }
}

// ---- 承認用 -----------------------------------------------------

/**
 * 初回セットアップ用: GAS エディタでこの関数を1回実行し、
 * スプレッドシートと外部通信の権限を承認する（Web アプリ経由では承認画面が出ないため）。
 */
function authorizeOnce() {
  openSheet_();
  if (getProperty_('PUBLIC_SPREADSHEET_ID')) {
    SpreadsheetApp.openById(getProperty_('PUBLIC_SPREADSHEET_ID'));
  }
  UrlFetchApp.fetch('https://www.google.com/', { muteHttpExceptions: true });
  Logger.log('承認と初期化が完了しました。合言葉が設定済みか: ' + !!getProperty_('SHARED_TOKEN'));
}

// ---- レスポンス -------------------------------------------------

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

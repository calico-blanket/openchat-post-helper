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
// ============================================================

// ---- 定数 --------------------------------------------------

var TIME_ZONE = 'Asia/Tokyo';
var DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
var GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
var JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
var JEV_THRESHOLD = 0.5;

var CATEGORIES_PROPERTY = 'CATEGORIES_JSON';
var TAGS_PROPERTY = 'TAGS_JSON';

// 保存先シート。1行1件。列を増やすときは右端（ID の右）に追加すれば既存の処理は壊れない
var SHEET_NAME = '投稿一覧';
var HEADER = [
  '登録日時', '種別', 'ソース', 'カテゴリ', 'タイトル', '概略', 'URL',
  'スレッド詳細（原文）', 'タグ', '開催日時（ISO）', '場所', '申込締切', '出演者', 'メモ', 'ID'
];
var COL = {
  SAVED_AT: 1, KIND: 2, SOURCE: 3, CATEGORY: 4, TITLE: 5, SUMMARY: 6, URL: 7,
  ORIGINAL: 8, TAGS: 9, EVENT: 10, PLACE: 11, DEADLINE: 12, PERFORMERS: 13, MEMO: 14, ID: 15
};
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
 * GET では何も返さない（合言葉を URL に載せてログに残さないよう、API はすべて POST）。
 */
function doGet() {
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

/**
 * 画面の初期表示に必要な設定を返す（秘密情報は含めない）。
 */
function handleBootstrap_() {
  return {
    ok: true,
    config: APP_CONFIG,
    categories: getCategories_(),
    tags: getTags_(),
    geminiConfigured: !!getProperty_('GEMINI_API_KEY'),
    jevConfigured: !!getProperty_('TYPESAFE_API_KEY'),
    model: getProperty_('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL
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

  var source = input.source ||
    detectSourceFromUrl_(fetched.resolvedUrl || input.url) ||
    (input.image ? 'flyer' : 'other');
  var original = chooseOriginal_(input.text, fetched.text);

  var result = {
    ok: true,
    source: source,
    resolvedUrl: fetched.resolvedUrl || input.url,
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
    category: '',
    tags: [],
    legislatorTags: [],
    duplicate: findDuplicateByUrl_(fetched.resolvedUrl || input.url, ''),
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
    text: truncateText_(original, limits.llmInputMaxChars),
    image: input.image,
    url: result.resolvedUrl,
    source: source,
    today: Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd'),
    categories: categories,
    tags: tags,
    classify: !useJev
  })];
  if (useJev) {
    requests.push(buildJevRequest_(jevKey, {
      url: result.resolvedUrl,
      text: truncateText_(original, limits.jevInputMaxChars)
    }, categories, tags));
  }

  var responses = UrlFetchApp.fetchAll(requests);
  var gemini = parseGeminiAnalyzeResponse_(responses[0], categories, tags);

  result.title = gemini.title || result.title;
  result.summary = gemini.summary;
  result.event = gemini.event;
  result.imageText = gemini.imageText;
  result.flyerWeekday = gemini.flyerWeekday;

  if (!useJev) {
    result.kind = gemini.kind;
    result.category = gemini.category;
    result.tags = gemini.tags;
  } else {
    try {
      var jev = parseJevResponse_(responses[1], categories, tags);
      result.kind = jev.kind;
      result.category = jev.category;
      result.tags = jev.tags;
    } catch (jevErr) {
      warnings.push('Jev による分類に失敗しました（種別・カテゴリ・タグは手で選んでください）: ' + jevErr.message);
    }
  }

  // 画像だけの告知は、画像から読み取った文章をスレッド用の原文にする
  if (!original && result.imageText) {
    result.originalText = result.imageText;
    result.originalFromImage = true;
  }

  result.legislatorTags = matchLegislators_(
    // 投稿者名も対象にする（議員本人の X 投稿・note 記事にもタグを付けるため）
    [result.author, result.title, result.originalText, result.imageText].join('\n'),
    APP_CONFIG.legislators
  );
  result.analyzed = true;
  return result;
}

/** analyze の入力を検証して整える */
function normalizeAnalyzeInput_(body) {
  var url = String(body.url || '').trim();
  if (url && !/^https?:\/\/\S+$/i.test(url)) {
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

  // Slack はログインが必要で取得できないため、通信せずに貼り付けを促す
  if (detectSourceFromUrl_(url) === 'slack') {
    return empty(url, 'Slack の URL からは本文を取得できません。本文を貼り付けてください');
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
 * 長い投稿は途中で切れて返る可能性がある（末尾が「…」なら警告する）。
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
  var note = /…$/.test(parsed) ? 'X の投稿が途中で切れている可能性があります。全文を貼り付けてください' : '';
  return {
    status: 'ok',
    resolvedUrl: url,
    text: parsed,
    author: String(data.author_name || ''),
    pageTitle: '',
    note: note
  };
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
 * options.classify が true のときだけ、種別・カテゴリ・タグも判定させる（Jev が無いとき）。
 */
function buildGeminiAnalyzeRequest_(options) {
  var kindKeys = APP_CONFIG.kinds.map(function (k) { return k.key; });
  var properties = {
    title: { type: 'STRING', description: '投稿のタイトル。30文字以内。【】は付けない' },
    summary: { type: 'STRING', description: '概略。4〜6行。各行は短く。出典や「詳細はスレッドで」は書かない' },
    eventDate: { type: 'STRING', description: '開催日。YYYY-MM-DD の絶対日付。無ければ空文字' },
    startTime: { type: 'STRING', description: '開始時刻。HH:MM（24時間制）。無ければ空文字' },
    endTime: { type: 'STRING', description: '終了時刻。HH:MM（24時間制）。無ければ空文字' },
    place: { type: 'STRING', description: '開催場所。無ければ空文字' },
    deadline: { type: 'STRING', description: '申込締切日。YYYY-MM-DD の絶対日付。無ければ空文字' },
    performers: { type: 'STRING', description: '出演者・登壇者。複数なら「、」区切り。無ければ空文字' },
    imageText: { type: 'STRING', description: '画像がある場合、画像内の文字を読みやすく整えた文章。事実は変えない。画像が無ければ空文字' },
    flyerWeekday: { type: 'STRING', description: '画像やチラシに書かれている開催日の曜日（日・月・火・水・木・金・土のどれか1文字）。書かれていなければ空文字' }
  };
  var required = ['title', 'summary', 'eventDate', 'startTime', 'endTime', 'place', 'deadline', 'performers', 'imageText', 'flyerWeekday'];

  if (options.classify) {
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
  }

  var kindGuide = APP_CONFIG.kinds.map(function (k) { return '- ' + k.key + ': ' + k.description; }).join('\n');
  var system = [
    'あなたは「' + APP_CONFIG.teamName + '」の支援者向けに、告知や記事を LINE オープンチャットへ投稿する文章の材料を作る編集者です。',
    '入力の内容だけを根拠にし、書かれていないことを補ったり推測で足したりしないでください。',
    '日付は今日（' + options.today + '）を基準に、年を補って YYYY-MM-DD の絶対日付にしてください。「明日」などの相対表現は使わないでください。',
    '曜日は計算しないでください。画像やチラシに曜日が書かれている場合だけ、書かれている曜日を flyerWeekday に入れてください。',
    '概略は本文だけを書きます。出典（「Slackからの転載です」等）や「詳細はスレッドで」は書かないでください。',
    options.classify ? '種別の定義:\n' + kindGuide : ''
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

/** Gemini の応答から本文テキスト（思考パートは除く）を取り出す。失敗時は日本語の Error */
function readGeminiText_(response) {
  var code = response.getResponseCode();
  var raw = response.getContentText();
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
  return {
    title: str(json.title),
    summary: str(json.summary),
    kind: findByKey_(APP_CONFIG.kinds, kindKey) ? kindKey : '',
    event: {
      date: date(json.eventDate),
      startTime: time(json.startTime),
      endTime: time(json.endTime),
      place: str(json.place),
      deadline: date(json.deadline),
      performers: str(json.performers)
    },
    imageText: str(json.imageText),
    flyerWeekday: weekday ? weekday[0] : '',
    category: categories.indexOf(str(json.category)) !== -1 ? str(json.category) : '',
    tags: (Object.prototype.toString.call(json.tags) === '[object Array]' ? json.tags : [])
      .filter(function (t) { return tags.indexOf(t) !== -1; })
  };
}

/** 'YYYY-MM-DD' が実在する日付か */
function isValidIsoDate_(text) {
  var m = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) { return false; }
  var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
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
  var response = UrlFetchApp.fetchAll([request])[0];
  return { ok: true, summary: readGeminiText_(response).trim(), length: length };
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
      criteria: choiceCriteria_(APP_CONFIG.kinds.map(function (k) { return k.label + '（' + k.description + '）'; }))
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
  var kind = pick(answers.kind, APP_CONFIG.kinds);
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

/** 保存先シートを返す。無ければ作り、空ならヘッダー行を書く */
function getSheet_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** データ行（2行目以降、ID 列まで）をすべて読む。右側に足した列は読まない */
function readDataRows_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { return []; }
  return sheet.getRange(2, 1, lastRow - 1, HEADER.length).getValues();
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
    summary: str(body.summary),
    url: str(body.url).trim(),
    original: str(body.original),
    tags: normalizeTagsInput_(body.tags),
    eventIso: str(body.eventIso).trim(),
    place: str(body.place).trim(),
    deadline: str(body.deadline).trim(),
    performers: str(body.performers).trim(),
    memo: str(body.memo)
  };

  if (!item.title) { throw new Error('タイトルを入力してください'); }
  if (!findByKey_(APP_CONFIG.kinds, item.kind)) { throw new Error('種別を選んでください'); }
  if (!findByKey_(APP_CONFIG.sources, item.source)) { throw new Error('入力元を選んでください'); }
  if (getCategories_().indexOf(item.category) === -1) { throw new Error('カテゴリを選んでください'); }
  if (item.url && !/^https?:\/\/\S+$/i.test(item.url)) { throw new Error('URL の形式が正しくありません'); }
  if (item.eventIso && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}\+09:00(\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+09:00)?)?$/.test(item.eventIso)) {
    throw new Error('開催日時の形式が正しくありません: ' + item.eventIso);
  }
  if (item.eventIso && !isValidIsoDate_(item.eventIso.slice(0, 10))) {
    throw new Error('開催日が存在しない日付です: ' + item.eventIso.slice(0, 10));
  }
  if (item.deadline && !isValidIsoDate_(item.deadline)) {
    throw new Error('申込締切の日付が正しくありません: ' + item.deadline);
  }

  var allowedTags = getTags_().concat(APP_CONFIG.legislators || []);
  item.tags.forEach(function (tag) {
    if (allowedTags.indexOf(tag) === -1) { throw new Error('不明なタグです: ' + tag); }
  });

  ['title', 'summary', 'original', 'memo', 'place', 'performers'].forEach(function (key) {
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

/** 保存内容を、シートの1行（ID 列まで）の配列にする */
function itemToRow_(item, savedAt, id) {
  var row = [];
  row[COL.SAVED_AT - 1] = sanitizeCellText_(savedAt);
  row[COL.KIND - 1] = sanitizeCellText_(findByKey_(APP_CONFIG.kinds, item.kind).label);
  row[COL.SOURCE - 1] = sanitizeCellText_(findByKey_(APP_CONFIG.sources, item.source).label);
  row[COL.CATEGORY - 1] = sanitizeCellText_(item.category);
  row[COL.TITLE - 1] = sanitizeCellText_(item.title);
  row[COL.SUMMARY - 1] = sanitizeCellText_(item.summary);
  row[COL.URL - 1] = sanitizeCellText_(item.url);
  row[COL.ORIGINAL - 1] = sanitizeCellText_(item.original);
  row[COL.TAGS - 1] = sanitizeCellText_(item.tags.join(', '));
  row[COL.EVENT - 1] = sanitizeCellText_(item.eventIso);
  row[COL.PLACE - 1] = sanitizeCellText_(item.place);
  row[COL.DEADLINE - 1] = sanitizeCellText_(item.deadline);
  row[COL.PERFORMERS - 1] = sanitizeCellText_(item.performers);
  row[COL.MEMO - 1] = sanitizeCellText_(item.memo);
  row[COL.ID - 1] = sanitizeCellText_(id);
  return row;
}

/** シートの1行を、画面に返す形のオブジェクトにする */
function rowToItem_(row) {
  var str = function (col) {
    var v = row[col - 1];
    if (v instanceof Date) {
      return Utilities.formatDate(v, TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
    }
    return String(v === undefined || v === null ? '' : v);
  };
  var kind = findByLabel_(APP_CONFIG.kinds, str(COL.KIND));
  var source = findByLabel_(APP_CONFIG.sources, str(COL.SOURCE));
  return {
    id: str(COL.ID).trim(),
    savedAt: str(COL.SAVED_AT),
    kind: kind ? kind.key : '',
    source: source ? source.key : 'other',
    category: str(COL.CATEGORY),
    title: str(COL.TITLE),
    summary: str(COL.SUMMARY),
    url: str(COL.URL),
    original: str(COL.ORIGINAL),
    tags: str(COL.TAGS).split(',').map(function (t) { return t.trim(); }).filter(function (t) { return t; }),
    eventIso: str(COL.EVENT),
    place: str(COL.PLACE),
    deadline: str(COL.DEADLINE),
    performers: str(COL.PERFORMERS),
    memo: str(COL.MEMO)
  };
}

/**
 * 重複チェック用に URL を正規化する純粋関数。
 * ホストの大文字小文字・www.・twitter.com/x.com の違い、末尾のスラッシュ、
 * 追跡用パラメーター（utm_* など）、# 以降を無視する。
 */
function normalizeUrlForCompare_(url) {
  var m = String(url || '').trim().match(/^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!m) { return ''; }
  var host = m[1].toLowerCase().replace(/^(www|mobile)\./, '');
  if (host === 'twitter.com') { host = 'x.com'; }
  var pathPart = m[2].replace(/\/+$/, '');
  var query = (m[3] || '').replace(/^\?/, '').split('&').filter(function (pair) {
    var key = pair.split('=')[0].toLowerCase();
    if (!pair) { return false; }
    if (/^utm_/.test(key) || key === 'fbclid' || key === 'gclid' || key === 'ref_src') { return false; }
    // X の共有リンクに付く s / t は投稿の特定に関係ない
    if (host === 'x.com' && (key === 's' || key === 't')) { return false; }
    return true;
  }).sort().join('&');
  return host + pathPart + (query ? '?' + query : '');
}

/** 同じ URL の保存済み記事を探す（excludeId の行は除く）。無ければ null */
function findDuplicateByUrl_(url, excludeId) {
  var target = normalizeUrlForCompare_(url);
  if (!target) { return null; }
  var rows = readDataRows_(getSheet_());
  for (var i = rows.length - 1; i >= 0; i--) {
    var item = rowToItem_(rows[i]);
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
  getSheet_().appendRow(itemToRow_(item, savedAt, id));
  return { ok: true, id: id, savedAt: savedAt };
}

/** ID から行番号（1始まり、ヘッダー込み）を探す。無ければ -1 */
function findRowNumberById_(sheet, id) {
  var rows = readDataRows_(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][COL.ID - 1]).trim() === id) { return i + 2; }
  }
  return -1;
}

/** 編集（action=update）。登録日時と ID はそのまま残す */
function handleUpdate_(body) {
  var id = String(body.id || '').trim();
  if (!id) { throw new Error('編集する投稿が指定されていません'); }
  var item = validatePostInput_(body);
  var sheet = getSheet_();
  var rowNumber = findRowNumberById_(sheet, id);
  if (rowNumber === -1) { throw new Error('編集する投稿が見つかりません（削除された可能性があります）'); }

  var duplicate = findDuplicateByUrl_(item.url, id);
  if (duplicate && body.force !== true) {
    return { ok: false, duplicate: duplicate, error: '同じ URL がほかの投稿に保存されています（' + duplicate.title + '）' };
  }
  var current = rowToItem_(sheet.getRange(rowNumber, 1, 1, HEADER.length).getValues()[0]);
  sheet.getRange(rowNumber, 1, 1, HEADER.length).setValues([itemToRow_(item, current.savedAt, id)]);
  return { ok: true, id: id };
}

/** 削除（action=delete）。行ごと削除する（スプレッドシートの版の履歴からは戻せる） */
function handleDelete_(body) {
  var id = String(body.id || '').trim();
  if (!id) { throw new Error('削除する投稿が指定されていません'); }
  var sheet = getSheet_();
  var rowNumber = findRowNumberById_(sheet, id);
  if (rowNumber === -1) { throw new Error('削除する投稿が見つかりません'); }
  sheet.deleteRow(rowNumber);
  return { ok: true, id: id };
}

/**
 * 一覧・検索（action=search）。カテゴリを横断して新しい順に返す。
 *   keyword: タイトル・概略・原文・メモ・タグ・場所・出演者のどれかに部分一致（大文字小文字を区別しない）
 *   category / kind: 指定したものだけ（空なら全部）
 *   tags: すべてのタグを持つものだけ（AND）
 *   offset: 何件目から（PAGE_SIZE 件ずつ）
 */
function handleSearch_(body) {
  var keyword = String(body.keyword || '').trim().toLowerCase();
  var category = String(body.category || '').trim();
  var kind = String(body.kind || '').trim();
  var tags = normalizeTagsInput_(body.tags);
  var offset = Math.max(0, parseInt(body.offset, 10) || 0);

  var rows = readDataRows_(getSheet_());
  var items = [];
  var matched = 0;
  var hasMore = false;
  for (var i = rows.length - 1; i >= 0; i--) {
    var item = rowToItem_(rows[i]);
    if (category && item.category !== category) { continue; }
    if (kind && item.kind !== kind) { continue; }
    if (tags.length && !tags.every(function (t) { return item.tags.indexOf(t) !== -1; })) { continue; }
    if (keyword) {
      var haystack = [item.title, item.summary, item.original, item.memo, item.tags.join(','), item.place, item.performers]
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

// ---- カテゴリ・タグの管理（スクリプトプロパティ） ----------------------

var LIST_DEFS = {
  category: { property: CATEGORIES_PROPERTY, label: 'カテゴリ', key: 'categories' },
  tag: { property: TAGS_PROPERTY, label: 'タグ', key: 'tags' }
};

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
  return type === 'category' ? getCategories_() : getTags_();
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

// ---- 承認用 -----------------------------------------------------

/**
 * 初回セットアップ用: GAS エディタでこの関数を1回実行し、
 * スプレッドシートと外部通信の権限を承認する（Web アプリ経由では承認画面が出ないため）。
 */
function authorizeOnce() {
  getSheet_();
  UrlFetchApp.fetch('https://www.google.com/', { muteHttpExceptions: true });
  Logger.log('承認と初期化が完了しました。合言葉が設定済みか: ' + !!getProperty_('SHARED_TOKEN'));
}

// ---- レスポンス -------------------------------------------------

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

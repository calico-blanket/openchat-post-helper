// ============================================================
// 投稿文づくりの純粋関数（DOM・通信に触れない）
//
//   ブラウザでは window.PostLogic として、Node のテストでは
//   require('../js/logic.js') として読み込める（UMD 形式）。
//   設定（ひな形・文字数上限）は引数で受け取り、ここでは持たない。
// ============================================================

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PostLogic = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  var TIME_ZONE = 'Asia/Tokyo';
  // 日本語の文中では URL の直後に「。」「）」などが続くため、全角の区切りは URL に含めない
  var URL_PATTERN = /https?:\/\/[^\s"'<>。、「」『』（）]+/;

  // ---- 共有シートの受け取り -----------------------------------

  /**
   * 共有シートから渡されたクエリ文字列を、URL・本文・タイトルに分ける。
   * アプリによって URL が shared_url / shared_text / shared_title のどこに入るかが
   * 揺れるため、この順に探す。本文（shared_text）は原文として扱うので、
   * 「URLだけ」の場合を除いて手を加えない。
   */
  function parseSharedParams(queryString) {
    var params = new URLSearchParams(queryString || '');
    var sharedUrl = params.get('shared_url') || '';
    var sharedText = params.get('shared_text') || '';
    var sharedTitle = params.get('shared_title') || '';

    var url = '';
    var candidates = [sharedUrl, sharedText, sharedTitle];
    for (var i = 0; i < candidates.length; i++) {
      var m = candidates[i].match(URL_PATTERN);
      if (m) {
        url = m[0];
        break;
      }
    }

    var text = sharedText;
    if (url && text.trim() === url) {
      text = '';
    }
    return {
      url: url,
      text: text,
      title: sharedTitle,
      hasShared: !!(sharedUrl || sharedText || sharedTitle)
    };
  }

  /**
   * URL のドメインから入力元（ソース）を推定する。判定できなければ空文字。
   */
  function detectSource(url) {
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
   * 「スレッドにも投稿する」の初期値を決める。
   * URL が無ければ常に true（トーク本体からリンクで誘導できないため）。
   * それ以外は設定（threadDefaults）の入力元ごとの値。未設定の入力元は true。
   */
  function defaultUseThread(config, source, url) {
    if (!String(url || '').trim()) { return true; }
    var defaults = (config && config.threadDefaults) || {};
    return defaults[source] === undefined ? true : !!defaults[source];
  }

  // ---- 日付・曜日・相対表現 -----------------------------------

  /** 'YYYY-MM-DD' を検証して {y, m, d} を返す。不正なら null。 */
  function parseIsoDate(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) { return null; }
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    var date = new Date(Date.UTC(y, mo - 1, d));
    // 2026-02-30 のような存在しない日付を弾く
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
      return null;
    }
    return { y: y, m: mo, d: d, utc: date };
  }

  /** 'YYYY-MM-DD' の曜日（日〜土の1文字）を返す。不正なら空文字。LLM には任せない。 */
  function weekdayOf(iso) {
    var p = parseIsoDate(iso);
    return p ? WEEKDAYS[p.utc.getUTCDay()] : '';
  }

  /** 'YYYY-MM-DD' を「10/3(土)」の形にする。不正なら空文字。 */
  function formatDateJa(iso) {
    var p = parseIsoDate(iso);
    if (!p) { return ''; }
    return p.m + '/' + p.d + '(' + WEEKDAYS[p.utc.getUTCDay()] + ')';
  }

  /** 日本時間での「今日」を 'YYYY-MM-DD' で返す。 */
  function todayIsoInTokyo(now) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now || new Date());
    var get = function (type) {
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === type) { return parts[i].value; }
      }
      return '';
    };
    return get('year') + '-' + get('month') + '-' + get('day');
  }

  /** 2つの 'YYYY-MM-DD' の日数差（target - base）。どちらか不正なら null。 */
  function daysBetween(baseIso, targetIso) {
    var a = parseIsoDate(baseIso);
    var b = parseIsoDate(targetIso);
    if (!a || !b) { return null; }
    return Math.round((b.utc.getTime() - a.utc.getTime()) / 86400000);
  }

  /**
   * 相対表現（「本日」「明日」）を返す。それ以外の日は空文字。
   * 投稿用テキストを作る（コピーする）時点の今日を基準にする。
   */
  function relativeDayLabel(targetIso, todayIso) {
    var diff = daysBetween(todayIso, targetIso);
    if (diff === 0) { return '本日'; }
    if (diff === 1) { return '明日'; }
    return '';
  }

  /** 'HH:MM' 形式か（00:00〜23:59。24:00 以降の表記は扱わない） */
  function isValidTime(text) {
    var m = String(text || '').match(/^(\d{1,2}):(\d{2})$/);
    return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59;
  }

  /** 時刻を2桁そろえにする（'9:00' → '09:00'）。不正なら空文字。 */
  function normalizeTime(text) {
    if (!isValidTime(text)) { return ''; }
    var parts = String(text).split(':');
    return ('0' + Number(parts[0])).slice(-2) + ':' + parts[1];
  }

  /**
   * 開催日時を保存用の ISO 8601 文字列にする（日本時間 +09:00 固定）。
   *   日付のみ            → '2026-10-03'
   *   開始時刻あり        → '2026-10-03T19:00+09:00'
   *   開始・終了時刻あり  → '2026-10-03T19:00+09:00/2026-10-03T21:00+09:00'（ISO 8601 の期間表記）
   * 日付が不正なら空文字。
   */
  function buildEventIso(dateIso, startTime, endTime) {
    if (!parseIsoDate(dateIso)) { return ''; }
    var start = normalizeTime(startTime);
    if (!start) { return dateIso; }
    var iso = dateIso + 'T' + start + '+09:00';
    var end = normalizeTime(endTime);
    if (end) {
      iso += '/' + dateIso + 'T' + end + '+09:00';
    }
    return iso;
  }

  /** buildEventIso の逆変換。読めなければ空の値を返す。 */
  function parseEventIso(iso) {
    var empty = { date: '', startTime: '', endTime: '' };
    var text = String(iso || '').trim();
    if (!text) { return empty; }
    var pieces = text.split('/');
    var head = pieces[0].match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
    if (!head || !parseIsoDate(head[1])) { return empty; }
    var endMatch = pieces[1] ? pieces[1].match(/T(\d{2}:\d{2})/) : null;
    return {
      date: head[1],
      startTime: head[2] || '',
      endTime: endMatch ? endMatch[1] : ''
    };
  }

  /**
   * チラシに書かれた曜日と、日付から計算した曜日が食い違っていれば警告文を返す。
   * チラシの曜日が読み取れていない・日付が不正な場合は空文字（警告しない）。
   */
  function weekdayMismatchWarning(dateIso, flyerWeekday) {
    var computed = weekdayOf(dateIso);
    var m = String(flyerWeekday || '').match(/[日月火水木金土]/);
    if (!computed || !m) { return ''; }
    if (m[0] === computed) { return ''; }
    return 'チラシの曜日（' + m[0] + '）と、日付 ' + formatDateJa(dateIso) +
      ' から計算した曜日（' + computed + '）が違います。日付を確認してください。';
  }

  // ---- ひな形 ---------------------------------------------------

  /** '{key}' を vars[key] で置き換える（未定義のキーは空文字） */
  function fillTemplate(template, vars) {
    return String(template || '').replace(/\{(\w+)\}/g, function (all, key) {
      var value = vars && vars[key];
      return value === undefined || value === null ? '' : String(value);
    });
  }

  /**
   * 入力元と名前の有無から、使うひな形を選ぶ。
   * 名前が空なら「キー_noAuthor」を優先し、{author} を含むひな形は使わない。
   */
  function pickTemplate(map, source, author) {
    var templates = map || {};
    var hasAuthor = !!String(author || '').trim();
    if (!hasAuthor && templates[source + '_noAuthor'] !== undefined) {
      return templates[source + '_noAuthor'];
    }
    var tpl = templates[source];
    if (tpl === undefined) {
      tpl = templates.other !== undefined ? templates.other : '';
    }
    if (!hasAuthor && tpl.indexOf('{author}') !== -1) {
      return templates.other !== undefined ? templates.other : '';
    }
    return tpl;
  }

  // ---- トーク本体 -----------------------------------------------

  /**
   * タイトルの外側の【】を外す（トーク本体では【】で囲むため、二重にしない）。
   *   「【お知らせ】」→「お知らせ」、閉じ側が切れた「【お知らせ」→「お知らせ」
   *   「【告知】と【報告】」のように中にも【】があるものは、壊さないようそのまま
   */
  function stripTitleBrackets(title) {
    var t = String(title || '').trim();
    var m = t.match(/^【([^【】]*)】$/) || t.match(/^【([^【】]*)$/);
    return (m ? m[1] : t).trim();
  }

  /**
   * トーク本体（オープンチャットのトークに貼る文）を組み立てる。
   *   【タイトル】
   *   概略（スケジュール型では載せない）
   *   （スケジュール型のみ）日時・場所・出演者・申込締切の行
   *   出典行
   *   結び: スレッドを使うなら「詳細はスレッドにて ➡️」、使わないなら「全文はこちら ⬇️」＋ URL
   *         （post.useThread が false のとき。URL が無ければ結びの行は出さない）
   * 出典行と定型句は設定から自動で付ける（LLM には書かせない）。
   * 「本日」「明日」は todayIso（コピーする時点の今日）を基準に計算する。
   */
  function buildTalkBody(post, config, todayIso) {
    var talk = (config && config.talk) || {};
    var blocks = [];

    var head = [];
    // 原文の見出しの【】がタイトルに残っていても、【【…】】と二重にしない
    var title = stripTitleBrackets(post.title);
    if (title) { head.push('【' + title + '】'); }
    // スケジュール型は「いつ・どこで」を最初に伝えるため概略を載せない（内容はスレッドの原文で読める）
    var summary = String(post.summary || '').trim();
    if (summary && post.kind !== 'schedule') { head.push(summary); }
    if (head.length) { blocks.push(head.join('\n')); }

    if (post.kind === 'schedule') {
      var eventLines = buildEventLines(post.event || {}, talk, todayIso);
      if (eventLines.length) { blocks.push(eventLines.join('\n')); }
    }

    var tail = [];
    var sourceLine = fillTemplate(
      pickTemplate(config && config.sourceLines, post.source, post.author),
      { author: String(post.author || '').trim() }
    );
    if (sourceLine) { tail.push(sourceLine); }
    if (post.useThread === false) {
      var url = String(post.url || '').trim();
      if (url) { tail.push(fillTemplate(talk.linkLine || '全文はこちら ⬇️\n{url}', { url: url })); }
    } else if (talk.detailsLine) {
      tail.push(talk.detailsLine);
    }
    if (tail.length) { blocks.push(tail.join('\n')); }

    return blocks.join('\n\n');
  }

  /** スケジュール型の日時・場所・出演者・申込締切の行を作る */
  function buildEventLines(event, talk, todayIso) {
    var lines = [];
    var dateLabel = formatDateJa(event.date);
    if (dateLabel) {
      var relative = relativeDayLabel(event.date, todayIso);
      var start = normalizeTime(event.startTime);
      var end = normalizeTime(event.endTime);
      var time = start ? ' ' + start + '〜' + (end || '') : '';
      lines.push(fillTemplate(talk.dateLine || '📅 {relative}{date}{time}', {
        relative: relative ? relative + ' ' : '',
        date: dateLabel,
        time: time
      }));
    }
    var place = String(event.place || '').trim();
    if (place) {
      lines.push(fillTemplate(talk.placeLine || '📍 {place}', { place: place }));
    }
    var joinUrl = String(event.joinUrl || '').trim();
    if (joinUrl) {
      lines.push(fillTemplate(talk.joinLine || '📺 参加: {url}', { url: joinUrl }));
    }
    var performers = String(event.performers || '').trim();
    if (performers) {
      lines.push(fillTemplate(talk.performersLine || '🎤 出演: {performers}', { performers: performers }));
    }
    var deadlineLabel = formatDateJa(event.deadline);
    if (deadlineLabel) {
      var deadlineRelative = relativeDayLabel(event.deadline, todayIso);
      lines.push(fillTemplate(talk.deadlineLine || '⏰ 申込締切: {deadline}', {
        deadline: (deadlineRelative ? deadlineRelative + ' ' : '') + deadlineLabel
      }));
    }
    var applyUrl = String(event.applyUrl || '').trim();
    if (applyUrl) {
      lines.push(fillTemplate(talk.applyLine || '📝 申込: {url}', { url: applyUrl }));
    }
    return lines;
  }

  // ---- スレッド（詳細） -----------------------------------------

  /** 入力元に応じたスレッドの前置き（要約版なら「以下は要約です。」） */
  function buildThreadPrefix(config, source, author, isSummary) {
    var map = (config && config.threadPrefixes) || {};
    if (isSummary) { return map.summary || ''; }
    return fillTemplate(pickTemplate(map, source, author), { author: String(author || '').trim() });
  }

  /** サロゲートペア（絵文字など）の途中で切らないよう、切る位置を1つ前へずらす */
  function safeCut(text, index) {
    if (index > 0 && index < text.length) {
      var code = text.charCodeAt(index);
      if (code >= 0xDC00 && code <= 0xDFFF) { return index - 1; }
    }
    return index;
  }

  /**
   * 長文を、1通の最大文字数に収まるように分ける。
   * 切る位置の優先順位: 段落の切れ目（空行）→ 改行 → 句点「。」→ 文字数で強制。
   * 返す各片をそのままつなぐと元の文字列に完全に一致する（原文を一字も変えない）。
   * 片の末尾に付く区切りの改行は、表示・コピー時に messageText() で落とす。
   *
   * @param {string} text - 分ける文字列
   * @param {number} firstCap - 1片目の最大文字数（前置きの分だけ小さくできる）
   * @param {number} restCap - 2片目以降の最大文字数
   */
  function splitText(text, firstCap, restCap) {
    var source = String(text || '');
    var chunks = [];
    var pos = 0;
    while (pos < source.length) {
      var cap = Math.max(1, Math.floor(chunks.length === 0 ? firstCap : restCap));
      if (source.length - pos <= cap) {
        chunks.push(source.slice(pos));
        break;
      }
      var windowText = source.slice(pos, pos + cap);
      var minEnd = Math.floor(cap * 0.3);
      var end = findBreak(windowText, minEnd);
      if (end <= 0) {
        end = safeCut(source, pos + cap) - pos;
        if (end <= 0) { end = cap; }
      }
      // 区切りの改行が続く場合は、すべて前の片に含める（次の片を改行で始めない）
      while (pos + end < source.length && source.charAt(pos + end) === '\n') {
        end++;
      }
      chunks.push(source.slice(pos, pos + end));
      pos += end;
    }
    return chunks;
  }

  /** 窓の中で一番後ろの「良い切れ目」の位置（その文字の直後）を返す。無ければ 0 */
  function findBreak(windowText, minEnd) {
    // 見つからない（-1）ときは 0 にする（-1 + 2 = 1 を位置と誤認しない）
    var after = function (needle) {
      var index = windowText.lastIndexOf(needle);
      return index === -1 ? 0 : index + needle.length;
    };
    var candidates = [after('\n\n'), after('\n'), after('。')];
    var i;
    for (i = 0; i < candidates.length; i++) {
      if (candidates[i] > minEnd) { return candidates[i]; }
    }
    // 短すぎる片になってもよいので、何かしらの切れ目があればそこで切る
    for (i = 0; i < candidates.length; i++) {
      if (candidates[i] > 0) { return candidates[i]; }
    }
    return 0;
  }

  /** 片の末尾の区切り改行を落としてコピー用の文字列にする */
  function messageText(chunk) {
    return String(chunk).replace(/\n+$/, '');
  }

  /**
   * スレッドに貼るメッセージを、1通ずつコピーできる配列にして返す。
   *   - X・Instagram・Threads（options.urlFirstSources）の場合: 1通目は URL だけ。2通目から「前置き＋本文」
   *   - それ以外: 1通目の先頭に前置き。本文は段落の切れ目で分割
   *   - メモ（コメント）は最後の1通の末尾に添える。入らなければ別の1通にする
   * 本文（原文・要約）はここで一切書き換えない。
   *
   * @returns {Array<{kind: string, text: string}>} kind は 'url' | 'text'
   */
  function buildThreadMessages(options) {
    var maxChars = Math.max(10, Number(options.maxChars) || 1000);
    var prefix = String(options.prefix || '').trim();
    var body = String(options.body || '');
    var messages = [];

    var urlFirstSources = options.urlFirstSources || ['x'];
    if (urlFirstSources.indexOf(options.source) !== -1 && options.url) {
      messages.push({ kind: 'url', text: String(options.url) });
    }

    var head = prefix ? prefix + '\n\n' : '';
    if (body.length) {
      var firstCap = Math.max(1, maxChars - head.length);
      var chunks = splitText(body, firstCap, maxChars);
      chunks.forEach(function (chunk, index) {
        messages.push({ kind: 'text', text: (index === 0 ? head : '') + messageText(chunk) });
      });
    } else if (prefix) {
      messages.push({ kind: 'text', text: prefix });
    }

    var memo = String(options.memo || '').trim();
    if (memo) {
      var comment = fillTemplate(options.commentTemplate || '💬 {memo}', { memo: memo });
      var last = messages.length ? messages[messages.length - 1] : null;
      if (last && last.kind === 'text' && last.text.length + 2 + comment.length <= maxChars) {
        last.text += '\n\n' + comment;
      } else {
        messages.push({ kind: 'text', text: comment });
      }
    }
    return messages;
  }

  // ---- 要約の機械チェック（LLM には頼らない） ---------------------

  /** 全角の英数字・記号を半角にそろえる（比較用） */
  function toHalfWidth(text) {
    return String(text || '')
      .replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
      })
      .replace(/／/g, '/')
      .replace(/：/g, ':')
      .replace(/，/g, ',')
      .replace(/．/g, '.');
  }

  /** 一意な値だけを順番どおりに追加する */
  function pushUnique(list, value) {
    if (list.indexOf(value) === -1) { list.push(value); }
  }

  /**
   * 文章から URL・日付・時刻・数字を取り出す。
   * 日付は「月/日」、時刻は「時:分」に正規化して、書き方の違い（10月3日 と 10/3 など）を吸収する。
   * 取り出した部分は次の分類で二重に数えないよう、空白に置き換えてから次を探す。
   */
  function extractFacts(text) {
    var rest = toHalfWidth(text);
    var facts = { urls: [], dates: [], times: [], numbers: [] };

    rest = rest.replace(/https?:\/\/[^\s<>"'。、「」『』（）)]+/g, function (url) {
      pushUnique(facts.urls, url.replace(/[。、.,!！?？]+$/, ''));
      return ' ';
    });

    var addDate = function (month, day) {
      var mo = Number(month);
      var d = Number(day);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        pushUnique(facts.dates, mo + '/' + d);
        return true;
      }
      return false;
    };
    rest = rest.replace(/(\d{4})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})\s*日?/g, function (all, y, mo, d) {
      return addDate(mo, d) ? ' ' : all;
    });
    rest = rest.replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, function (all, mo, d) {
      return addDate(mo, d) ? ' ' : all;
    });
    rest = rest.replace(/(^|[^\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g, function (all, lead, mo, d) {
      return addDate(mo, d) ? lead + ' ' : all;
    });

    var addTime = function (hour, minute) {
      var h = Number(hour);
      var mi = Number(minute || 0);
      if (h <= 24 && mi <= 59) {
        pushUnique(facts.times, h + ':' + ('0' + mi).slice(-2));
        return true;
      }
      return false;
    };
    rest = rest.replace(/(\d{1,2}):(\d{2})/g, function (all, h, mi) {
      return addTime(h, mi) ? ' ' : all;
    });
    // 「24時間」「3時限」のような時刻でない表現は除く
    rest = rest.replace(/(\d{1,2})\s*時(?![間限])(?:\s*(\d{1,2})\s*分|半)?/g, function (all, h, mi) {
      var minute = /半$/.test(all) ? 30 : mi;
      return addTime(h, minute) ? ' ' : all;
    });

    rest.replace(/\d[\d,]*(?:\.\d+)?/g, function (num) {
      pushUnique(facts.numbers, num.replace(/,/g, ''));
      return num;
    });
    return facts;
  }

  var FACT_LABELS = { urls: 'URL', dates: '日付', times: '時刻', numbers: '数字' };

  /**
   * 原文と要約を比べ、要約から消えた URL・日付・時刻・数字（missing）と、
   * 原文に無いのに要約に現れたもの（extra）を返す。
   */
  function checkSummary(original, summary) {
    var a = extractFacts(original);
    var b = extractFacts(summary);
    var missing = [];
    var extra = [];
    Object.keys(FACT_LABELS).forEach(function (type) {
      a[type].forEach(function (value) {
        if (b[type].indexOf(value) === -1) { missing.push({ type: type, label: FACT_LABELS[type], value: value }); }
      });
      b[type].forEach(function (value) {
        if (a[type].indexOf(value) === -1) { extra.push({ type: type, label: FACT_LABELS[type], value: value }); }
      });
    });
    return { missing: missing, extra: extra };
  }

  /** checkSummary の結果を、画面に出す警告文の配列にする（問題なければ空配列） */
  function summaryWarnings(result) {
    var warnings = [];
    if (result.missing.length) {
      warnings.push('要約から消えています: ' + result.missing.map(function (f) {
        return f.label + '「' + f.value + '」';
      }).join('、'));
    }
    if (result.extra.length) {
      warnings.push('原文にないものが要約にあります: ' + result.extra.map(function (f) {
        return f.label + '「' + f.value + '」';
      }).join('、'));
    }
    return warnings;
  }

  // ---- 日時が未確定かもしれない原文の検出（AI の判定とは別に、コードで確かめる） ----

  /**
   * 原文に「日付の候補が複数ある（または・いずれか）」「未定・調整中・確定次第」などの
   * 表現があれば、日時を言い切らないよう促す警告文を返す。なければ空文字。
   */
  function uncertainDateWarning(original) {
    var text = toHalfWidth(original);
    var dates = extractFacts(text).dates;
    var alternatives = dates.length >= 2 && /または|もしくは|いずれか|のどちらか/.test(text);
    var undecided = /日程[はがも]?未定|日時[はがも]?未定|調整中|確定次第|決定次第|確定は直前|追って(お知らせ|ご案内|連絡)/.test(text);
    if (!alternatives && !undecided) { return ''; }
    return '原文では日時がまだ確定していない可能性があります（候補が複数ある、または未定などの表現があります）。トーク本体の日時を言い切ってよいか確認してください。';
  }

  /**
   * オンライン会議の URL（Zoom・Google Meet・Teams・Webex など）が含まれていれば、
   * 公開のオープンチャットに載せてよいかを確かめる警告文を返す。なければ空文字。
   */
  function meetingUrlWarning(urls) {
    var pattern = /^https?:\/\/([^/?#]*\.)?(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com)(\/|$|\?)/i;
    var hits = (urls || []).filter(function (u) { return pattern.test(String(u || '').trim()); });
    if (!hits.length) { return ''; }
    return 'オンライン会議の URL が入っています（' + hits.join('、') + '）。公開のオープンチャットに載せると、関係のない人が入ってくるおそれがあります。公開してよい URL か確認してください。';
  }

  // ---- その他 ---------------------------------------------------

  /** 配列の index 番目を delta(+1/-1) 方向の隣と入れ替えた新しい配列（範囲外は何もしない） */
  function moveArrayItem(list, index, delta) {
    var next = list.slice();
    var target = index + delta;
    if (index < 0 || index >= next.length || target < 0 || target >= next.length) {
      return next;
    }
    var tmp = next[index];
    next[index] = next[target];
    next[target] = tmp;
    return next;
  }

  return {
    parseSharedParams: parseSharedParams,
    detectSource: detectSource,
    defaultUseThread: defaultUseThread,
    parseIsoDate: parseIsoDate,
    weekdayOf: weekdayOf,
    formatDateJa: formatDateJa,
    todayIsoInTokyo: todayIsoInTokyo,
    daysBetween: daysBetween,
    relativeDayLabel: relativeDayLabel,
    normalizeTime: normalizeTime,
    buildEventIso: buildEventIso,
    parseEventIso: parseEventIso,
    weekdayMismatchWarning: weekdayMismatchWarning,
    fillTemplate: fillTemplate,
    pickTemplate: pickTemplate,
    stripTitleBrackets: stripTitleBrackets,
    buildTalkBody: buildTalkBody,
    buildThreadPrefix: buildThreadPrefix,
    splitText: splitText,
    messageText: messageText,
    buildThreadMessages: buildThreadMessages,
    extractFacts: extractFacts,
    checkSummary: checkSummary,
    summaryWarnings: summaryWarnings,
    uncertainDateWarning: uncertainDateWarning,
    meetingUrlWarning: meetingUrlWarning,
    moveArrayItem: moveArrayItem
  };
}));

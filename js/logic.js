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
   * 種別が「スケジュール型」（日時・場所の行を出す型）か。
   * 設定の kinds にある schedule フラグで決める。設定に無い古い値でも 'schedule' だけは従来どおり扱う。
   */
  function isScheduleKind(kindKey, config) {
    var kinds = (config && config.kinds) || [];
    for (var i = 0; i < kinds.length; i++) {
      if (kinds[i].key === kindKey) { return !!kinds[i].schedule || kindKey === 'schedule'; }
    }
    return kindKey === 'schedule';
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
    var withSchedule = isScheduleKind(post.kind, config);
    if (summary && !withSchedule) { head.push(summary); }
    if (head.length) { blocks.push(head.join('\n')); }

    if (withSchedule) {
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
    // 参加 URL（オンラインの配信・会議）はトークに出さない（記録とスレッドの原文には残る）
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

  /**
   * 入力元に応じたスレッドの前置き（要約版なら「以下は要約です。」）。
   * mode は 'full'（全文、初期値）か 'excerpt'（抜粋）。発信者の有無では全文・抜粋を切り替えない。
   */
  function buildThreadPrefix(config, source, author, isSummary, mode) {
    var map = (config && config.threadPrefixes) || {};
    if (isSummary) { return map.summary || ''; }
    // 組に分かれていない古い形の設定（フォーク先など）は、そのまま使う
    var set = map[mode === 'excerpt' ? 'excerpt' : 'full'];
    if (!set || typeof set !== 'object') { set = map; }
    return fillTemplate(pickTemplate(set, source, author), { author: String(author || '').trim() });
  }

  /**
   * 入力された URL を整える純粋関数。
   *   - 前後の空白を除き、「https://」の直後の空白（%20 を含む）を取り除く
   *   - 「meet.google.com/…」のように https:// が無いドメインの形なら、https:// を補う
   * URL らしくないもの（javascript: など）は変えずに返す（形式の検査は isValidUrl で行う）。
   */
  function normalizeUrl(text) {
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
  function isValidUrl(text) {
    return /^https?:\/\/[^\s/?#]+\S*$/i.test(String(text || ''));
  }

  // Slack からコピーしたときに文字として残る絵文字の名前（:sparkles: や :ピカピカ: など）
  //   名前は数字で始まらず、句読点・かっこ・空白を含まない60文字以内
  //   （「21:20よりスタート…致します:mega:」の時刻のコロンから文を巻き込まない）
  var EMOJI_NAME_PATTERN = /:(?![0-9])([^\s:\/：、。，．,！？!?「」『』（）()【】]{1,60}):/g;
  // 名前には英字かかな・漢字を必ず含む（:+1: :-1: は例外として絵文字とみなす）
  var EMOJI_NAME_LETTER = /[A-Za-z\u3040-\u30ff\u3400-\u9fff]|^[+-]1$/;
  // この文字で終わる行には「。」を足さない
  var LINE_END_PUNCTUATION = /[。．.！!？?、，,」』）)】〕］\]〉》>＞…‥♪〜~：:]$/;

  /** 1行から絵文字の名前を取り除く。{ line, count, removedAtEnd } を返す */
  function stripEmojiNamesInLine(line) {
    var MARK = '\u0000';
    var out = '';
    var last = 0;
    var count = 0;
    var m;
    EMOJI_NAME_PATTERN.lastIndex = 0;
    while ((m = EMOJI_NAME_PATTERN.exec(line)) !== null) {
      if (!EMOJI_NAME_LETTER.test(m[1])) {
        // 名前でなければ、閉じのコロンを次の名前の始まりとして使えるよう1文字だけ進める
        EMOJI_NAME_PATTERN.lastIndex = m.index + 1;
        continue;
      }
      out += line.slice(last, m.index) + MARK;
      last = EMOJI_NAME_PATTERN.lastIndex;
      count++;
    }
    out += line.slice(last);
    var removedAtEnd = new RegExp(MARK + '[\\s' + MARK + ']*$').test(out);
    return { line: out.split(MARK).join(''), count: count, removedAtEnd: removedAtEnd };
  }

  /**
   * Slack の絵文字の名前（:○○:）を取り除く純粋関数。
   *   - 行の最後にあった名前を取り除いたとき、その行が句読点や閉じかっこで終わっていなければ「。」を付ける
   *   - 行の途中にあった名前は取り除くだけ。絵文字だけの行は空の行として残す
   *   - Slack のコピーで最後に付く「（編集済み）」も取り除く
   * { text, count } を返す（count は取り除いた絵文字の名前の数）。
   */
  function stripEmojiNames(text) {
    var source = String(text || '').replace(/[ \t\u3000]*[（(](?:編集済み|edited)[）)][ \t\u3000]*(\n*)$/, '$1');
    var total = 0;
    var lines = source.split('\n').map(function (line) {
      var r = stripEmojiNamesInLine(line);
      total += r.count;
      if (!r.removedAtEnd) { return r.line; }
      var trimmed = r.line.replace(/[ \t\u3000]+$/, '');
      if (!trimmed.trim() || LINE_END_PUNCTUATION.test(trimmed)) { return trimmed; }
      return trimmed + '。';
    });
    return { text: lines.join('\n'), count: total };
  }

  /** 絵文字の名前（:○○:）がいくつあるか */
  function countEmojiNames(text) {
    return String(text || '').split('\n').reduce(function (sum, line) {
      return sum + stripEmojiNamesInLine(line).count;
    }, 0);
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

  // ---- 記録の一覧（archive.html） ---------------------------------

  /**
   * 配信・会議の URL（記録の joinUrl）を、読む人に伝わるリンクの名前にする純粋関数。
   * 「参加」では YouTube を見せたいだけの場合に合わないため、リンク先で言葉を切り替える。
   *   YouTube → 「YouTube で見る」／ Zoom・Meet・Teams など → 「オンライン会議に参加する」／ それ以外 → 「配信・会議のページを開く」
   * @returns {{ type: 'youtube'|'meeting'|'other', label: string }}
   */
  function streamLinkInfo(url) {
    var host = '';
    try { host = new URL(String(url || '').trim()).hostname.toLowerCase(); } catch (e) { host = ''; }
    var under = function (domain) { return host === domain || host.slice(-(domain.length + 1)) === '.' + domain; };
    if (['youtube.com', 'youtu.be', 'youtube-nocookie.com'].some(under)) {
      return { type: 'youtube', label: 'YouTube で見る' };
    }
    if (['zoom.us', 'meet.google.com', 'teams.microsoft.com', 'teams.live.com', 'webex.com', 'whereby.com'].some(under)) {
      return { type: 'meeting', label: 'オンライン会議に参加する' };
    }
    return { type: 'other', label: '配信・会議のページを開く' };
  }

  /** 記録の一覧で、開催日時を「10/24(土) 13:00〜17:00」の形にする（無ければ空文字） */
  function archiveEventLabel(eventIso) {
    var ev = parseEventIso(eventIso);
    var date = formatDateJa(ev.date);
    if (!date) { return ''; }
    return ev.startTime ? date + ' ' + ev.startTime + '〜' + (ev.endTime || '') : date;
  }

  /** 'YYYY-MM-DD …' を「10/3」の形にする（読めなければそのまま） */
  function shortDateLabel(text) {
    var m = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? Number(m[2]) + '/' + Number(m[3]) : String(text || '');
  }

  var ARCHIVE_SEARCH_FIELDS = ['title', 'summary', 'talk', 'original', 'author', 'place', 'category', 'performers', 'sourceLabel'];

  /**
   * 記録の一覧に並べる行を作る純粋関数。
   *   options.q        検索のことば（タイトル・本文・原文・発信者・場所などのどれかに含まれる。大文字小文字を区別しない）
   *   options.upcoming true なら、開催日が今日以降のものだけ
   *   options.category カテゴリ名（空ならすべて。一致するものだけ）
   *   options.tags     タグ名の配列（空ならすべて）。options.tagMode が 'and' なら全部持つもの、それ以外（'or'）なら1つでも持つもの
   *   options.sortKey  'saved'（登録日）| 'kind' | 'title' | 'event'（開催日）| 'author'
   *   options.dir      'asc' | 'desc'（開催日・登録日などの空の値は、向きにかかわらず最後）
   *   options.today    'YYYY-MM-DD'（日本時間の今日）
   *   options.limit    表示する件数の上限（省略時は全件）
   * 登録日で並べるときは、月が変わるところに区切りの行（type: 'month'）を入れる。
   * @returns {{ rows: Array, total: number, shown: number, hasMore: boolean }}
   */
  function buildArchiveView(items, options) {
    var opt = options || {};
    var q = String(opt.q || '').trim().toLowerCase();
    var sortKey = opt.sortKey || 'saved';
    var dir = opt.dir === 'asc' ? 1 : -1;
    var today = opt.today || '';

    var wantTags = opt.tags || [];
    var filtered = (items || []).filter(function (item) {
      if (opt.category && item.category !== opt.category) { return false; }
      if (wantTags.length) {
        var have = item.tags || [];
        var hit = wantTags.filter(function (tag) { return have.indexOf(tag) !== -1; }).length;
        if (opt.tagMode === 'and' ? hit !== wantTags.length : hit === 0) { return false; }
      }
      if (opt.upcoming) {
        var date = parseEventIso(item.eventIso).date;
        if (!date || date < today) { return false; }
      }
      if (!q) { return true; }
      var haystack = ARCHIVE_SEARCH_FIELDS.map(function (key) { return String(item[key] || ''); })
        .concat([(item.tags || []).join(' ')]).join('\n').toLowerCase();
      return haystack.indexOf(q) !== -1;
    });

    var valueOf = function (item) {
      if (sortKey === 'event') { return parseEventIso(item.eventIso).date + 'T' + (parseEventIso(item.eventIso).startTime || ''); }
      if (sortKey === 'kind') { return String(item.kindLabel || ''); }
      if (sortKey === 'title') { return String(item.title || ''); }
      if (sortKey === 'author') { return String(item.author || ''); }
      return String(item.savedAt || '');
    };
    var sorted = filtered.map(function (item, index) { return { item: item, index: index, value: valueOf(item) }; });
    sorted.sort(function (a, b) {
      var x = a.value === 'T' ? '' : a.value;
      var y = b.value === 'T' ? '' : b.value;
      if (x === y) { return a.index - b.index; }
      if (!x) { return 1; }
      if (!y) { return -1; }
      var c = (sortKey === 'title' || sortKey === 'author' || sortKey === 'kind') ? x.localeCompare(y, 'ja') : (x < y ? -1 : 1);
      return c * dir;
    });

    var limit = opt.limit > 0 ? opt.limit : sorted.length;
    var shownItems = sorted.slice(0, limit);
    var rows = [];
    var lastMonth = null;
    shownItems.forEach(function (entry) {
      var item = entry.item;
      if (sortKey === 'saved') {
        var m = String(item.savedAt || '').match(/^(\d{4})-(\d{2})/);
        var month = m ? m[1] + '-' + m[2] : '';
        if (month !== lastMonth) {
          rows.push({ type: 'month', label: m ? m[1] + '年' + Number(m[2]) + '月' : '登録日なし' });
          lastMonth = month;
        }
      }
      rows.push({
        type: 'item',
        item: item,
        savedLabel: shortDateLabel(item.savedAt),
        eventLabel: archiveEventLabel(item.eventIso)
      });
    });
    return { rows: rows, total: sorted.length, shown: shownItems.length, hasMore: sorted.length > shownItems.length };
  }

  /**
   * 絞り込みの選択肢（カテゴリ・タグ）と、記録全体での件数を作る純粋関数。
   * 件数の多い順、同数なら名前順。空のカテゴリ・タグは除く。
   * @returns {{ categories: Array<{name: string, count: number}>, tags: Array<{name: string, count: number}> }}
   */
  function archiveFacets(items) {
    var cat = {};
    var tag = {};
    (items || []).forEach(function (item) {
      if (item.category) { cat[item.category] = (cat[item.category] || 0) + 1; }
      var seen = {};
      (item.tags || []).forEach(function (t) {
        if (t && !seen[t]) { seen[t] = true; tag[t] = (tag[t] || 0) + 1; }
      });
    });
    var list = function (map) {
      return Object.keys(map).map(function (name) { return { name: name, count: map[name] }; })
        .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name, 'ja'); });
    };
    return { categories: list(cat), tags: list(tag) };
  }

  // ---- 使用量の概算の表示 -------------------------------------------

  /** 概算の金額を「約 0.4 円」の形にする（1円以上は整数、1円未満は小数第1位まで。0.05円未満は「約 0.1 円未満」） */
  function formatYen(yen) {
    var value = Number(yen) || 0;
    if (value <= 0) { return '0 円'; }
    if (value < 0.05) { return '約 0.1 円未満'; }
    if (value < 1) { return '約 ' + value.toFixed(1) + ' 円'; }
    return '約 ' + Math.round(value).toLocaleString('ja-JP') + ' 円';
  }

  /** 今月の使用量の集計を、設定画面に出す1文にする */
  function usageSummaryText(summary) {
    if (!summary || !summary.month) { return ''; }
    var m = String(summary.month).match(/^(\d{4})-(\d{2})$/);
    var label = m ? m[1] + '年' + Number(m[2]) + '月' : summary.month;
    if (!summary.count) { return label + 'は、まだ AI を使っていません。'; }
    return label + 'の概算: ' + formatYen(summary.yen) + '（文章を整える ' + summary.analyzeCount + ' 回・要約 ' + summary.summarizeCount + ' 回）';
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
    isScheduleKind: isScheduleKind,
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
    formatYen: formatYen,
    usageSummaryText: usageSummaryText,
    archiveEventLabel: archiveEventLabel,
    streamLinkInfo: streamLinkInfo,
    buildArchiveView: buildArchiveView,
    archiveFacets: archiveFacets,
    moveArrayItem: moveArrayItem,
    normalizeUrl: normalizeUrl,
    isValidUrl: isValidUrl,
    stripEmojiNames: stripEmojiNames,
    countEmojiNames: countEmojiNames
  };
}));

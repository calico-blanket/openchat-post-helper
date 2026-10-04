// ============================================================
// 画面の操作と GAS との通信
//
//   投稿文の組み立て・分割・日付計算などの純粋なロジックは js/logic.js
//   （window.PostLogic）に置き、ここでは画面の表示と入出力だけを扱う。
//   外部由来の文字列は textContent で表示し、innerHTML には入れない。
// ============================================================

(function () {
  'use strict';

  var L = window.PostLogic;
  var SETTINGS_KEY = 'ocph.settings';
  var BOOT_CACHE_KEY = 'ocph.bootstrap';
  var TIMING_KEY = 'ocph.timings';
  var IMAGE_MAX_EDGE = 1600;
  var IMAGE_QUALITY = 0.85;

  var state = {
    boot: null,           // bootstrap の結果（config・categories・tags）
    post: null,           // 結果画面で編集中の投稿
    analysis: null,       // analyze の結果（警告・チラシの曜日など）
    summaryMode: false,   // スレッドに要約を使うか
    prefixEdited: false,  // 前置きを手で書き換えたか
    useThreadEdited: false, // 「スレッドにも投稿する」を手で切り替えたか
    talkEdited: false,    // ①のトーク本体を手で直したか（直したら自動では作り直さない）
    image: null,          // { mimeType, data, previewUrl }
    sharedStartedAt: null,
    list: { items: [], offset: 0, hasMore: false, query: null, loaded: false }
  };

  // ---- 小さな道具 ----------------------------------------------

  function $(id) { return document.getElementById(id); }

  /** 要素を作る。attrs の text は textContent、それ以外は属性として設定する */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === undefined || value === null || value === false) { return; }
      if (key === 'text') { node.textContent = value; }
      else if (key === 'className') { node.className = value; }
      else if (key === 'onClick') { node.addEventListener('click', value); }
      else { node.setAttribute(key, value === true ? '' : value); }
    });
    (children || []).forEach(function (child) { if (child) { node.appendChild(child); } });
    return node;
  }

  function readStorage(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // 保存できなくても動作は続ける（プライベートモードなど）
    }
  }

  function config() { return (state.boot && state.boot.config) || {}; }

  /** 状態メッセージを読み上げる（画面上にも出す） */
  function announce(message) {
    $('alertRegion').textContent = '';
    var region = $('statusRegion');
    region.textContent = '';
    // 同じ文言でも読み上げ直されるよう、いったん空にしてから入れる
    setTimeout(function () { region.textContent = message; }, 50);
  }

  /** エラーを読み上げる */
  function alertMessage(message) {
    $('statusRegion').textContent = '';
    $('alertRegion').textContent = message;
  }

  function clearMessages() {
    $('statusRegion').textContent = '';
    $('alertRegion').textContent = '';
  }

  function setBusy(button, busy, busyLabel) {
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = busyLabel;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    } else {
      button.textContent = button.dataset.label || button.textContent;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  // ---- 画面の切り替え ----------------------------------------------

  var VIEWS = ['inputView', 'resultView', 'listView', 'settingsView'];

  function showView(viewId, options) {
    VIEWS.forEach(function (id) { $(id).hidden = id !== viewId; });
    // 結果画面は「新規」の流れの一部として扱う
    var navTarget = viewId === 'resultView' ? 'inputView' : viewId;
    document.querySelectorAll('[data-nav]').forEach(function (button) {
      if (button.dataset.nav === navTarget) { button.setAttribute('aria-current', 'page'); }
      else { button.removeAttribute('aria-current'); }
    });
    if (!(options && options.keepFocus)) {
      var heading = $(viewId).querySelector('h1');
      if (heading) { heading.focus(); }
    }
    window.scrollTo(0, 0);
  }

  // ---- 設定と GAS 通信 ----------------------------------------------

  function loadSettings() {
    var s = readStorage(SETTINGS_KEY);
    return s && s.gasUrl ? s : null;
  }

  /**
   * GAS に POST する。Content-Type を text/plain にして CORS のプリフライトを避ける
   * （GAS の Web アプリは OPTIONS に応答できないため）。
   * ok:false は呼び出し側で扱えるよう、そのまま返す。
   */
  function gasPost(body) {
    var settings = loadSettings();
    if (!settings) {
      return Promise.reject(new Error('設定画面で GAS の URL と合言葉を入れてください'));
    }
    return fetch(settings.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: settings.token || '' }, body))
    }).then(function (response) {
      return response.json();
    }, function () {
      throw new Error('通信に失敗しました。電波の状態と GAS の URL を確認してください');
    });
  }

  /** ok:false ならエラーにする版 */
  function gasCall(body) {
    return gasPost(body).then(function (json) {
      if (!json || json.ok !== true) {
        throw new Error((json && json.error) || '不明なエラーです');
      }
      return json;
    });
  }

  function applyBoot(boot) {
    state.boot = boot;
    renderSourceSelect($('inputSource'), true);
    renderSearchFilters();
    renderManageLists();
    var info = '接続できました。モデル: ' + boot.model + '／Jev: ' + (boot.jevConfigured ? '使う' : '使わない（Gemini が分類）');
    if (!boot.geminiConfigured) { info += '／Gemini の API キーが未設定です'; }
    $('serverInfo').textContent = info;
    var sheetUrl = String(boot.spreadsheetUrl || '');
    var isSheetUrl = /^https:\/\/docs\.google\.com\/spreadsheets\//.test(sheetUrl);
    $('sheetLink').href = isSheetUrl ? sheetUrl : '#';
    $('sheetLinkArea').hidden = !isSheetUrl;
    var publicUrl = String(boot.publicSpreadsheetUrl || '');
    var hasPublic = /^https:\/\/docs\.google\.com\/spreadsheets\//.test(publicUrl);
    $('publicSheetLink').href = hasPublic ? publicUrl : '#';
    $('publicSheetLinkArea').hidden = !hasPublic;
    $('syncPublicSheetButton').hidden = !hasPublic;
    $('publicSheetState').textContent = hasPublic
      ? '保存・更新・削除のたびに、公開用スプレッドシートの「記録一覧」タブを自動で書き直します（ID とトーク本文は載せません）。内容がずれていると感じたら「作り直す」を押してください。'
      : 'まだ設定されていません。GAS エディタで関数 createPublicSpreadsheet を1回実行すると作られます（README 参照）。';
    $('usageSummary').textContent = L.usageSummaryText(boot.usageThisMonth) || '今月の概算は、まだありません。';
    $('archiveState').textContent = boot.archivePublic
      ? '公開中です。合言葉なしで誰でも読める記録の一覧です（ID は出ません）。オープンチャットにはこのページの URL を貼ります。'
      : 'いまは公開していません。公開するには、GAS のスクリプトプロパティ ARCHIVE_PUBLIC を true にし、archive-config.js に GAS の URL を入れます（README 参照）。';
  }

  /** キャッシュがあれば先に使い、裏で最新化する */
  function loadBootstrap() {
    var cached = readStorage(BOOT_CACHE_KEY);
    if (cached && cached.config) { applyBoot(cached); }
    if (!loadSettings()) { return Promise.resolve(false); }
    return gasCall({ action: 'bootstrap' }).then(function (boot) {
      writeStorage(BOOT_CACHE_KEY, boot);
      applyBoot(boot);
      return true;
    });
  }

  function updateBootLists(json) {
    if (!state.boot) { return; }
    if (json.categories) { state.boot.categories = json.categories; }
    if (json.tags) { state.boot.tags = json.tags; }
    if (json.authors) { state.boot.authors = json.authors; renderAuthorPicks(); }
    writeStorage(BOOT_CACHE_KEY, state.boot);
    renderSearchFilters();
    renderManageLists();
  }

  // ---- 入力画面 ------------------------------------------------------

  function renderSourceSelect(select, withAuto) {
    var current = select.value;
    select.textContent = '';
    if (withAuto) { select.appendChild(el('option', { value: '', text: '自動で判定する' })); }
    (config().sources || []).forEach(function (s) {
      select.appendChild(el('option', { value: s.key, text: s.label }));
    });
    select.value = current;
  }

  /** 画像を長辺 IMAGE_MAX_EDGE px の JPEG に縮小して base64 にする */
  function resizeImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        var dataUrl = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
        resolve({ mimeType: 'image/jpeg', data: dataUrl.split(',')[1], previewUrl: url });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('画像を読み込めませんでした。JPEG・PNG・WebP の画像を選んでください'));
      };
      img.src = url;
    });
  }

  function clearImage() {
    if (state.image && state.image.previewUrl) { URL.revokeObjectURL(state.image.previewUrl); }
    state.image = null;
    $('imageInput').value = '';
    $('imagePreview').hidden = true;
    $('imagePreviewImg').removeAttribute('src');
  }

  function resetInput() {
    $('inputSource').value = '';
    $('inputUrl').value = '';
    $('inputText').value = '';
    $('sharedNotice').hidden = true;
    clearImage();
  }

  function runAnalyze() {
    var url = $('inputUrl').value.trim();
    var text = $('inputText').value;
    if (!url && !text.trim() && !state.image) {
      alertMessage('URL・本文・画像のどれかを入れてください');
      $('inputUrl').focus();
      return;
    }
    if (url && !/^https?:\/\/\S+$/i.test(url)) {
      alertMessage('URL は http:// または https:// で始まる形で入れてください');
      $('inputUrl').focus();
      return;
    }
    var button = $('analyzeButton');
    setBusy(button, true, '整えています…');
    announce('文章を整えています。10秒ほどかかることがあります');
    var startedAt = performance.now();

    gasPost({
      action: 'analyze',
      url: url,
      text: text,
      source: $('inputSource').value,
      image: state.image ? { mimeType: state.image.mimeType, data: state.image.data } : null
    }).then(function (result) {
      setBusy(button, false);
      if (!result || result.ok !== true) {
        throw new Error((result && result.error) || '不明なエラーです');
      }
      if (!result.analyzed && result.fetchStatus === 'needs_paste') {
        var reason = (result.warnings && result.warnings[0]) || '本文を取得できませんでした。本文を貼り付けてください';
        alertMessage(reason + '。貼り付けたら、もう一度「文章を整える」を押してください');
        $('inputText').focus();
        return;
      }
      openResult(postFromAnalysis(result), result);
      reportElapsed(startedAt);
    }).catch(function (err) {
      setBusy(button, false);
      alertMessage('整えられませんでした: ' + err.message + '（「AI を使わずに手で作る」でも続けられます）');
    });
  }

  /** 所要時間を表示・読み上げし、共有から始まった場合は記録する */
  function reportElapsed(startedAt) {
    var fromShare = state.sharedStartedAt !== null;
    // 共有から始まった場合はページを開いた時点（共有シートで起動した時点）から測る
    var base = fromShare ? 0 : startedAt;
    var seconds = ((performance.now() - base) / 1000).toFixed(1);
    var label = fromShare ? '共有から結果表示まで ' : '処理時間 ';
    var usage = state.analysis && state.analysis.usage;
    $('elapsedNote').textContent = label + seconds + ' 秒' + (usage && usage.yen ? '／今回の AI の概算 ' + L.formatYen(usage.yen) : '');
    $('elapsedNote').hidden = false;
    announce('文章を整えました（' + seconds + ' 秒）。内容を確認してください');
    if (fromShare) {
      var timings = readStorage(TIMING_KEY) || [];
      timings.unshift({ at: new Date().toISOString(), seconds: Number(seconds), source: state.post.source, image: !!state.image });
      writeStorage(TIMING_KEY, timings.slice(0, 20));
      state.sharedStartedAt = null;
      renderTimings();
    }
  }

  function startManual() {
    var url = $('inputUrl').value.trim();
    var source = $('inputSource').value || L.detectSource(url) || (state.image ? 'flyer' : 'other');
    openResult({
      id: '', kind: '', source: source, author: '', category: '', title: '', summary: '',
      url: url, original: $('inputText').value, tags: [], memo: '', talk: '',
      event: { date: '', startTime: '', endTime: '', place: '', performers: '', deadline: '' }
    }, null);
    announce('手で入力できます。タイトル・種別・カテゴリを入れてください');
  }

  // ---- 結果画面 ------------------------------------------------------

  function postFromAnalysis(r) {
    var tags = (r.tags || []).concat(r.legislatorTags || []);
    return {
      id: '',
      kind: r.kind || '',
      source: r.source || 'other',
      author: r.author || '',
      category: r.category || '',
      title: r.title || '',
      summary: r.summary || '',
      url: r.resolvedUrl || '',
      original: r.originalText || '',
      tags: tags.filter(function (t, i) { return tags.indexOf(t) === i; }),
      memo: '',
      talk: '',
      event: r.event || {}
    };
  }

  function postFromItem(item) {
    var ev = L.parseEventIso(item.eventIso);
    return {
      id: item.id,
      kind: item.kind,
      source: item.source,
      author: item.author || '',
      talk: item.talk || '',
      category: item.category,
      title: item.title,
      summary: item.summary,
      url: item.url,
      original: item.original,
      tags: item.tags || [],
      memo: item.memo,
      event: {
        date: ev.date, startTime: ev.startTime, endTime: ev.endTime,
        place: item.place, performers: item.performers, deadline: item.deadline,
        joinUrl: item.joinUrl || '', applyUrl: item.applyUrl || ''
      }
    };
  }

  function openResult(post, analysis) {
    state.post = post;
    state.analysis = analysis;
    state.summaryMode = false;
    state.prefixEdited = false;
    if (!analysis) { $('elapsedNote').hidden = true; }

    renderKindRadios(post.kind);
    renderSourceSelect($('fSource'), false);
    $('fSource').value = post.source || 'other';
    renderCategorySelect(post.category);
    renderTagChecks(post.tags);
    renderAuthorPicks();

    $('fTitle').value = post.title;
    $('fSummary').value = post.summary;
    $('fAuthor').value = post.author;
    $('fEventDate').value = post.event.date || '';
    $('fStartTime').value = post.event.startTime || '';
    $('fEndTime').value = post.event.endTime || '';
    $('fPlace').value = post.event.place || '';
    $('fPerformers').value = post.event.performers || '';
    $('fDeadline').value = post.event.deadline || '';
    $('fJoinUrl').value = post.event.joinUrl || '';
    $('fApplyUrl').value = post.event.applyUrl || '';
    $('fUrl').value = post.url;
    // 保存済みのトーク本文があれば、それをそのまま使う（作り直さない）
    state.talkEdited = !!post.talk;
    $('fTalk').value = post.talk || '';
    $('fMemo').value = post.memo;
    $('fOriginal').value = post.original;
    $('fSummaryDraft').value = '';
    $('summaryDraftArea').hidden = true;
    $('revertSummaryButton').hidden = true;
    $('fPrefix').value = autoPrefix();
    state.useThreadEdited = false;
    $('fUseThread').checked = L.defaultUseThread(config(), post.source, post.url);
    clearFieldErrors();

    $('saveButton').textContent = post.id ? '更新する' : '保存する';
    $('deleteButton').hidden = !post.id;

    refreshOutputs();

    // スレッドの編集欄はふだん閉じておく。原文が無いときだけ開く
    $('threadEditDetails').open = !post.original;
    showView('resultView');
  }

  /**
   * 日時まわりの警告文を返す。
   *   - AI が「日時が未確定」と判断した（日時は空にしてある）
   *   - 原文に「または」「未定」などがあるのに、日時が入っている（コードで検出）
   *   - チラシの曜日と、日付から計算した曜日が違う
   */
  function dateWarnings(post) {
    var items = [];
    var a = state.analysis;
    // 日付を手で入れたあとは「入れていません」が事実と合わなくなるので、空のときだけ出す
    if (a && a.dateUncertain && !post.event.date) {
      items.push('AI は開催日時がまだ確定していないと判断したため、トークに日時を入れていません' +
        (a.dateNote ? '（原文: ' + a.dateNote + '）' : '') + '。確定したら③の開催日時に入れてください');
    }
    if (post.kind === 'schedule' && post.event.date) {
      var uncertain = L.uncertainDateWarning(post.original);
      if (uncertain) { items.push(uncertain); }
    }
    var mismatch = L.weekdayMismatchWarning(post.event.date, a ? a.flyerWeekday : '');
    if (mismatch) { items.push(mismatch); }
    return items;
  }

  /**
   * 発信者の候補ボタン（「名前なし」＋設定画面の候補）を描く。
   * 押すと欄に入り、前置き・出典行が作り直される。今の欄の値と同じボタンは押された状態（aria-pressed）にする。
   */
  function renderAuthorPicks() {
    var group = $('fAuthorPicks');
    group.textContent = '';
    var names = [''].concat((state.boot && state.boot.authors) || []);
    names.forEach(function (name) {
      group.appendChild(el('button', {
        type: 'button',
        className: 'button secondary small pick-button',
        text: name || '名前なし',
        'data-author': name,
        'aria-pressed': 'false',
        onClick: function () {
          $('fAuthor').value = name;
          // 欄に手で入力したときと同じ処理（前置きの自動更新・プレビュー更新）を走らせる
          $('fAuthor').dispatchEvent(new Event('input', { bubbles: true }));
          announce(name ? '発信者を「' + name + '」にしました' : '発信者を空にしました');
        }
      }));
    });
    updateAuthorPicks();
  }

  function updateAuthorPicks() {
    var current = $('fAuthor').value.trim();
    Array.prototype.forEach.call(document.querySelectorAll('#fAuthorPicks [data-author]'), function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-author') === current ? 'true' : 'false');
    });
  }

  /** 種別によっては使わない欄（開催日時など）を隠す。発信者は記録に残すので常に出す */
  function updateFieldVisibility(post) {
    $('eventFields').hidden = post.kind !== 'schedule';
  }

  function renderKindRadios(selected) {
    var group = $('fKindGroup');
    group.textContent = '';
    (config().kinds || []).forEach(function (k) {
      var input = el('input', { type: 'radio', name: 'kind', value: k.key });
      input.checked = k.key === selected;
      group.appendChild(el('label', { className: 'choice' }, [input, document.createTextNode(' ' + k.label)]));
    });
  }

  function renderCategorySelect(selected) {
    var select = $('fCategory');
    select.textContent = '';
    select.appendChild(el('option', { value: '', text: '選んでください' }));
    var categories = (state.boot && state.boot.categories) || [];
    categories.forEach(function (c) { select.appendChild(el('option', { value: c, text: c })); });
    // 一覧から消したカテゴリの投稿を開いた場合も、値を失わないよう選択肢に残す
    if (selected && categories.indexOf(selected) === -1) {
      select.appendChild(el('option', { value: selected, text: selected + '（一覧にないカテゴリ）' }));
    }
    select.value = selected || '';
  }

  /** タグ（登録済みタグ＋議員名）のチェックボックスを描く */
  function renderTagChecks(selected) {
    var group = $('fTagGroup');
    group.textContent = '';
    var names = ((state.boot && state.boot.tags) || []).concat(config().legislators || []);
    (selected || []).forEach(function (t) { if (names.indexOf(t) === -1) { names.push(t); } });
    names = names.filter(function (t, i) { return names.indexOf(t) === i; });
    names.forEach(function (name) {
      var input = el('input', { type: 'checkbox', name: 'tag', value: name });
      input.checked = (selected || []).indexOf(name) !== -1;
      group.appendChild(el('label', { className: 'choice' }, [input, document.createTextNode(' ' + name)]));
    });
    $('fTagEmpty').hidden = names.length > 0;
  }

  /** フォームから現在の投稿内容を読む */
  function readPost() {
    var kind = document.querySelector('input[name="kind"]:checked');
    var tags = Array.prototype.map.call(document.querySelectorAll('input[name="tag"]:checked'), function (i) { return i.value; });
    return {
      id: state.post ? state.post.id : '',
      kind: kind ? kind.value : '',
      source: $('fSource').value,
      author: $('fAuthor').value.trim(),
      category: $('fCategory').value,
      title: $('fTitle').value.trim(),
      summary: $('fSummary').value.trim(),
      url: $('fUrl').value.trim(),
      original: $('fOriginal').value,
      talk: $('fTalk').value,
      useThread: $('fUseThread').checked,
      tags: tags,
      memo: $('fMemo').value,
      event: {
        date: $('fEventDate').value,
        startTime: $('fStartTime').value,
        endTime: $('fEndTime').value,
        place: $('fPlace').value.trim(),
        performers: $('fPerformers').value.trim(),
        deadline: $('fDeadline').value,
        joinUrl: $('fJoinUrl').value.trim(),
        applyUrl: $('fApplyUrl').value.trim()
      }
    };
  }

  function autoPrefix() {
    return L.buildThreadPrefix(config(), $('fSource').value, $('fAuthor').value, state.summaryMode);
  }

  function todayIso() { return L.todayIsoInTokyo(new Date()); }

  /** 警告・プレビュー・スレッドのメッセージをすべて描き直す */
  function refreshOutputs() {
    var post = readPost();

    $('fEventWeekday').textContent = L.weekdayOf(post.event.date) || '—';
    $('fDeadlineWeekday').textContent = L.weekdayOf(post.event.deadline) || '—';

    updateFieldVisibility(post);
    updateAuthorPicks();
    $('threadContent').hidden = !post.useThread;

    var flyerWeekday = state.analysis ? state.analysis.flyerWeekday : '';
    var mismatch = L.weekdayMismatchWarning(post.event.date, flyerWeekday);
    $('weekdayWarning').textContent = mismatch;
    $('weekdayWarning').hidden = !mismatch;

    renderWarnings(post);

    // 手で直す前は、③の項目からトーク本体を作り直す。直したあとは上書きしない
    if (!state.talkEdited) {
      $('fTalk').value = L.buildTalkBody(post, config(), todayIso());
    }
    $('talkEditedNote').hidden = !state.talkEdited;
    $('copyTalkButton').textContent = 'トーク本体をコピー';

    if (state.summaryMode) {
      var warnings = L.summaryWarnings(L.checkSummary(post.original, $('fSummaryDraft').value));
      var list = $('summaryWarningList');
      list.textContent = '';
      warnings.forEach(function (w) { list.appendChild(el('li', { text: w })); });
    }
    renderThreadMessages(post);
  }

  function renderWarnings(post) {
    var items = [];
    var a = state.analysis;
    if (a) {
      (a.warnings || []).forEach(function (w) { items.push(w); });
      if (a.duplicate) {
        items.push('同じ URL の投稿がすでに保存されています: 「' + a.duplicate.title + '」（' + a.duplicate.savedAt + '）');
      }
      if (a.originalFromImage) {
        items.push('スレッドの原文は画像から読み取った文章です。チラシと見比べて確認してください');
      }
      if (a.analyzed && post.kind === 'schedule' && post.event.date) {
        items.push('日時・場所は AI が読み取った値です。必ず原文やチラシと見比べてください');
      }
    }
    dateWarnings(post).forEach(function (w) { items.push(w); });
    var meeting = L.meetingUrlWarning([post.event.joinUrl, post.event.applyUrl, post.url]);
    if (meeting) { items.push(meeting); }
    var list = $('resultWarningList');
    list.textContent = '';
    items.forEach(function (w) { list.appendChild(el('li', { text: w })); });
    $('resultWarnings').hidden = items.length === 0;
  }

  function renderThreadMessages(post) {
    var limits = config().limits || {};
    var body = state.summaryMode ? $('fSummaryDraft').value : post.original;
    var messages = L.buildThreadMessages({
      source: post.source,
      urlFirstSources: config().urlFirstSources,
      url: post.url,
      prefix: $('fPrefix').value,
      body: body,
      memo: post.memo,
      maxChars: limits.threadMessageMaxChars,
      commentTemplate: config().commentLine
    });
    var list = $('threadMessages');
    list.textContent = '';
    messages.forEach(function (m, index) {
      var number = index + 1;
      var label = m.kind === 'url' ? number + '通目（URL だけ）' : number + '通目';
      var headingId = 'threadMessage' + number;
      // 直前の見出し（「1通目（○文字）」）で何のメッセージかわかるので、pre には名前を付けない
      var pre = el('pre', { className: 'message-preview' });
      pre.textContent = m.text;
      var button = el('button', {
        type: 'button', className: 'button secondary', text: label + 'をコピー',
        onClick: function () { copyText(m.text, label, button); }
      });
      list.appendChild(el('li', {}, [
        el('h3', { id: headingId, className: 'message-meta', text: label + '（' + m.text.length + ' 文字）' }),
        pre,
        button
      ]));
    });
    if (!messages.length) {
      list.appendChild(el('li', { text: '原文がありません。原文欄に本文を入れてください。' }));
    }
  }

  /** クリップボードにコピーする（使えない環境では選択してコピーする方式に切り替える） */
  function copyText(text, label, button) {
    var done = function () {
      if (button) { button.textContent = '✓ ' + label + 'をコピーしました'; }
      announce(label + 'をコピーしました');
    };
    var fallback = function () {
      var area = el('textarea', { readonly: true, 'aria-hidden': 'true', className: 'visually-hidden' });
      area.value = text;
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area);
      if (button) { button.focus(); }
      if (ok) { done(); } else { alertMessage('コピーできませんでした。プレビューを長押しして選択・コピーしてください'); }
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function copyTalk() {
    // 手で直していなければ、「本日」「明日」を押した時点の日付で作り直してからコピーする
    if (!state.talkEdited) {
      $('fTalk').value = L.buildTalkBody(readPost(), config(), todayIso());
    }
    copyText($('fTalk').value, 'トーク本体', $('copyTalkButton'));
  }

  /** ③の項目からトーク本体を作り直す（手で直した文は消えるので確認する） */
  function regenerateTalk() {
    if (state.talkEdited && !window.confirm('手で直したトーク本体の文は消えて、③の項目から作り直します。よろしいですか？')) {
      return;
    }
    state.talkEdited = false;
    refreshOutputs();
    announce('③の項目からトーク本体を作り直しました');
    $('fTalk').focus();
  }

  // ---- 要約 ----------------------------------------------------------

  function runSummarize() {
    var original = $('fOriginal').value;
    if (!original.trim()) {
      alertMessage('要約する原文がありません');
      $('fOriginal').focus();
      return;
    }
    var length = document.querySelector('input[name="summaryLength"]:checked').value;
    var button = $('summarizeButton');
    setBusy(button, true, '要約しています…');
    announce('要約しています');
    gasCall({ action: 'summarize', text: original, length: length }).then(function (json) {
      setBusy(button, false);
      $('fSummaryDraft').value = json.summary;
      state.summaryMode = true;
      $('summaryDraftArea').hidden = false;
      $('revertSummaryButton').hidden = false;
      $('fPrefix').value = autoPrefix();
      state.prefixEdited = false;
      refreshOutputs();
      var count = $('summaryWarningList').children.length;
      var cost = json.usage && json.usage.yen ? '（AI の概算 ' + L.formatYen(json.usage.yen) + '）' : '';
      announce((count ? '要約しました。警告が ' + count + ' 件あります。確認してください' : '要約しました。下書きを確認してください') + cost);
      $('fSummaryDraft').focus();
    }).catch(function (err) {
      setBusy(button, false);
      alertMessage('要約できませんでした: ' + err.message);
    });
  }

  function revertSummary() {
    state.summaryMode = false;
    $('summaryDraftArea').hidden = true;
    $('revertSummaryButton').hidden = true;
    $('fPrefix').value = autoPrefix();
    state.prefixEdited = false;
    refreshOutputs();
    announce('原文に戻しました');
    $('summarizeButton').focus();
  }

  // ---- 保存・削除 ------------------------------------------------------

  function clearFieldErrors() {
    ['fTitle', 'fCategory'].forEach(function (id) { $(id).removeAttribute('aria-invalid'); });
    $('fKindGroup').removeAttribute('aria-invalid');
  }

  /** 必須項目を確かめ、足りなければ最初の欄にフォーカスして知らせる */
  function validateRequired(post) {
    clearFieldErrors();
    var problems = [];
    var firstInvalid = null;
    if (!post.title) {
      problems.push('タイトル');
      $('fTitle').setAttribute('aria-invalid', 'true');
      firstInvalid = firstInvalid || $('fTitle');
    }
    if (!post.kind) {
      problems.push('種別');
      $('fKindGroup').setAttribute('aria-invalid', 'true');
      firstInvalid = firstInvalid || document.querySelector('input[name="kind"]');
    }
    if (!post.category) {
      problems.push('カテゴリ');
      $('fCategory').setAttribute('aria-invalid', 'true');
      firstInvalid = firstInvalid || $('fCategory');
    }
    if (problems.length) {
      alertMessage('入力が足りません: ' + problems.join('、') + 'を入れてください');
      if (firstInvalid) {
        // 閉じた折りたたみの中の欄にはフォーカスできないため、先に開く
        var details = firstInvalid.closest('details');
        if (details) { details.open = true; }
        firstInvalid.focus();
      }
      return false;
    }
    return true;
  }

  function buildSavePayload(post, force) {
    return {
      action: post.id ? 'update' : 'save',
      id: post.id || undefined,
      force: force === true,
      kind: post.kind,
      source: post.source,
      category: post.category,
      title: post.title,
      summary: post.summary,
      url: post.url,
      // スレッドを使わず URL で誘導する投稿は、全文が URL 先にあるので原文を保存しない（note の長文など）
      original: (post.useThread || !String(post.url || '').trim()) ? post.original : '',
      tags: post.tags,
      eventIso: L.buildEventIso(post.event.date, post.event.startTime, post.event.endTime),
      place: post.event.place,
      deadline: post.event.deadline,
      performers: post.event.performers,
      memo: post.memo,
      author: post.author,
      talk: post.talk,
      joinUrl: post.event.joinUrl,
      applyUrl: post.event.applyUrl
    };
  }

  function savePost(force) {
    var post = readPost();
    if (!validateRequired(post)) { return; }
    var button = $('saveButton');
    setBusy(button, true, '保存しています…');
    gasPost(buildSavePayload(post, force)).then(function (json) {
      setBusy(button, false);
      if (json && json.duplicate && !force) {
        var message = '同じ URL の投稿がすでにあります。\n「' + json.duplicate.title + '」（' + json.duplicate.savedAt + '）\n\nそれでも保存しますか？';
        if (window.confirm(message)) { savePost(true); }
        else { announce('保存を取りやめました'); }
        return;
      }
      if (!json || json.ok !== true) { throw new Error((json && json.error) || '不明なエラーです'); }
      if (!post.id) {
        state.post.id = json.id;
        $('saveButton').textContent = '更新する';
        $('deleteButton').hidden = false;
      }
      state.list.loaded = false;
      var done = post.id ? '更新しました' : '保存しました';
      if (json.publicSheet && json.publicSheet.ok === false) {
        alertMessage(done + '。ただし、公開用シートの書き直しに失敗しました（' + json.publicSheet.error + '）。設定画面の「公開用シートを作り直す」を試してください');
      } else {
        announce(done);
      }
    }).catch(function (err) {
      setBusy(button, false);
      alertMessage('保存できませんでした: ' + err.message);
    });
  }

  function deletePost(id, title, after) {
    if (!window.confirm('「' + title + '」を削除します。元に戻せません（スプレッドシートの版の履歴からは戻せます）。よろしいですか？')) {
      return;
    }
    gasCall({ action: 'delete', id: id }).then(function (json) {
      state.list.loaded = false;
      if (json.publicSheet && json.publicSheet.ok === false) {
        alertMessage('「' + title + '」を削除しました。ただし、公開用シートの書き直しに失敗しました（' + json.publicSheet.error + '）。設定画面の「公開用シートを作り直す」を試してください');
      } else {
        announce('「' + title + '」を削除しました');
      }
      if (after) { after(); }
    }).catch(function (err) {
      alertMessage('削除できませんでした: ' + err.message);
    });
  }

  // ---- 一覧・検索 ------------------------------------------------------

  function renderSearchFilters() {
    var cat = $('searchCategory');
    var current = cat.value;
    cat.textContent = '';
    cat.appendChild(el('option', { value: '', text: 'すべて' }));
    ((state.boot && state.boot.categories) || []).forEach(function (c) { cat.appendChild(el('option', { value: c, text: c })); });
    cat.value = current;

    var kind = $('searchKind');
    var currentKind = kind.value;
    kind.textContent = '';
    kind.appendChild(el('option', { value: '', text: 'すべて' }));
    (config().kinds || []).forEach(function (k) { kind.appendChild(el('option', { value: k.key, text: k.label })); });
    kind.value = currentKind;

    var group = $('searchTagGroup');
    var checked = Array.prototype.map.call(group.querySelectorAll('input:checked'), function (i) { return i.value; });
    group.textContent = '';
    ((state.boot && state.boot.tags) || []).concat(config().legislators || []).forEach(function (name) {
      var input = el('input', { type: 'checkbox', name: 'searchTag', value: name });
      input.checked = checked.indexOf(name) !== -1;
      group.appendChild(el('label', { className: 'choice' }, [input, document.createTextNode(' ' + name)]));
    });
  }

  function runSearch(append) {
    if (!append) {
      state.list.query = {
        keyword: $('searchKeyword').value.trim(),
        category: $('searchCategory').value,
        kind: $('searchKind').value,
        tags: Array.prototype.map.call(document.querySelectorAll('input[name="searchTag"]:checked'), function (i) { return i.value; })
      };
      state.list.offset = 0;
      state.list.items = [];
    }
    announce('検索しています');
    gasCall(Object.assign({ action: 'search', offset: state.list.offset }, state.list.query)).then(function (json) {
      state.list.items = state.list.items.concat(json.items);
      state.list.offset = state.list.items.length;
      state.list.hasMore = json.hasMore;
      state.list.loaded = true;
      var firstNew = renderList(append ? json.items.length : 0);
      announce(state.list.items.length ? state.list.items.length + ' 件を表示しています' + (json.hasMore ? '（まだあります）' : '') : '見つかりませんでした');
      if (append && firstNew) { firstNew.focus(); }
    }).catch(function (err) {
      alertMessage('検索できませんでした: ' + err.message);
    });
  }

  /** 一覧を描く。追加読み込みのときは、追加分の先頭の見出しを返す（フォーカス移動用） */
  function renderList(appendedCount) {
    var list = $('listItems');
    list.textContent = '';
    var kindLabel = function (key) {
      var k = (config().kinds || []).filter(function (x) { return x.key === key; })[0];
      return k ? k.label : '';
    };
    var firstNewHeading = null;
    var firstNewIndex = state.list.items.length - appendedCount;
    state.list.items.forEach(function (item, index) {
      var ev = L.parseEventIso(item.eventIso);
      var meta = [item.savedAt, kindLabel(item.kind), item.category];
      if (ev.date) { meta.push('開催 ' + L.formatDateJa(ev.date)); }
      var heading = el('h2', { className: 'item-title', text: item.title, tabindex: '-1' });
      if (appendedCount && index === firstNewIndex) { firstNewHeading = heading; }
      var tagList = el('ul', { className: 'tag-list', 'aria-label': 'タグ' });
      (item.tags || []).forEach(function (t) { tagList.appendChild(el('li', { text: t })); });
      list.appendChild(el('li', {}, [
        heading,
        el('p', { className: 'item-meta', text: meta.filter(Boolean).join('　') }),
        item.tags && item.tags.length ? tagList : null,
        el('div', { className: 'actions' }, [
          el('button', {
            type: 'button', className: 'button secondary small', text: '開く',
            'aria-label': '「' + item.title + '」を開く',
            onClick: function () { openResult(postFromItem(item), null); }
          }),
          el('button', {
            type: 'button', className: 'button danger small', text: '削除',
            'aria-label': '「' + item.title + '」を削除',
            onClick: function () {
              deletePost(item.id, item.title, function () {
                state.list.items = state.list.items.filter(function (x) { return x.id !== item.id; });
                state.list.offset = state.list.items.length;
                renderList(0);
                $('listHeading').focus();
              });
            }
          })
        ])
      ]));
    });
    $('moreButton').hidden = !state.list.hasMore;
    return firstNewHeading;
  }

  // ---- 設定 ------------------------------------------------------------

  // 設定画面で管理する一覧（カテゴリ・タグ・発信者の候補）の定義
  var LIST_UI = {
    category: {
      label: 'カテゴリ', key: 'categories', add: 'addCategory', remove: 'removeCategory', reorder: 'reorderCategories',
      list: 'categoryManageList', heading: 'categoryManageHeading', input: 'newCategory',
      removeNote: '（保存済みの投稿はそのまま残ります）'
    },
    tag: {
      label: 'タグ', key: 'tags', add: 'addTag', remove: 'removeTag', reorder: 'reorderTags',
      list: 'tagManageList', heading: 'tagManageHeading', input: 'newTag',
      removeNote: '（保存済みの投稿はそのまま残ります）'
    },
    author: {
      label: '発信者の候補', key: 'authors', add: 'addAuthor', remove: 'removeAuthor', reorder: 'reorderAuthors',
      list: 'authorManageList', heading: 'authorManageHeading', input: 'newAuthor',
      removeNote: ''
    }
  };

  function renderManageLists() {
    Object.keys(LIST_UI).forEach(function (type) {
      renderManageList($(LIST_UI[type].list), (state.boot && state.boot[LIST_UI[type].key]) || [], type);
    });
  }

  function renderManageList(container, names, type) {
    var def = LIST_UI[type];
    container.textContent = '';
    names.forEach(function (name, index) {
      var move = function (delta) {
        var body = { action: def.reorder };
        body[def.key] = L.moveArrayItem(names, index, delta);
        gasCall(body).then(function (json) {
          updateBootLists(json);
          announce(def.label + '「' + name + '」を' + (delta < 0 ? '上' : '下') + 'へ移動しました');
          var buttons = container.querySelectorAll('li')[index + delta];
          if (buttons) { buttons.querySelector(delta < 0 ? '[data-move="up"]' : '[data-move="down"]').focus(); }
        }).catch(function (err) { alertMessage(err.message); });
      };
      container.appendChild(el('li', {}, [
        el('span', { className: 'name', text: name }),
        el('button', {
          type: 'button', className: 'button secondary small', text: '↑', 'data-move': 'up',
          'aria-label': '「' + name + '」を上へ', disabled: index === 0,
          onClick: function () { move(-1); }
        }),
        el('button', {
          type: 'button', className: 'button secondary small', text: '↓', 'data-move': 'down',
          'aria-label': '「' + name + '」を下へ', disabled: index === names.length - 1,
          onClick: function () { move(1); }
        }),
        el('button', {
          type: 'button', className: 'button danger small', text: '削除',
          'aria-label': def.label + '「' + name + '」を削除',
          onClick: function () {
            if (!window.confirm(def.label + '「' + name + '」を一覧から外します' + def.removeNote + '。よろしいですか？')) { return; }
            gasCall({ action: def.remove, name: name }).then(function (json) {
              updateBootLists(json);
              announce(def.label + '「' + name + '」を外しました');
              $(def.heading).focus();
            }).catch(function (err) { alertMessage(err.message); });
          }
        })
      ]));
    });
    if (!names.length) {
      container.appendChild(el('li', { text: 'まだありません' }));
    }
  }

  function addListItem(type) {
    var def = LIST_UI[type];
    var input = $(def.input);
    var name = input.value.trim();
    if (!name) { alertMessage('名前を入れてください'); input.focus(); return; }
    gasCall({ action: def.add, name: name }).then(function (json) {
      updateBootLists(json);
      input.value = '';
      announce(def.label + '「' + name + '」を追加しました');
    }).catch(function (err) { alertMessage(err.message); input.focus(); });
  }

  function renderTimings() {
    var list = $('timingList');
    list.textContent = '';
    var timings = readStorage(TIMING_KEY) || [];
    timings.forEach(function (t) {
      var at = new Date(t.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      list.appendChild(el('li', { text: at + '　' + t.seconds + ' 秒　入力元: ' + t.source + (t.image ? '（画像あり）' : '') }));
    });
    if (!timings.length) { list.appendChild(el('li', { text: 'まだ記録はありません（共有から開いたときに記録します）' })); }
  }

  function saveConnection(event) {
    event.preventDefault();
    var gasUrl = $('gasUrl').value.trim();
    var token = $('sharedToken').value;
    // 本番は GAS の Web アプリ URL。開発サーバー（scripts/dev_server.js）の localhost も受け付ける
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(gasUrl) &&
        !/^http:\/\/localhost(:\d+)?\/mock-gas$/.test(gasUrl)) {
      alertMessage('GAS の URL は https://script.google.com/macros/s/…/exec の形で入れてください');
      $('gasUrl').focus();
      return;
    }
    if (!token) {
      alertMessage('合言葉を入れてください');
      $('sharedToken').focus();
      return;
    }
    writeStorage(SETTINGS_KEY, { gasUrl: gasUrl, token: token });
    announce('接続を確かめています');
    loadBootstrap().then(function () {
      announce('接続できました。設定を保存しました');
    }).catch(function (err) {
      alertMessage('接続できませんでした: ' + err.message);
    });
  }

  // ---- 起動 ------------------------------------------------------------

  function wireEvents() {
    document.querySelectorAll('[data-nav]').forEach(function (button) {
      button.addEventListener('click', function () {
        clearMessages();
        var target = button.dataset.nav;
        if (target === 'inputView') { resetInput(); }
        showView(target);
        if (target === 'listView' && !state.list.loaded) { runSearch(false); }
      });
    });

    $('pickImageButton').addEventListener('click', function () { $('imageInput').click(); });
    $('imageInput').addEventListener('change', function () {
      var file = $('imageInput').files[0];
      if (!file) { return; }
      announce('画像を読み込んでいます');
      resizeImage(file).then(function (image) {
        clearImage();
        state.image = image;
        $('imagePreviewImg').src = image.previewUrl;
        $('imagePreview').hidden = false;
        announce('画像を選びました: ' + file.name);
      }).catch(function (err) { alertMessage(err.message); });
    });
    $('clearImageButton').addEventListener('click', function () {
      clearImage();
      announce('画像を外しました');
      $('pickImageButton').focus();
    });
    $('analyzeButton').addEventListener('click', runAnalyze);
    $('manualButton').addEventListener('click', startManual);

    // 結果画面: 入力が変わるたびにプレビューを作り直す
    $('postForm').addEventListener('input', function (event) {
      // ①を手で直したら、以後は自動で作り直さない（スレッドなどには影響しないので描き直し不要）
      if (event.target.id === 'fTalk') {
        state.talkEdited = true;
        $('talkEditedNote').hidden = false;
        return;
      }
      if (event.target.id === 'fUseThread') { state.useThreadEdited = true; }
      if ((event.target.id === 'fSource' || event.target.id === 'fUrl') && !state.useThreadEdited) {
        $('fUseThread').checked = L.defaultUseThread(config(), $('fSource').value, $('fUrl').value);
      }
      if (event.target.id === 'fSource' || event.target.id === 'fAuthor') {
        if (!state.prefixEdited) { $('fPrefix').value = autoPrefix(); }
      }
      refreshOutputs();
    });
    $('postForm').addEventListener('change', refreshOutputs);
    $('postForm').addEventListener('submit', function (e) { e.preventDefault(); });
    $('fPrefix').addEventListener('input', function () { state.prefixEdited = true; refreshOutputs(); });
    $('fOriginal').addEventListener('input', refreshOutputs);
    $('fSummaryDraft').addEventListener('input', refreshOutputs);
    $('copyTalkButton').addEventListener('click', copyTalk);
    $('regenTalkButton').addEventListener('click', regenerateTalk);
    $('summarizeButton').addEventListener('click', runSummarize);
    $('revertSummaryButton').addEventListener('click', revertSummary);
    $('saveButton').addEventListener('click', function () { savePost(false); });
    $('deleteButton').addEventListener('click', function () {
      var post = readPost();
      deletePost(post.id, post.title || '（タイトルなし）', function () {
        resetInput();
        showView('inputView');
      });
    });
    $('newButton').addEventListener('click', function () {
      clearMessages();
      resetInput();
      showView('inputView');
    });

    $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); runSearch(false); });
    $('moreButton').addEventListener('click', function () { runSearch(true); });

    $('connectionForm').addEventListener('submit', saveConnection);
    $('showToken').addEventListener('change', function () {
      $('sharedToken').type = $('showToken').checked ? 'text' : 'password';
    });
    $('addCategoryButton').addEventListener('click', function () { addListItem('category'); });
    $('addTagButton').addEventListener('click', function () { addListItem('tag'); });
    $('addAuthorButton').addEventListener('click', function () { addListItem('author'); });
    $('syncPublicSheetButton').addEventListener('click', function () {
      var button = $('syncPublicSheetButton');
      setBusy(button, true, '作り直しています…');
      gasCall({ action: 'syncPublicSheet' }).then(function (json) {
        setBusy(button, false);
        announce('公開用シートを作り直しました（' + json.count + ' 件）');
      }).catch(function (err) {
        setBusy(button, false);
        alertMessage('公開用シートを作り直せませんでした: ' + err.message);
      });
    });
    $('clearTimingButton').addEventListener('click', function () {
      writeStorage(TIMING_KEY, []);
      renderTimings();
      announce('所要時間の記録を消しました');
    });
  }

  function init() {
    wireEvents();
    renderTimings();
    var settings = loadSettings();
    if (settings) {
      $('gasUrl').value = settings.gasUrl;
      $('sharedToken').value = settings.token || '';
    }

    var shared = L.parseSharedParams(location.search);
    if (shared.hasShared) {
      $('inputUrl').value = shared.url;
      $('inputText').value = shared.text;
      $('inputSource').value = L.detectSource(shared.url);
      $('sharedNotice').hidden = false;
      state.sharedStartedAt = 0;
      // 再読み込みで同じ共有を二重に処理しないよう、URL からパラメーターを消す
      history.replaceState(null, '', location.pathname);
    }

    showView(settings ? 'inputView' : 'settingsView', { keepFocus: true });
    if (!settings) {
      alertMessage('最初に、GAS の Web アプリ URL と合言葉を設定してください');
    }

    loadBootstrap().then(function (connected) {
      if (shared.hasShared && connected) {
        $('inputSource').value = L.detectSource(shared.url);
        runAnalyze();
      }
    }).catch(function (err) {
      alertMessage('GAS に接続できませんでした: ' + err.message);
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* 登録できなくても使える */ });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
}());

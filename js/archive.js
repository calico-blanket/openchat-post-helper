// ============================================================
// 記録の一覧ページ（archive.html）
//
//   GAS の読み取り専用の入口（GET ?action=archive）から記録を読み、
//   検索・並べ替え・「開催予定のみ」・行の開閉で表示する。合言葉は使わない。
//   絞り込み・並べ替え・月の区切りは js/logic.js の buildArchiveView（テスト済み）に任せる。
//   外部由来の文字列はすべて textContent で入れ、innerHTML は使わない。
// ============================================================

(function () {
  'use strict';

  var L = window.PostLogic;
  var CONFIG = window.ARCHIVE_CONFIG || {};
  var PAGE_SIZE = 100;
  var COLUMNS = [
    { key: 'saved', label: '登録日', firstDir: 'desc' },
    { key: 'kind', label: '種別', firstDir: 'asc' },
    { key: 'title', label: 'タイトル', firstDir: 'asc' },
    { key: 'event', label: '開催日時', firstDir: 'asc' },
    { key: 'place', label: '場所', sortable: false },
    { key: 'author', label: '発信者／出演者', firstDir: 'asc' }
  ];

  var state = {
    items: [],
    q: '',
    upcoming: false,
    sortKey: 'saved',
    dir: 'desc',
    limit: PAGE_SIZE,
    openKey: null,
    originalOpen: {}
  };

  function $(id) { return document.getElementById(id); }

  /** 要素を作る。attrs の text は textContent、onClick はクリック、それ以外は属性 */
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

  /** http(s) の URL だけを、新しいタブで開くリンクにする */
  function safeLink(url, label) {
    if (!/^https?:\/\/\S+$/i.test(String(url || ''))) { return null; }
    return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: label + '（新しいタブ）' });
  }

  /** GAS の URL。開発サーバー（localhost）では ?gas= で差し替えられる */
  function gasUrl() {
    var params = new URLSearchParams(location.search);
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && params.get('gas')) {
      return params.get('gas');
    }
    return String(CONFIG.gasUrl || '').trim();
  }

  function setStatus(text) { $('archiveStatus').textContent = text; }

  // ---- 見出し（並べ替え） -------------------------------------

  function renderHead() {
    var head = $('listHead');
    head.textContent = '';
    COLUMNS.forEach(function (col) {
      if (col.sortable === false) {
        head.appendChild(el('span', { className: 'head-label', text: col.label }));
        return;
      }
      var active = state.sortKey === col.key;
      var mark = active ? (state.dir === 'asc' ? ' ▲' : ' ▼') : '';
      var order = state.dir === 'asc' ? '昇順' : '降順';
      head.appendChild(el('button', {
        type: 'button',
        className: 'head-button',
        text: col.label + mark,
        'aria-label': col.label + 'で並べ替え' + (active ? '（いまは' + order + '）' : ''),
        onClick: function () {
          if (active) {
            state.dir = state.dir === 'asc' ? 'desc' : 'asc';
          } else {
            state.sortKey = col.key;
            state.dir = col.firstDir;
          }
          state.limit = PAGE_SIZE;
          syncSortSelect();
          render();
        }
      }));
    });
  }

  /** スマホ用の並び順の選択を、今の並び順に合わせる（一致する選択肢が無ければそのまま） */
  function syncSortSelect() {
    var value = state.sortKey + ':' + state.dir;
    var select = $('sortSelect');
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === value) { select.value = value; return; }
    }
  }

  // ---- 一覧 ---------------------------------------------------

  function render() {
    renderHead();
    var view = L.buildArchiveView(state.items, {
      q: state.q,
      upcoming: state.upcoming,
      sortKey: state.sortKey,
      dir: state.dir,
      today: L.todayIsoInTokyo(new Date()),
      limit: state.limit
    });
    var list = $('archiveList');
    list.textContent = '';
    view.rows.forEach(function (row) {
      if (row.type === 'month') {
        list.appendChild(el('li', { className: 'month', text: row.label }));
      } else {
        list.appendChild(renderItem(row));
      }
    });
    $('emptyMessage').hidden = view.total > 0;
    $('moreButton').hidden = !view.hasMore;
    $('moreButton').textContent = 'さらに表示（残り ' + (view.total - view.shown) + ' 件）';
    setStatus(view.total + ' 件' + (view.hasMore ? '（うち ' + view.shown + ' 件を表示）' : ''));
  }

  function renderItem(row) {
    var item = row.item;
    var open = state.openKey === item._key;
    var detailId = 'detail-' + item._key;
    var marker = open ? '▾ ' : '▸ ';
    var subParts = [row.savedLabel, item.kindLabel, row.eventLabel, item.place, item.author].filter(Boolean);

    var button = el('button', {
      type: 'button',
      className: 'row-button',
      'aria-expanded': open ? 'true' : 'false',
      'aria-controls': open ? detailId : null,
      onClick: function () {
        state.openKey = open ? null : item._key;
        render();
        var again = document.querySelector('[data-key="' + item._key + '"] .row-button');
        if (again) { again.focus(); }
      }
    }, [
      // パソコン: 1行に列を並べる
      el('span', { className: 'row-cells' }, [
        el('span', { className: 'date', text: row.savedLabel }),
        el('span', {}, [item.kindLabel ? el('span', { className: 'kind-badge', text: item.kindLabel }) : null]),
        el('span', { className: 'title', text: marker + item.title }),
        el('span', { text: row.eventLabel || '—' }),
        el('span', { text: item.place || '—' }),
        el('span', { text: item.author || '—' })
      ]),
      // スマホ: 2行に詰める
      el('span', { className: 'row-compact' }, [
        el('span', { className: 'title', text: marker + item.title }),
        el('span', { className: 'sub', text: subParts.join('・') })
      ])
    ]);

    var li = el('li', { className: 'item', 'data-key': String(item._key) }, [button]);
    if (open) { li.appendChild(renderDetail(item, detailId)); }
    return li;
  }

  function renderDetail(item, detailId) {
    var meta = [];
    if (item.category) { meta.push('カテゴリ: ' + item.category); }
    if (item.sourceLabel) { meta.push('ソース: ' + item.sourceLabel); }
    if (item.tags && item.tags.length) { meta.push('タグ: ' + item.tags.join('、')); }
    if (item.performers) { meta.push('出演者: ' + item.performers); }
    if (item.deadline) { meta.push('申込締切: ' + (L.formatDateJa(item.deadline) || item.deadline)); }

    var children = [];
    if (meta.length) { children.push(el('p', { className: 'meta', text: meta.join('　') })); }

    var talk = String(item.talk || '');
    var summary = String(item.summary || '');
    if (talk) {
      children.push(el('h3', { text: 'トーク本文' }));
      children.push(el('p', { className: 'text-box', text: talk }));
    }
    // トーク本文に含まれていない概略（スケジュール型など）は別に見せる
    if (summary && talk.indexOf(summary) === -1) {
      children.push(el('h3', { text: '概略' }));
      children.push(el('p', { className: 'text-box', text: summary }));
    }

    var comment = String(item.comment || '');
    if (comment) {
      children.push(el('h3', { text: 'コメント' }));
      children.push(el('p', { className: 'text-box', text: comment }));
    }

    var links = [safeLink(item.url, '元の投稿・記事'), safeLink(item.joinUrl, '参加'), safeLink(item.applyUrl, '申込')].filter(Boolean);
    if (links.length) { children.push(el('div', { className: 'links' }, links)); }

    var original = String(item.original || '');
    if (original) {
      var origOpen = !!state.originalOpen[item._key];
      var originalId = 'original-' + item._key;
      children.push(el('button', {
        type: 'button',
        className: 'original-button',
        'aria-expanded': origOpen ? 'true' : 'false',
        'aria-controls': origOpen ? originalId : null,
        text: (origOpen ? '▾ ' : '▸ ') + '原文を読む（約 ' + original.length.toLocaleString('ja-JP') + ' 字）',
        onClick: function () {
          state.originalOpen[item._key] = !origOpen;
          render();
          var again = document.querySelector('[data-key="' + item._key + '"] .original-button');
          if (again) { again.focus(); }
        }
      }));
      if (origOpen) {
        // スクロールできる長い原文は、キーボードでも動かせるよう名前付きの領域にする
        children.push(el('div', {
          id: originalId, className: 'text-box original-box', role: 'region', tabindex: '0', 'aria-label': '原文', text: original
        }));
      }
    }
    return el('div', { className: 'detail', id: detailId }, children);
  }

  // ---- 公開用シートのタイトルのリンク（?q=タイトル&at=登録日時）から開いたとき ----

  var linked = null;

  /**
   * URL の ?q= を検索欄に入れ、?at=（登録日時）と一致する投稿を開いた状態にする。
   * 一致する投稿が無ければ、検索した状態だけにする。
   */
  function openLinkedItem() {
    var params = new URLSearchParams(location.search);
    var q = params.get('q') || '';
    var at = params.get('at') || '';
    if (!q && !at) { return; }
    if (q) {
      state.q = q;
      $('archiveSearch').value = q;
    }
    var hit = state.items.filter(function (item) {
      return (!at || item.savedAt === at) && (!q || item.title === q);
    })[0];
    if (hit) {
      state.openKey = hit._key;
      linked = hit._key;
    }
  }

  /** 開いた投稿の行を画面に入れ、キーボードの位置もそこに移す */
  function focusLinkedItem() {
    if (linked === null) { return; }
    var button = document.querySelector('[data-key="' + linked + '"] .row-button');
    if (button) {
      button.scrollIntoView({ block: 'start' });
      button.focus();
    }
    linked = null;
  }

  // ---- 読み込み -------------------------------------------------

  function load() {
    var url = gasUrl();
    if (!url) {
      setStatus('このページはまだ設定されていません（archive-config.js の gasUrl）');
      return;
    }
    var endpoint = url + (url.indexOf('?') === -1 ? '?' : '&') + 'action=archive';
    fetch(endpoint).then(function (response) {
      return response.json();
    }).then(function (json) {
      if (!json || json.ok !== true) {
        throw new Error((json && json.error) || '読み込めませんでした');
      }
      state.items = (json.items || []).map(function (item, index) {
        return Object.assign({ _key: index }, item);
      });
      openLinkedItem();
      render();
      focusLinkedItem();
    }).catch(function (err) {
      setStatus('一覧を読み込めませんでした: ' + err.message);
    });
  }

  function wire() {
    var timer = null;
    $('archiveSearch').addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        state.q = $('archiveSearch').value;
        state.limit = PAGE_SIZE;
        render();
      }, 150);
    });
    $('upcomingOnly').addEventListener('change', function () {
      state.upcoming = $('upcomingOnly').checked;
      state.limit = PAGE_SIZE;
      render();
    });
    $('sortSelect').addEventListener('change', function () {
      var parts = $('sortSelect').value.split(':');
      state.sortKey = parts[0];
      state.dir = parts[1];
      state.limit = PAGE_SIZE;
      render();
    });
    $('moreButton').addEventListener('click', function () {
      var firstNew = state.limit;
      state.limit += PAGE_SIZE;
      render();
      // 追加で出た最初の行にフォーカスを移す
      var buttons = document.querySelectorAll('#archiveList .row-button');
      if (buttons[firstNew]) { buttons[firstNew].focus(); }
    });
  }

  function init() {
    if (CONFIG.title) {
      document.title = CONFIG.title;
      $('archiveTitle').textContent = CONFIG.title;
    }
    $('archiveDescription').textContent = CONFIG.description || '';
    renderHead();
    wire();
    load();
  }

  document.addEventListener('DOMContentLoaded', init);
}());

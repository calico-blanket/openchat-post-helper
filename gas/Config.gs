// ============================================================
// フォークする人が書き換える設定（このファイルだけ直せば使い回せるようにする）
//
//   - 初期カテゴリ・議員名一覧・チーム名・投稿文のひな形・各種文字数の上限
//   - 画面（PWA）は起動時に action=bootstrap でこの内容を受け取って使う
//   - 秘密情報（APIキー・合言葉）はここに書かない。スクリプトプロパティに置く
//
//   ひな形の書き方:
//     {author} は「発信者の名前」に置き換わる。
//     名前が空のときは、キー名に "_noAuthor" を付けたひな形が使われる。
// ============================================================

var APP_CONFIG = {
  // チーム名（画面の見出しやプロンプトで使う）
  teamName: 'チームみらい',

  // 初期カテゴリ（初回起動時に1度だけ登録される。以後は画面の設定から増減できる）
  defaultCategories: ['イベント', '活動報告', 'お知らせ', '政策・記事', 'その他'],

  // 発信者の名前の候補（初回起動時に1度だけ登録される。以後は画面の設定から増減できる）
  defaultAuthors: ['運営アカウント'],

  // 議員名一覧（本文・タイトルに文字列として含まれていればタグとして付ける。AIは使わない）
  // 例: ['山田太郎', '佐藤花子']
  legislators: [],

  // 入力元（ソース）の一覧。key は保存時の値、label は画面表示
  sources: [
    { key: 'slack', label: 'Slack' },
    { key: 'x', label: 'X' },
    { key: 'instagram', label: 'Instagram' },
    { key: 'threads', label: 'Threads' },
    { key: 'line', label: 'LINE公式' },
    { key: 'note', label: 'note' },
    { key: 'legislator', label: '議員の活動告知' },
    { key: 'flyer', label: 'チラシ画像' },
    { key: 'other', label: 'その他' }
  ],

  // 種別（LLM・Jev が判定する。key は保存時の値）
  kinds: [
    { key: 'schedule', label: 'スケジュール', description: '日時が決まっているイベント・街頭演説・説明会などの告知' },
    { key: 'article', label: '記事', description: '記事・ブログ・解説・お知らせなど、日時が主題ではない情報' },
    { key: 'legislator', label: '議員活動', description: '議員の議会質問・視察・面会など、議員本人の活動の報告' }
  ],

  // トーク本体の出典行（入力元に応じて自動で付ける）
  sourceLines: {
    slack: 'Slackからの転載です。',
    x: 'Xから、{author}さんの投稿です。',
    x_noAuthor: 'Xの投稿からの転載です。',
    instagram: 'Instagramから、{author}さんの投稿です。',
    instagram_noAuthor: 'Instagramの投稿からの転載です。',
    threads: 'Threadsから、{author}さんの投稿です。',
    threads_noAuthor: 'Threadsの投稿からの転載です。',
    line: 'LINE公式からの転載です。',
    note: 'noteから、{author}さんの記事です。',
    note_noAuthor: 'noteの記事からの転載です。',
    legislator: '{author}議員の活動告知です。',
    legislator_noAuthor: '議員の活動告知です。',
    flyer: 'チラシ画像からの告知です。',
    other: ''
  },

  // トーク本体の定型句
  talk: {
    detailsLine: '詳細はスレッドにて ➡️',
    // スレッドを使わないとき（トーク本体だけで完結させるとき）の結び。{url} は整えた URL。URL が無ければ出さない
    linkLine: '全文はこちら ⬇️\n{url}',
    // 日時行。{relative} は「本日」「明日」（コピーする時点で計算。どちらでもなければ空）
    dateLine: '📅 {relative}{date}{time}',
    placeLine: '📍 {place}',
    joinLine: '📺 参加: {url}',
    performersLine: '🎤 出演: {performers}',
    deadlineLine: '⏰ 申込締切: {deadline}',
    applyLine: '📝 申込: {url}'
  },

  // 「スレッドにも投稿する」の初期値（入力元ごと。画面でその都度切り替えられる。URL が無いときは常に「する」）
  //   ログインなしで読める媒体（note・一般の Web 記事）は、トーク本体＋リンクで完結させる
  //   ログインが必要な媒体（X・Instagram・Threads・Slack・LINE）は、スレッドに全文を載せる
  threadDefaults: {
    slack: true, x: true, instagram: true, threads: true, line: true,
    note: false, legislator: true, flyer: true, other: false
  },

  // スレッドの1通目を「URL だけ」にする入力元（↑で始まる前置きと組み合わせる）
  urlFirstSources: ['x', 'instagram', 'threads'],

  // 開催場所の表記（AI が返す「開催形式」と「地名」から組み立てる。{area} は地名）
  placeLabels: {
    in_person: '対面（{area}）',
    in_person_noArea: '対面',
    online: 'オンライン',
    hybrid: '対面（{area}）＆オンライン',
    hybrid_noArea: '対面＆オンライン'
  },

  // スレッド（詳細）の前置き（入力元に応じて自動で付ける。画面で編集できる）
  threadPrefixes: {
    slack: 'Slackからの転載です。発信者は{author}です。',
    slack_noAuthor: '以下はSlackからの抜粋転載です。',
    x: '↑{author}さんの投稿です。',
    x_noAuthor: '↑Xの投稿です。',
    instagram: '↑{author}さんのInstagramの投稿です。',
    instagram_noAuthor: '↑Instagramの投稿です。',
    threads: '↑{author}さんのThreadsの投稿です。',
    threads_noAuthor: '↑Threadsの投稿です。',
    line: '以下はLINE公式からの転載です。',
    note: '以下は{author}さんのnote記事からの抜粋です。',
    note_noAuthor: '以下はnote記事からの抜粋です。',
    legislator: '以下は{author}議員の活動告知です。',
    legislator_noAuthor: '以下は議員の活動告知です。',
    flyer: '以下はチラシ画像から読み取った内容です。',
    other: '以下は原文です。',
    // 要約ボタンで要約版に切り替えたときの前置き
    summary: '以下は要約です。'
  },

  // メモ欄のコメントをスレッドに添えるときの書式
  commentLine: '💬 {memo}',

  // 文字数の上限など（実機確認の結果で調整する。docs/verification-checklist.md 参照）
  limits: {
    // Gemini に渡す本文の最大文字数（先頭から切る）
    llmInputMaxChars: 6000,
    // 入力元ごとの上書き（note は長文が多いので、記事の後半まで踏まえて要約させる）
    llmInputMaxCharsBySource: { note: 20000 },
    // Jev に渡す本文の最大文字数（Jev は state＋最長の質問で 32k トークンまで）
    jevInputMaxChars: 8000,
    // 要約ボタンで Gemini に渡す最大文字数
    summaryInputMaxChars: 12000,
    // スレッド1通あたりの最大文字数（LINE オープンチャットの上限は実機で確認する）
    threadMessageMaxChars: 1000,
    // スプレッドシートの1セルの上限（Google の仕様: 50,000 文字）
    cellMaxChars: 50000
  }
};

// ============================================================
// 記録の一覧ページ（archive.html）の設定
//
//   gasUrl: GAS の Web アプリ URL（https://script.google.com/macros/s/…/exec）。
//           この URL は秘密ではない（合言葉が必要な操作は、この URL だけではできない）。
//           GAS 側でスクリプトプロパティ ARCHIVE_PUBLIC を "true" にしたときだけ、一覧が表示される。
//   フォークした人は、ここを自分の GAS の URL に書き換える。
// ============================================================

window.ARCHIVE_CONFIG = {
  gasUrl: 'https://script.google.com/macros/s/AKfycbw_mXZp1XTWOJm7RtB5aPF4VO6AIbRD8_5j7veRqdz7jfiyABffcf7e9Fusp9SHcLDh/exec',
  title: '記録の一覧',
  description: 'オープンチャットで紹介した投稿と、記録だけに残した投稿をまとめています。行を押すと、トーク本文と原文を読めます。'
};

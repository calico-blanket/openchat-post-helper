// ============================================================
// 記録の一覧ページ（archive.html）の設定
//
//   gasUrl: GAS の Web アプリ URL（https://script.google.com/macros/s/…/exec）。
//           この URL は秘密ではない（合言葉が必要な操作は、この URL だけではできない）。
//           GAS 側でスクリプトプロパティ ARCHIVE_PUBLIC を "true" にしたときだけ、一覧が表示される。
//   フォークした人は、ここを自分の GAS の URL に書き換える。
// ============================================================

window.ARCHIVE_CONFIG = {
  gasUrl: 'https://script.google.com/macros/s/AKfycbwyHdY0DntW70BBmj3Dm3WWLHQnYaaGAnIcbk04q_2bw5ed5iDTrdyqSDHvY_Cfj90a/exec',
  title: '記録の一覧',
  description: 'オープンチャットで紹介した投稿と、記録だけに残した投稿をまとめています。行を押すと、トーク本文と原文を読めます。'
};

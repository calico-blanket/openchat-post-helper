# GAS の API 仕様

GAS の Web アプリ URL に、**すべて POST** で JSON を送ります（`Content-Type: text/plain;charset=utf-8`。GAS は CORS のプリフライトに応答できないため）。
GET は「公開の一覧」（`?action=archive`）だけを受け付けます。それ以外の API は、合言葉を URL に載せてログに残さないよう、すべて POST です。

### 公開の一覧（GET `?action=archive`、合言葉不要）

- スクリプトプロパティ `ARCHIVE_PUBLIC` が `true`（大文字小文字は問わない）のときだけ `{ ok: true, teamName, items }` を返す。それ以外は `{ ok: false, error }`。
- `items` は新しい順。各項目は `savedAt` `kind` `kindLabel` `sourceLabel` `category` `title` `summary` `tags` `eventIso` `place` `deadline` `performers` `author` `talk` `original` `url` `joinUrl` `applyUrl` だけ（**メモと ID は返さない**）。URL は http(s) のものだけ。
- 読むだけで、シートを書き換えない（見出しが足りない場合に右端へ見出しを足すことだけはある）。

## 共通

- 本文には必ず `action` と `token`（合言葉）を入れます。
- スクリプトプロパティ `SHARED_TOKEN` が**未設定なら、すべての action を拒否**します（素通しにはしません）。
- 失敗時は `{ "ok": false, "error": "日本語のメッセージ" }` を返します。

## action 一覧

| action | 入力 | 返すもの |
|---|---|---|
| `bootstrap` | なし | `config`（Config.gs の APP_CONFIG）、`categories`、`tags`、`authors`（発信者の候補）、`spreadsheetUrl`（保存先スプレッドシートの URL）、`archivePublic`（公開の一覧が有効か）、`usageThisMonth`（今月の使用量の概算 `{ month, count, analyzeCount, summarizeCount, yen }`）、`geminiConfigured`、`jevConfigured`、`model`。API キーは返さない |
| `analyze` | `url?` `text?` `source?` `image?: {mimeType, data(base64)}` | 下記 |
| `summarize` | `text` `length: "half" \| "3lines"` | `summary`、`usage`（今回の使用量の概算） |
| `save` | 下記の投稿データ ＋ `force?` | `id` `savedAt`。同じ URL があれば `{ ok:false, duplicate:{id,title,savedAt} }` |
| `update` | `id` ＋ 投稿データ ＋ `force?` | `id`（登録日時と ID は変えない） |
| `delete` | `id` | `id` |
| `search` | `keyword?` `category?` `kind?` `tags?: []` `offset?` | `items` `hasMore`（新しい順に 50 件ずつ。カテゴリ横断） |
| `addCategory` / `removeCategory` | `name` | `categories` |
| `reorderCategories` | `categories: []` | `categories` |
| `addTag` / `removeTag` | `name` | `tags` |
| `reorderTags` | `tags: []` | `tags` |
| `addAuthor` / `removeAuthor` | `name` | `authors`（発信者の候補。0件も可） |
| `reorderAuthors` | `authors: []` | `authors` |

### analyze の結果

| 項目 | 内容 |
|---|---|
| `source` | 入力元（指定がなければ URL から推定。画像だけなら `flyer`） |
| `resolvedUrl` | 短縮 URL などを解決し、追跡用パラメーターを取り除いた URL（Amazon は `/dp/商品番号` の形） |
| `fetchStatus` | `ok`（取得できた）／`needs_paste`（本文の貼り付けが必要）／`none`（URL なし） |
| `author` | X・note の発信者名 |
| `originalText` | 原文（**加工しない**）。共有された本文と取得した本文のうち長いほう。画像だけなら画像から読み取った文章 |
| `originalFromImage` | 原文が画像からの読み取りか |
| `title` `summary` `kind` | タイトル、概略、種別（`schedule`／`article`／`legislator`） |
| `event` | `{ date, startTime, endTime, place, deadline, performers }`（日付は ISO の絶対日付。曜日は返さない。`place` は「対面（高崎）＆オンライン」のような短い表記で、AI が返す開催形式と地名から `Config.gs` の `placeLabels` で組み立てる） |
| `imageText` `flyerWeekday` | 画像から読み取った文字と、チラシに書かれた曜日（1文字） |
| `kind` `category` `tags` の決め方 | Gemini が毎回判定し、Jev のキーがあれば Jev の判定を優先する（Jev が失敗・判定できなければ Gemini の値）。種別が決まらず開催日があれば `schedule` |
| `category` `tags` | 分類 |
| `legislatorTags` | 議員名一覧との文字列一致（発信者名・タイトル・原文が対象） |
| `duplicate` | 同じ URL の保存済み投稿 |
| `warnings` | 取得の失敗、X の途中切れ、Jev の失敗など |
| `analyzed` | Gemini を呼んだか（本文も画像もなければ呼ばない） |
| `usage` | 今回の使用量の概算 `{ geminiInput, geminiOutput, jevInput, yen }`（Gemini を呼んだときだけ） |

### 投稿データ（save / update）

`kind` `source` `category` `title` `summary` `url` `original` `tags: []` `eventIso` `place` `deadline` `performers` `memo` `author` `talk` `joinUrl` `applyUrl`

- `eventIso`: `2026-10-03`、`2026-10-03T19:00+09:00`、`2026-10-03T19:00+09:00/2026-10-03T21:00+09:00` のいずれか（空も可）
- `deadline`: `YYYY-MM-DD`（空も可）
- `source`: `slack` `x` `instagram` `threads` `line` `note` `legislator` `flyer` `other`（`Config.gs` の `sources`）
- `original`: 画面で「スレッドにも投稿する」を外し、URL がある投稿は空で送る（全文は URL 先にあるため保存しない）
- 重複チェックは、追跡用パラメーターを取り除いた URL どうしで比べる（twitter.com と x.com、threads.net と threads.com も同じとみなす）
- `author`: 発信者。`talk`: 実際にトークに貼る文（手で直した文を含む）
- `joinUrl`（参加 URL）・`applyUrl`（申込 URL）: `http(s)://` で始まる URL（空も可）。analyze では、AI が示した URL のうち原文に実際にあるものだけを `event.joinUrl`・`event.applyUrl` で返す
- `tags`: 登録済みタグか、議員名一覧の名前だけ
- 各値はスプレッドシートの 1 セルの上限（50,000 文字）まで

## スプレッドシート

シート名「投稿一覧」。1 行 1 件。**列は1行目の見出しの名前で読み書きし、列の位置には依存しません。** 新しく作るシートの並びは次のとおりです。

登録日時／種別／発信者／ソース／カテゴリ／タイトル／概略／URL（元の投稿・記事）／スレッド詳細（原文）／タグ／開催日時（ISO）／場所／申込締切／出演者／メモ／ID／トーク本文／参加URL／申込URL

- 列は並べ替えてよく、利用者が足した列はどこにあっても読み書きしません（編集時もアプリの列だけを書き換える）。
- 見出しが見つからない項目は、右端に見出しを足します。同じ見出しが複数あれば左の列を使います。
- 見出しの文字を変えると別の列とみなすため、見出しは変えないでください。

- 使用量は、別のシート「利用量」に1回1行で記録します（日時・操作・モデル・Gemini入力トークン・Gemini出力トークン・Jev入力トークン・概算（円））。トークン数が読めなかった失敗は記録しません。公開の一覧には出ません。
- 空でない値は、先頭にアポストロフィを付けて「文字列」として書き込みます。`=` などで始まる値が数式として動くこと（数式インジェクション）と、日付風の値が自動変換されることを防ぐためです。

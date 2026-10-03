# GAS の API 仕様

GAS の Web アプリ URL に、**すべて POST** で JSON を送ります（`Content-Type: text/plain;charset=utf-8`。GAS は CORS のプリフライトに応答できないため）。
GET は何も返しません（合言葉を URL に載せてログに残さないため）。

## 共通

- 本文には必ず `action` と `token`（合言葉）を入れます。
- スクリプトプロパティ `SHARED_TOKEN` が**未設定なら、すべての action を拒否**します（素通しにはしません）。
- 失敗時は `{ "ok": false, "error": "日本語のメッセージ" }` を返します。

## action 一覧

| action | 入力 | 返すもの |
|---|---|---|
| `bootstrap` | なし | `config`（Config.gs の APP_CONFIG）、`categories`、`tags`、`authors`（投稿者・発信者の候補）、`geminiConfigured`、`jevConfigured`、`model`。API キーは返さない |
| `analyze` | `url?` `text?` `source?` `image?: {mimeType, data(base64)}` | 下記 |
| `summarize` | `text` `length: "half" \| "3lines"` | `summary` |
| `save` | 下記の投稿データ ＋ `force?` | `id` `savedAt`。同じ URL があれば `{ ok:false, duplicate:{id,title,savedAt} }` |
| `update` | `id` ＋ 投稿データ ＋ `force?` | `id`（登録日時と ID は変えない） |
| `delete` | `id` | `id` |
| `search` | `keyword?` `category?` `kind?` `tags?: []` `offset?` | `items` `hasMore`（新しい順に 50 件ずつ。カテゴリ横断） |
| `addCategory` / `removeCategory` | `name` | `categories` |
| `reorderCategories` | `categories: []` | `categories` |
| `addTag` / `removeTag` | `name` | `tags` |
| `reorderTags` | `tags: []` | `tags` |
| `addAuthor` / `removeAuthor` | `name` | `authors`（投稿者・発信者の候補。0件も可） |
| `reorderAuthors` | `authors: []` | `authors` |

### analyze の結果

| 項目 | 内容 |
|---|---|
| `source` | 入力元（指定がなければ URL から推定。画像だけなら `flyer`） |
| `resolvedUrl` | 短縮 URL などを解決した URL |
| `fetchStatus` | `ok`（取得できた）／`needs_paste`（本文の貼り付けが必要）／`none`（URL なし） |
| `author` | X・note の投稿者名 |
| `originalText` | 原文（**加工しない**）。共有された本文と取得した本文のうち長いほう。画像だけなら画像から読み取った文章 |
| `originalFromImage` | 原文が画像からの読み取りか |
| `title` `summary` `kind` | タイトル、概略、種別（`schedule`／`article`／`legislator`） |
| `event` | `{ date, startTime, endTime, place, deadline, performers }`（日付は ISO の絶対日付。曜日は返さない。`place` は「対面（高崎）＆オンライン」のような短い表記で、AI が返す開催形式と地名から `Config.gs` の `placeLabels` で組み立てる） |
| `imageText` `flyerWeekday` | 画像から読み取った文字と、チラシに書かれた曜日（1文字） |
| `kind` `category` `tags` の決め方 | Gemini が毎回判定し、Jev のキーがあれば Jev の判定を優先する（Jev が失敗・判定できなければ Gemini の値）。種別が決まらず開催日があれば `schedule` |
| `category` `tags` | 分類 |
| `legislatorTags` | 議員名一覧との文字列一致（投稿者名・タイトル・原文が対象） |
| `duplicate` | 同じ URL の保存済み投稿 |
| `warnings` | 取得の失敗、X の途中切れ、Jev の失敗など |
| `analyzed` | Gemini を呼んだか（本文も画像もなければ呼ばない） |

### 投稿データ（save / update）

`kind` `source` `category` `title` `summary` `url` `original` `tags: []` `eventIso` `place` `deadline` `performers` `memo`

- `eventIso`: `2026-10-03`、`2026-10-03T19:00+09:00`、`2026-10-03T19:00+09:00/2026-10-03T21:00+09:00` のいずれか（空も可）
- `deadline`: `YYYY-MM-DD`（空も可）
- `tags`: 登録済みタグか、議員名一覧の名前だけ
- 各値はスプレッドシートの 1 セルの上限（50,000 文字）まで

## スプレッドシート

シート名「投稿一覧」。1 行 1 件。列は次のとおりです。列を増やすときは **ID の右側に**追加してください（既存の処理は ID 列までしか読み書きしません）。

登録日時／種別／ソース／カテゴリ／タイトル／概略／URL／スレッド詳細（原文）／タグ／開催日時（ISO）／場所／申込締切／出演者／メモ／ID

- 空でない値は、先頭にアポストロフィを付けて「文字列」として書き込みます。`=` などで始まる値が数式として動くこと（数式インジェクション）と、日付風の値が自動変換されることを防ぐためです。

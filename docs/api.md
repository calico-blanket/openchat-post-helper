# GAS の API 仕様

GAS の Web アプリ URL に、**すべて POST** で JSON を送ります（`Content-Type: text/plain;charset=utf-8`。GAS は CORS のプリフライトに応答できないため）。
GET は「記録の一覧」（`?action=archive`）だけを受け付けます。それ以外の API は、合言葉を URL に載せてログに残さないよう、すべて POST です。

### 記録の一覧（GET `?action=archive`、合言葉不要）

- スクリプトプロパティ `ARCHIVE_PUBLIC` が `true`（大文字小文字は問わない）のときだけ `{ ok: true, teamName, publicSpreadsheetUrl, items }` を返す。それ以外は `{ ok: false, error }`。
- `publicSpreadsheetUrl`: 公開用スプレッドシートの URL（`PUBLIC_SPREADSHEET_ID` が未設定なら空文字）。
- `items` は新しい順。各項目は `savedAt` `postedAt`（発信日。空も可）`kind` `kindLabel` `sourceLabel` `category` `title` `summary` `tags` `eventIso` `place` `deadline` `performers` `author` `talk` `original` `url` `joinUrl` `applyUrl` `comment`（スレッドに添えたコメント）だけ（**ID は返さない**）。URL は http(s) のものだけ。
- 読むだけで、シートを書き換えない（見出しが足りない場合に右端へ見出しを足すことだけはある）。

## 共通

- 本文には必ず `action` と `token`（合言葉）を入れます（例外は `claimInvite` だけ。招待の印で照合します）。合言葉は2種類あります: 管理者の合言葉（`SHARED_TOKEN`）と、招待リンクから名前を登録した入力する人の合言葉（`USERS_JSON` の値と照合。止めた人の合言葉は使えない）。
- 入力する人は、`analyze` `summarize` `save` `search` `bootstrap` と、自分が保存した記録の `update` `delete` だけを呼べます。それ以外の action（設定の変更・`syncPublicSheet`・下の利用者の管理）は「この操作は管理者だけができます」で拒否されます。他の人の記録の `update` `delete` も拒否されます。
- スクリプトプロパティ `SHARED_TOKEN` が**未設定なら、すべての action を拒否**します（素通しにはしません）。
- 失敗時は `{ "ok": false, "error": "日本語のメッセージ" }` を返します。

## action 一覧

| action | 入力 | 返すもの |
|---|---|---|
| `bootstrap` | なし | `config`（Config.gs の APP_CONFIG）、`categories`、`tags`、`authors`（発信者の候補）、`spreadsheetUrl`（保存先スプレッドシートの URL）、`archivePublic`（記録の一覧が有効か）、`usageThisMonth`（今月の使用量の概算 `{ month, count, analyzeCount, summarizeCount, yen }`）、`publicSpreadsheetUrl`（公開用スプレッドシートの URL。未設定なら空）、`geminiConfigured`、`jevConfigured`、`claudeConfigured`（予備の Claude のキーがあるか）、`model`。API キーは返さない |
| `analyze` | `url?` `text?` `source?` `image?: {mimeType, data(base64)}` | 下記 |
| `summarize` | `text` `length: "half" \| "3lines"` | `summary`、`usage`（今回の使用量の概算）、`fallbackModel`（Gemini が使えず Claude に切り替えたときのモデル名。切り替えなければ空） |
| `save` | 下記の投稿データ ＋ `force?` | `id` `savedAt`。同じ URL があれば `{ ok:false, duplicate:{id,title,savedAt} }` |
| `update` | `id` ＋ 投稿データ ＋ `force?` | `id`（登録日時と ID は変えない） |
| `delete` | `id` | `id` |
| `search` | `keyword?` `category?` `kind?` `tags?: []` `tagMode?` `offset?` | `items` `hasMore`（新しい順に 50 件ずつ。カテゴリ横断。`tags` は既定がどれか1つでも持つ（OR）、`tagMode: "and"` ですべて持つもの） |
| `addCategory` / `removeCategory` | `name` | `categories` |
| `reorderCategories` | `categories: []` | `categories` |
| `addTag` / `removeTag` | `name` | `tags` |
| `reorderTags` | `tags: []` | `tags` |
| `addKind` | `label` `description?` `schedule?: boolean` | `kinds`（組み込み＋追加分。`schedule: true` は日時・場所の行を出す型。名前の重複は不可、追加は20個まで） |
| `removeKind` | `key` | `kinds`（組み込みの種別は削除できない） |
| `addAuthor` / `removeAuthor` | `name` | `authors`（発信者の候補。0件も可） |
| `syncPublicSheet` | なし | `count`（公開用スプレッドシートの「記録一覧」タブを作り直した件数）。未設定なら `skipped: true` |
| `reorderAuthors` | `authors: []` | `authors` |
| `listUsers` | なし | `users: [{ id, name, createdAt, disabled }]`（管理者だけ。合言葉・ハッシュは返さない） |
| `createInvite` | なし | `code`（招待の印。**この応答だけ**）`invite` `invites`（管理者だけ。1回だけ・7日間有効。使われていない招待は30件まで） |
| `cancelInvite` | `id` | `invites`（まだ使われていない招待を取り消す。管理者だけ） |
| `claimInvite` | `code` `name`（30文字まで・重複不可・30人まで）。**`token` は不要** | `token`（その人の合言葉）`name`。招待は使用済みになる。名前が正しくないときは招待を残したまま失敗する。使用済み・期限切れ・取り消し済み・知らない印は「この招待リンクは使えません」。`SHARED_TOKEN` 未設定なら拒否 |
| `setUserDisabled` | `id` `disabled: boolean` | `users`（止めた人の記録は残る。管理者だけ） |
| `removeUser` | `id` | `users`（その人が保存した記録は残り、管理者だけが編集・削除できる。管理者だけ） |

### analyze の結果

| 項目 | 内容 |
|---|---|
| `source` | 入力元（指定がなければ URL から推定。画像だけなら `flyer`） |
| `resolvedUrl` | 短縮 URL などを解決し、追跡用パラメーターを取り除いた URL（Amazon は `/dp/商品番号` の形） |
| `postedAt` | 発信日（日本時間の `YYYY-MM-DD`。分からなければ空）。X・Instagram・Threads・Slack は URL の番号から計算し、YouTube は `YOUTUBE_API_KEY` があれば YouTube Data API（`videos.list`、1 単位）で公開日を取る。取得に失敗しても analyze は成功し、YouTube の失敗は `warnings` に出す |
| `fetchStatus` | `ok`（取得できた）／`needs_paste`（本文の貼り付けが必要）／`none`（URL なし） |
| `author` | X・note の発信者名。YouTube は、`YOUTUBE_API_KEY` があればチャンネル名 |
| `originalText` | 原文（**加工しない**）。共有された本文と取得した本文のうち長いほう。画像だけなら画像から読み取った文章。YouTube の説明欄は、AI に渡すだけで、ここには入れない（本文を貼らなければ空） |
| `originalFromImage` | 原文が画像からの読み取りか |
| `title` `summary` `kind` | タイトル、概略、種別（`schedule`／`article`／`legislator`） |
| `event` | `{ date, startTime, endTime, place, deadline, performers }`（日付は ISO の絶対日付。曜日は返さない。`place` は「対面＆オンライン」のような短い表記で、AI が返す開催形式と地名から `Config.gs` の `placeLabels` で組み立てる） |
| `imageText` `flyerWeekday` | 画像から読み取った文字と、チラシに書かれた曜日（1文字） |
| `kind` `category` `tags` の決め方 | Gemini が毎回判定し、Jev のキーがあれば Jev の判定を優先する（Jev が失敗・判定できなければ Gemini の値）。種別が決まらず開催日があれば `schedule` |
| `category` `tags` | 分類 |
| `legislatorTags` | 議員名一覧との文字列一致（発信者名・タイトル・原文が対象） |
| `duplicate` | 同じ URL の保存済み投稿 |
| `warnings` | 取得の失敗、X の途中切れ、Jev の失敗など |
| `analyzed` | Gemini を呼んだか（本文も画像もなければ呼ばない） |
| `usage` | 今回の使用量の概算 `{ geminiInput, geminiOutput, jevInput, yen }`（Gemini を呼んだときだけ） |

### 投稿データ（save / update）

`kind` `source` `category` `title` `summary` `url` `original` `tags: []` `eventIso` `place` `deadline` `performers` `memo` `author` `talk` `joinUrl` `applyUrl` `postedAt`

- `eventIso`: `2026-10-03`、`2026-10-03T19:00+09:00`、`2026-10-03T19:00+09:00/2026-10-03T21:00+09:00` のいずれか（空も可）
- `deadline`: `YYYY-MM-DD`（空も可）
- `postedAt`: 発信日。`YYYY-MM-DD`（空も可。存在しない日付は拒否）。送らなければ空として保存する
- `source`: `slack` `x` `instagram` `threads` `line` `note` `legislator` `flyer` `other`（`Config.gs` の `sources`）
- `original`: 画面で「スレッドにも投稿する」を外し、URL がある投稿は空で送る（全文は URL 先にあるため保存しない）
- 重複チェックは、追跡用パラメーターを取り除いた URL どうしで比べる（twitter.com と x.com、threads.net と threads.com も同じとみなす）
- `author`: 発信者。`talk`: 実際にトークに貼る文（手で直した文を含む）
- `joinUrl`（参加 URL）・`applyUrl`（申込 URL）: `http(s)://` で始まる URL（空も可）。analyze では、AI が示した URL のうち原文に実際にあるものだけを `event.joinUrl`・`event.applyUrl` で返す（原文に `meet.google.com/…` のように `https://` なしで書かれていても拾い、`https://` を補う）
- `url` `joinUrl` `applyUrl` は、`https://` が無いドメインの形（例: `meet.google.com/abc`）なら `https://` を補い、`https://` の直後の空白（`%20` を含む）は取り除いてから検証する（analyze の `url` も同じ）。`javascript:` などはそのまま拒否する
- `tags`: 登録済みタグか、議員名一覧の名前だけ
- 各値はスプレッドシートの 1 セルの上限（50,000 文字）まで

## スプレッドシート

シート名「投稿一覧」。1 行 1 件。**列は1行目の見出しの名前で読み書きし、列の位置には依存しません。** 新しく作るシートの並びは次のとおりです。

登録日時／種別／発信者／ソース／カテゴリ／タイトル／概略／URL（元の投稿・記事）／スレッド詳細（原文）／タグ／開催日時（ISO）／場所／申込締切／出演者／コメント／ID／トーク本文／参加URL／申込URL／発信日

- 「コメント」は、スレッドの最後に添えるコメント（保存時の項目名は `memo`）。以前の見出し「メモ」は、自動で「コメント」に書き換える。
- `save` `update` `delete` の結果には `publicSheet`（公開用スプレッドシートの書き直しの結果 `{ ok, count }`、失敗なら `{ ok: false, error }`、未設定なら `{ ok: true, skipped: true }`）が付く。書き直しに失敗しても保存は成功する。

- 列は並べ替えてよく、利用者が足した列はどこにあっても読み書きしません（編集時もアプリの列だけを書き換える）。
- 見出しが見つからない項目は、右端に見出しを足します。同じ見出しが複数あれば左の列を使います。
- 見出しの文字を変えると別の列とみなすため、見出しは変えないでください。

- 使用量は、別のシート「利用量」に1回1行で記録します（日時・操作・モデル・Gemini入力トークン・Gemini出力トークン・Jev入力トークン・概算（円））。トークン数が読めなかった失敗は記録しません。記録の一覧には出ません。
- 空でない値は、先頭にアポストロフィを付けて「文字列」として書き込みます。`=` などで始まる値が数式として動くこと（数式インジェクション）と、日付風の値が自動変換されることを防ぐためです。

# ChatSite — Raspberry Pi / Node.js

ユーザー名とパスワードでアカウントを作成して使う、Raspberry Pi向けの軽量チャットです。GoogleアカウントやFirebaseの設定は不要です。

## 主な機能

- Node.js / ExpressでWebサイトとAPIを配信。既定ポートは **3010**
- ユーザー登録・ログイン。パスワードはソルト付きハッシュで保存し、平文では保存しません
- メッセージ、アカウント情報、写真をRaspberry Piのローカルディスクに保存
- 写真は保存から3日経過すると自動削除（サーバー起動時と、その後1時間ごとに確認）
- オプションでWeb Push通知に対応（HTTPSとVAPID設定が必要）
- GitHubのmainブランチを60秒ごとに確認し、更新を取得してサーバーを再起動

## いちばん簡単な起動方法

Raspberry PiにNode.js 18以降とGitをインストールして、ターミナルで次を実行します。

```bash
git clone https://github.com/HARUSINN0422/chatsite.git
cd chatsite
npm install
npm start
```

起動したら、ブラウザで `http://ラズパイのIPアドレス:3010` を開きます。自分のアカウントは画面の「新規アカウントを作成」から登録します。ユーザー名は英数字・`_`・`-` の3〜24文字、パスワードは8〜128文字です。

止めるときは起動したターミナルで **Ctrl+C** を押します。ここではOS起動時の自動起動設定は行いません。必要な場合は別途設定してください。

## 保存先

既定ではリポジトリ内の `data/` フォルダーです。環境変数 `DATA_DIR` を指定すると変更できます。

- `data/users.json` — ユーザー名とパスワードハッシュ
- `data/messages.jsonl` — チャットメッセージ
- `data/photos/` — アップロードされた写真
- `data/push-subscriptions.json` — 通知購読情報

このフォルダーには個人情報が含まれます。GitHubへコミットしたり、公開したりしないでください。バックアップを作る場合は `data/` を安全な場所にコピーしてください。写真は3日経過すると削除されるため、必要な写真は期限前に別途保存してください。

## 写真について

- JPEG、PNG、GIF、WebP、AVIFに対応
- 1枚あたり10MBまで
- 写真はRaspberry Piに保存され、保存時刻から3日経過後に削除
- 削除後もチャットのメッセージ自体は残りますが、写真は表示できなくなります

## GitHubからの自動更新

起動中のサーバーはGitHubの `main` を60秒ごとに確認し、更新があれば `git pull --ff-only` と `npm install --omit=dev` を実行します。`npm start` で起動している場合、付属のランナーが更新後にサーバーを再起動します。Pi側で手動編集したファイルがあると更新に失敗することがあります。コード変更は基本的にGitHub側で行ってください。

## プッシュ通知（任意）

通知を使わない場合、この項目は飛ばして構いません。通知にはHTTPSとVAPIDキーが必要です。初回に次を実行します。

```npx web-push generate-vapid-keys```

生成したキーを、起動前に環境変数として設定します。

```bash
export VAPID_PUBLIC_KEY='生成したPublic Key'
export VAPID_PRIVATE_KEY='生成したPrivate Key'
export VAPID_SUBJECT='mailto:管理者のメールアドレス'
npm start
```

キーは秘密情報として扱い、GitHubへ保存しないでください。HTTPSでアクセスしたあと、ログインして「通知を有効化」を押します。iPhone/iPadでは、Web Push対応のiOS/iPadOS 16.4以降でサイトをホーム画面に追加し、そのアイコンから開く必要があります。

## 注意

- アカウントとデータはこのRaspberry Pi内に保存されます。SDカード故障に備えて必要なデータをバックアップしてください。
- インターネットへ公開する場合、HTTPのまま公開せずHTTPSを設定してください。パスワードログインや通知を安全に使うためにもHTTPSを推奨します。
- ユーザー登録はサイトへアクセスできる人なら誰でも行えます。公開範囲を制限したい場合は、別途アクセス制御を設定してください。

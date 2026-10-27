# ChatSite — Raspberry Pi / Node.js

ユーザー名とパスワードでアカウントを作成して使う、Raspberry Pi向けの軽量チャットです。GoogleアカウントやFirebaseの設定は不要です。

## 主な機能

- Node.js / ExpressでWebサイトとAPIを配信。既定ポートは **3010**
- ユーザー登録・ログイン。パスワードはソルト付きハッシュで保存し、平文では保存しません
- メッセージ、アカウント情報、写真をRaspberry Piのローカルディスクに保存
- 写真は保存から3日経過すると自動削除（サーバー起動時と、その後1時間ごとに確認）
- Web Push通知に対応（OneSignal、または従来のVAPID方式）
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

## プッシュ通知（OneSignal推奨・VAPIDフォールバック）

ChatSiteはOneSignal Web Pushと、従来のVAPID Web Pushに対応します。OneSignalの設定が完了している場合はOneSignalを使用し、設定がない場合は従来のVAPID方式を使用します。

### OneSignalの設定

1. [OneSignal](https://onesignal.com/) にログインし、Web用のアプリを作成します。
2. Web PushのサイトURLとして `https://harusinn.com` を設定します（別ドメインを使う場合は実際のドメインを指定）。
3. OneSignalの **App ID** と **REST API Key** を取得します。REST API Keyはサーバー専用の秘密情報です。
4. Raspberry Piの `chatsite/.env` に次の3行を追加し、ChatSiteを再起動します。

```dotenv
ONESIGNAL_APP_ID=OneSignalのApp ID
ONESIGNAL_REST_API_KEY=OneSignalのREST API Key
APP_PUBLIC_URL=https://harusinn.com/chatsite/
```

付属の `npm start` ランナーは `.env` を読み込みます。シェルですでに同じ環境変数が設定されている場合は、シェル側の値が優先されます。REST API Keyはブラウザへ送信されず、GitHubにも保存しないでください。 `.env` はGitHubへコミットしないでください。

OneSignal用Service Workerは `/chatsite/onesignal/OneSignalSDKWorker.js` に配置しています。既存の `sw.js` とは別のスコープを使い、両者の競合を避けます。通知先はChatSiteのユーザーIDで識別し、メッセージ送信者本人には送信しません。

### 従来のVAPID方式を使う場合

OneSignalの設定がない場合は、従来どおりHTTPSとVAPIDキーが必要です。初回に次を実行します。

```bash
npx web-push generate-vapid-keys
export VAPID_PUBLIC_KEY='生成したPublic Key'
export VAPID_PRIVATE_KEY='生成したPrivate Key'
export VAPID_SUBJECT='mailto:管理者のメールアドレス'
npm start
```

VAPIDキーも秘密情報として扱い、GitHubへ保存しないでください。

### iPhone・iPadで通知を有効にする

HTTPSでサイトを開き、Safariの共有メニューからホーム画面に追加します。ホーム画面のChatSiteアイコンから開いてログインし、「通知を有効化」を押して許可してください。iOS/iPadOS 16.4以降が必要です。OneSignalへ切り替えた後は、各端末で一度通知を有効化してOneSignalに購読を登録してください。

## 注意

- アカウントとデータはこのRaspberry Pi内に保存されます。SDカード故障に備えて必要なデータをバックアップしてください。
- インターネットへ公開する場合、HTTPのまま公開せずHTTPSを設定してください。パスワードログインや通知を安全に使うためにもHTTPSを推奨します。
- ユーザー登録はサイトへアクセスできる人なら誰でも行えます。公開範囲を制限したい場合は、別途アクセス制御を設定してください。

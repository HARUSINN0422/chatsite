# ChatSite (Raspberry Pi + Node.js)

Googleアカウントでログインする全体チャットです。**Webサイトの配信とテキストメッセージの保存はRaspberry Pi上のNode.jsサーバーが担当**します。写真はGoogle Driveに保存し、メッセージには写真URLを保存します。

## 構成

- `server.js`: Node.js/ExpressのWebサーバー、API、Firebase IDトークン検証
- `data/messages.jsonl`: チャット本文の保存先（実行時に自動作成。Gitには含めません）
- `index.html`: チャット画面
- Firebase Authentication: Googleアカウントでのログインのみ。本文保存には使いません
- Google Drive: 写真本体の保存先

## Raspberry Piで起動する

Node.js 18以降をインストールし、リポジトリをPiにcloneしてください。

```bash
git clone https://github.com/HARUSINN0422/chatsite.git
cd chatsite
npm install
```

### 1. Firebaseログインを設定

1. [Firebase Console](https://console.firebase.google.com/)でプロジェクトを作成します。
2. Authentication → Sign-in method で Google を有効化します。
3. Authenticationの設定で、実際にアクセスするドメインを承認済みドメインに追加します。
4. プロジェクト設定からWebアプリの設定を取得し、`index.html` の `FIREBASE_CONFIG` の `YOUR_...` を置き換えます。
5. Firebaseプロジェクト設定からサービスアカウントの秘密鍵JSONを発行し、**リポジトリ外のPi上の安全な場所**に保存します。例：`/etc/chatsite/firebase-service-account.json`。このJSONをGitHubにコミットしないでください。

```bash
sudo mkdir -p /etc/chatsite
sudo chown "$USER":"$USER" /etc/chatsite
# サービスアカウントJSONを安全な方法で /etc/chatsite/firebase-service-account.json に配置
chmod 600 /etc/chatsite/firebase-service-account.json
```

### 2. Google Drive写真アップロード（任意）

1. [Google Cloud Console](https://console.cloud.google.com/)でGoogle Drive APIを有効化します。
2. OAuth同意画面を設定し、Webアプリ用OAuthクライアントIDを作成します。
3. Authorized JavaScript originsに、Piのサイトのoriginを登録します。例：`https://chat.example.com`（パスや末尾のスラッシュは含めません）。
4. `index.html` の `GOOGLE_DRIVE_CLIENT_ID` をOAuthクライアントIDに置き換えます。

写真は「リンクを知っている全員が閲覧可能」に設定されます。URLを知る人が写真を閲覧できるため、非公開の画像を送らないでください。写真機能を使わない場合は未設定でもテキストチャットを利用できます。

### 3. サーバーを起動

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/etc/chatsite/firebase-service-account.json
export DATA_DIR=/var/lib/chatsite
npm start
```

`DATA_DIR` はメッセージファイルの保存先です。永続保存のため、PiのSDカードや外付けSSD上の適切なディレクトリを指定してください。デフォルトはリポジトリ内の `data/` です。

ブラウザで `http://ラズパイのIPアドレス:3000` を開きます。同じWi-Fi内からのアクセスは通常これで可能です。インターネット越しに公開するには、HTTPSとドメイン、ルーター設定またはトンネルサービスなどの追加設定が必要です。Node.jsのポート3000をそのままインターネットへ直接公開する運用は推奨しません。

### 4. 再起動後も自動起動（systemd）

`/etc/systemd/system/chatsite.service` を作成します。ユーザー名と配置先は実際の環境に合わせてください。

```ini
[Unit]
Description=ChatSite Node.js server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/chatsite
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DATA_DIR=/var/lib/chatsite
Environment=GOOGLE_APPLICATION_CREDENTIALS=/etc/chatsite/firebase-service-account.json
ExecStart=/usr/bin/node /home/pi/chatsite/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/var/lib/chatsite

[Install]
WantedBy=multi-user.target
```

保存ディレクトリをサービスユーザーに許可してから有効化します。

```bash
sudo mkdir -p /var/lib/chatsite
sudo chown pi:pi /var/lib/chatsite
sudo systemctl daemon-reload
sudo systemctl enable --now chatsite
sudo systemctl status chatsite
```

## メッセージ保存とバックアップ

- 本文、送信者ID、表示名、日時、写真URLをPiの `DATA_DIR/messages.jsonl` に追記します。
- 最新200件を画面に表示し、画面は3秒ごとにサーバーを確認します。
- `data/` はGit管理対象外です。Piの故障やSDカード破損に備え、`messages.jsonl` を別のストレージに定期バックアップしてください。
- 本構成は小規模な個人チャット向けです。多数の同時投稿や大規模運用ではSQLite/PostgreSQLなどのDBを検討してください。

## 更新

GitHub上のソースをPiで更新する場合：

```bash
cd /home/pi/chatsite
git pull
npm install
sudo systemctl restart chatsite
```

この構成ではGitHub Pagesを配信元として使いません。GitHubはソースコード管理用で、実際のサイトはPiから配信します。

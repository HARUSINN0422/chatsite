# ChatSite — Raspberry Pi / Node.js

Googleアカウントでログインする全体チャット。サイト配信・テキスト保存はRaspberry Pi、写真本体はGoogle Driveです。

## 主な構成

- Node.js/ExpressでWebサイトとAPIを配信。既定ポートは **3010**
- テキストと写真URLを DATA_DIR/messages.jsonl に追記保存
- Firebase AuthenticationはGoogleログインとIDトークン検証だけに使用
- Web Pushで新着通知。通知購読は DATA_DIR/push-subscriptions.json に保存
- systemd timerでGitHubのmainを毎分確認し、更新があればPi上のコードを更新してサービスを再起動

## Raspberry Piへの初回導入

Node.js 18以降とGitをインストールしてから：

```bash
git clone https://github.com/HARUSINN0422/chatsite.git
cd chatsite
npm install
```

### 1. Googleログイン設定

Firebase Consoleでプロジェクトを作り、Authentication → Sign-in methodでGoogleを有効化します。Webアプリ設定の値を index.html 内の FIREBASE_CONFIG に入れます。アクセスするホスト名（ドメインまたはIP）をFirebase Authenticationの承認済みドメインに登録してください。Firebase AuthenticationのWebログインではHTTPSが必要です（localhostを除く）。

Firebaseサービスアカウントの秘密鍵JSONはPi上のみに置き、GitHubへ絶対にコミットしないでください。例：

```bash
sudo mkdir -p /etc/chatsite
sudo chown "$USER":"$USER" /etc/chatsite
# 安全な方法でJSONを /etc/chatsite/firebase-service-account.json に配置
chmod 600 /etc/chatsite/firebase-service-account.json
```

### 2. Safariなどを閉じていても通知を受け取る設定

Web Pushはブラウザの通知許可とHTTPSが必要です。VAPIDキーをPi上で生成します：

```bash
npx web-push generate-vapid-keys
```

表示されたPublic KeyとPrivate Keyは同じペアを使います。Public KeyはサーバーAPIから配布します。以下の環境変数を設定します：

- VAPID_PUBLIC_KEY：生成したPublic Key
- VAPID_PRIVATE_KEY：生成したPrivate Key（秘密。GitHubへ保存しない）
- VAPID_SUBJECT：例 mailto:管理者のメールアドレス

VAPIDキーは一度生成したら同じものを使い続けてください。変更すると既存の通知購読を作り直す必要があります。HTTPSでサイトにアクセスしてGoogleログイン後、「通知を有効化」を押し、ブラウザの通知許可を認めます。購読情報はPiに保存され、他のユーザーが投稿すると本文を含めず「新しいメッセージが届きました」という通知を送ります。

**Safariについて**
- macOSのSafariでは通知を許可し、サイトの通知をシステム設定でも許可してください。
- iPhone/iPadのSafariでは、Web Push対応OS（iOS/iPadOS 16.4以降）でサイトをホーム画面に追加し、そのホーム画面アイコンから開いて通知を有効化する必要があります。通常のSafariタブを閉じた場合の動作はOS・インストール状態・通知設定に依存します。
- OSの集中モード、バッテリー設定、ネット接続、通知許可の状態によっては届かない場合があります。端末が完全に電源OFF・オフラインの間は即時配信できません。
- HTTPSが必要です。家庭内のIPアドレスへHTTPで開くだけではプッシュ通知が使えない場合があります。外部公開する場合はHTTPS付きドメインや安全なトンネルを設定してください。

### 3. 3010ポートで起動

```bash
export PORT=3010
export GOOGLE_APPLICATION_CREDENTIALS=/etc/chatsite/firebase-service-account.json
export DATA_DIR=/var/lib/chatsite
export VAPID_PUBLIC_KEY='生成したPublic Key'
export VAPID_PRIVATE_KEY='生成したPrivate Key'
export VAPID_SUBJECT='mailto:管理者のメールアドレス'
npm start
```

ブラウザで http://ラズパイのIPアドレス:3010 を開きます。同じWi-Fi内の確認には使えますが、Googleログインとプッシュ通知を利用する本番公開ではHTTPSを設定してください。ポート3010をインターネットへ直接公開するより、HTTPSリバースプロキシまたは安全なトンネルを推奨します。

## systemdで常時起動

/ etc / systemd / system / chatsite.service を作成し、実際のLinuxユーザー名とリポジトリの配置先を合わせます：

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
Environment=PORT=3010
Environment=DATA_DIR=/var/lib/chatsite
Environment=GOOGLE_APPLICATION_CREDENTIALS=/etc/chatsite/firebase-service-account.json
Environment=VAPID_PUBLIC_KEY=ここにPublicKey
Environment=VAPID_PRIVATE_KEY=ここにPrivateKey
Environment=VAPID_SUBJECT=mailto:管理者のメールアドレス
ExecStart=/usr/bin/node /home/pi/chatsite/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/var/lib/chatsite

[Install]
WantedBy=multi-user.target
```

VAPID Private Keyは秘密情報です。設定ファイルの権限を制限します：

```bash
sudo chmod 600 /etc/systemd/system/chatsite.service
sudo mkdir -p /var/lib/chatsite
sudo chown pi:pi /var/lib/chatsite
sudo systemctl daemon-reload
sudo systemctl enable --now chatsite
sudo systemctl status chatsite
```

## GitHub更新をPiに自動反映

リポジトリには scripts/update.sh、chatsite-update.service、chatsite-update.timer を用意しています。Pi側でGitHubのmainブランチを毎分確認し、更新があると fast-forward更新、npm install、Node.jsサービス再起動を行う方式です。GitHubにpushした直後に反映されるとは限らず、通常は次の確認まで最大約1分＋インストール時間かかります。Piがインターネットに接続され、timerが有効である必要があります。

```bash
sudo cp chatsite-update.service /etc/systemd/system/
sudo cp chatsite-update.timer /etc/systemd/system/
sudo chmod +x /home/pi/chatsite/scripts/update.sh
sudo systemctl daemon-reload
sudo systemctl enable --now chatsite-update.timer
systemctl list-timers chatsite-update.timer
```

サービスファイルとスクリプトの既定パスは /home/pi/chatsite です。別の場所にcloneした場合は両方を変更してください。更新スクリプトはroot権限で実行するため、GitHubから取得するコードは自分が管理するリポジトリのものに限定し、変更内容を確認してください。自動更新はPi上のソースコードのみを更新します。/var/lib/chatsite のメッセージや通知購読データはGit管理外なので更新で上書きしません。

## バックアップ

/var/lib/chatsite/messages.jsonl と /var/lib/chatsite/push-subscriptions.json を定期バックアップしてください。SDカード故障に備え、別ドライブにも保存することを推奨します。小規模な個人利用向けの構成です。

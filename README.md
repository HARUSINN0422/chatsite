# ChatSite

Googleアカウント認証を使った軽量な全体チャット。テキストと写真を送信でき、メッセージはCloud Firestore、写真はGoogle Driveに保存する構成です。GitHub Pagesで配信できる静的PWAです。

## 1. GitHub Pagesを有効化

GitHubの `HARUSINN0422/chatsite` → **Settings → Pages** で、Build and deployment を **Deploy from a branch**、Branch を **main / (root)** に設定して保存します。公開URLは通常 `https://harusinn0422.github.io/chatsite/` です。

## 2. Firebase設定

1. [Firebase Console](https://console.firebase.google.com/)でプロジェクトを作成します。
2. Authentication → Sign-in method で **Google** を有効にします。
3. Authentication → Settings → Authorized domains に `harusinn0422.github.io` を追加します。
4. Firestore Databaseを作成します。
5. プロジェクト設定 → アプリを追加 → Webアプリから設定値を取得します。
6. `index.html` 内の `FIREBASE_CONFIG` の `YOUR_...` を実際の設定値に置き換えます。Firebase Web設定値は秘密鍵ではありませんが、Firestoreのセキュリティルールを必ず設定してください。

推奨Firestoreルール（ログインユーザー全員が全体チャットを読み書きできる公開チャット用の最小例）:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /messages/{messageId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.text is string
        && request.resource.data.text.size() <= 4000
        && request.resource.data.imageUrl is string;
      allow update, delete: if false;
    }
  }
}
```

Firebaseの設定だけでは不十分です。Googleログインを有効化し、Firestoreを作成して上記ルールを適用してください。

## 3. Google Drive写真アップロード設定

1. [Google Cloud Console](https://console.cloud.google.com/)でFirebaseと同じGoogle Cloudプロジェクトを選択します。
2. **Google Drive API**を有効にします。
3. Google Auth Platform / OAuth consent screenを設定し、必要な場合はテストユーザーを追加します。
4. Credentials → Create Credentials → **OAuth client ID** → **Web application**を作成します。
5. Authorized JavaScript origins に `https://harusinn0422.github.io` を追加します（パス `/chatsite/` は含めません）。
6. `index.html` の `GOOGLE_DRIVE_CLIENT_ID` をOAuthクライアントIDに置き換えます。
7. 初めて写真を送る際にGoogle Driveへのアクセスを許可します。

写真送信時、Drive APIでアップロードし、リンクを知っている全員が閲覧できる権限を付与します。**そのリンクを知る人は写真を見られるため、個人情報や非公開の写真は送信しないでください。** Google Workspace管理者設定によっては一般公開の共有が禁止され、共有設定に失敗することがあります。

## 4. 自動更新とオフラインキャッシュ

Service Workerがサイトのファイルをキャッシュします。オンライン時はGitHub Pagesから最新ファイルを確認し、ネット接続がない場合はキャッシュ済みのページを表示します。Service Workerの更新はブラウザが検出して適用します。ブラウザの仕様上、更新が全端末に即時反映される保証はなく、開いているページでは再読み込みが必要な場合があります。初回読み込みにはインターネット接続が必要です。

GitHub Pagesへの反映には数分かかることがあります。古い版が表示される場合は一度再読み込みしてください。

## 制限事項

- チャットは「全体チャット」1部屋です。メッセージは最新200件を表示します。
- GitHub Pagesはアプリ配信用です。メッセージや写真そのものをGitHubリポジトリには保存しません。
- 写真ファイル本体はGoogle Drive、メッセージはFirestoreに保存するため、配布ファイルを軽量に保てます。
- OAuth同意画面が未公開の場合、登録済みテストユーザーだけが写真アップロードを使える場合があります。
- 本番運用では不正利用対策、Firestore App Check、レート制限、プライバシー表示も検討してください。

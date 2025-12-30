# デプロイ手順 - オンライン公開ガイド

このゲームをURLで他の人と共有できるようにするためのデプロイ手順です。

## 📋 概要

以下の無料ホスティングサービスを使用して、このゲームをオンラインで公開できます：

- **Render** (推奨) - WebSocket完全対応、無料プラン有り
- **Railway** - 簡単デプロイ、WebSocket対応
- **Vercel** - 高速だがWebSocket制限有り

## 🚀 方法1: Render でデプロイ（最も推奨）

### ステップ1: Renderアカウント作成
1. https://render.com にアクセス
2. "Get Started for Free" をクリック
3. GitHubアカウントで登録

### ステップ2: デプロイ
1. Renderダッシュボードで "New +" ボタンをクリック
2. "Web Service" を選択
3. "Connect a repository" で、このGitHubリポジトリを選択
4. 以下の設定を確認：
   - **Name**: `game2-battle-card`（または任意の名前）
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: `Free`
5. "Create Web Service" をクリック

### ステップ3: デプロイ完了
- 5-10分でデプロイが完了します
- 公開URLが発行されます：`https://your-app-name.onrender.com`
- このURLを友達と共有してゲームをプレイ！

### 注意事項
- 無料プランは15分間アクティビティがないとスリープします
- 初回アクセス時は起動に30秒程度かかる場合があります

## 🚄 方法2: Railway でデプロイ

### ステップ1: Railwayアカウント作成
1. https://railway.app にアクセス
2. "Start a New Project" をクリック
3. GitHubアカウントで登録

### ステップ2: デプロイ
1. "New Project" をクリック
2. "Deploy from GitHub repo" を選択
3. このリポジトリを選択
4. 自動的に設定が読み込まれ、デプロイが開始されます

### ステップ3: URLを取得
1. プロジェクト設定で "Settings" → "Networking" を開く
2. "Generate Domain" をクリック
3. 公開URLが発行されます：`https://your-app.up.railway.app`

## ⚡ 方法3: Vercel でデプロイ

### 制限事項
⚠️ **重要**: VercelはWebSocketのサポートが限定的なため、リアルタイムマルチプレイヤー機能が正常に動作しない可能性があります。

### ステップ
1. https://vercel.com にアクセス
2. "Add New Project" をクリック
3. GitHubリポジトリをインポート
4. 自動的にデプロイされます

## 🔧 環境変数の設定（オプション）

必要に応じて、以下の環境変数を設定できます：

- `PORT`: サーバーポート（デフォルト: 3000）
- `NODE_ENV`: `production` に設定することを推奨

## 🎮 デプロイ後の使い方

1. デプロイが完了したら、発行された公開URLにアクセス
2. 友達にURLを共有
3. 複数のブラウザ/デバイスで開いてマルチプレイヤーバトル！

### 例
```
あなた: https://game2-battle-card.onrender.com を開く
友達: 同じURLを開く

両方が技を3つ生成して「オンラインバトル開始」を押すと、
自動的にマッチングされてバトル開始！
```

## 📝 トラブルシューティング

### デプロイは成功したが、マルチプレイヤーが動作しない
- WebSocketが正しく動作しているか確認
- RenderまたはRailwayを使用してください（Vercelは避ける）

### アプリが起動しない
- ビルドログを確認
- `npm install` が正常に完了しているか確認
- Node.jsバージョンが対応しているか確認

### 無料プランの制限
- **Render**: 750時間/月の無料利用、15分間の非アクティブでスリープ
- **Railway**: 月$5の無料クレジット
- **Vercel**: WebSocket制限有り

## 🌟 推奨設定

最高のパフォーマンスとユーザー体験のために：

1. **Render** を使用（WebSocket完全対応）
2. カスタムドメインを設定（オプション）
3. 環境変数で `NODE_ENV=production` を設定

## 📞 サポート

デプロイで問題が発生した場合は、各プラットフォームのドキュメントを参照してください：

- Render: https://render.com/docs
- Railway: https://docs.railway.app
- Vercel: https://vercel.com/docs

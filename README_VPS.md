# ポケミミ VPS + Playwright (パターンB) デプロイ・運用手順書

Cloudflare 防衛（HTTP 403）を Playwright (Headless Chromium) で回避し、大会情報・Discord通知・プレイヤーランキング・大会結果を自動取得・DB更新するための手順書です。

---

## 1. VPS の事前準備 (初回のみ)

### ① Node.js (v20以上) と PM2 のインストール
Ubuntu / Debian VPS の場合：
```bash
# NodeSource から Node.js 20.x をセットアップ
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# PM2 (常駐・定期実行管理ツール) をグローバルインストール
sudo npm install -g pm2
```

### ② Playwright 依存ライブラリのインストール
Headless Chromium の動的に必要なライブラリをセットアップします：
```bash
sudo npx playwright install-deps
```

---

## 2. プロジェクトの配置 & 初期設定

### ① ファイルの配置
VPS 上の任意のディレクトリ（例: `/home/ubuntu/tcg-runner`）に `データベース/tcg-runner` フォルダ配下の全ファイルを転送・配置します。

```bash
cd /home/ubuntu/tcg-runner
```

### ② パッケージと Chromium のインストール
```bash
npm install
npx playwright install chromium
```

### ③ 環境変数 `.env` の設定
`.env.example` をコピーして `.env` を作成し、DB接続情報および Discord Webhook URL を設定します。

```bash
cp .env.example .env
nano .env  # または vim
```

**.env 設定項目の確認:**
```ini
DB_HOST=mysql_server_host  # 例: tcg-shop.jp の DB ホスト
DB_PORT=3306
DB_USER=your_db_username
DB_PASSWORD=your_db_password
DB_NAME=your_db_name

DISCORD_CITY_WEBHOOK=https://discord.com/api/webhooks/...
DISCORD_OTHER_WEBHOOK=https://discord.com/api/webhooks/...

PM_NOTIFY_DRYRUN=false
RESUME_SILENT_AFTER_SECONDS=7200
HEADLESS=true
```

---

## 3. 手動テスト・動作検証 (ドライラン)

稼働中の Discord チャンネルへ誤送信しないよう、まずはドライランモードで動作確認します。

### ① 大会情報 & Discord通知のドライラン
```bash
npm run info:dryrun
```
- **ログ確認**: `logs/tcg_runner.log` に Cloudflare チャレンジ通過ログおよび「Fetched X active events」「Discord Payload」が出力されれば正常です。

### ② プレイヤーランキングの動作確認
```bash
npm run rank
```

### ③ 大会結果・デッキレシピの動作確認
```bash
npm run result
```

---

## 4. PM2 による本番自動運用（Cron起動）

テストが正常完了したら、PM2 を使ってバックグラウンド自動実行を開始します。

### ① 旧サーバー（tcg-shop.jp）の cron 停止
二重取得やデータ競合を防ぐため、ロリポップ等旧サーバー側のアカウントで動いていた 3つの cron (`tournament_info.php`, `player_rank_import.php`, `tournament_result_import.php`) を停止してください。

### ② PM2 タスクの起動
```bash
pm2 start ecosystem.config.js
```

### ③ 定期タスクの確認
```bash
pm2 status
```
以下のように3つのタスクが登録され、決められたスケジュールで自動実行されます：
- `tcg-info-3min`: 3分ごとに実行（大会情報 & Discord通知）
- `tcg-rank-hourly`: 毎時0分に実行（プレイヤーランキング更新）
- `tcg-result-hourly`: 毎時10分に実行（大会結果・デッキレシピ更新）

### ④ PM2 のサーバー再起動自動復旧設定
VPS 自体が再起動した際も自動復帰するように登録します：
```bash
pm2 save
pm2 startup
# 表示されたコマンドをコピーして実行
```

---

## 5. ログの確認とトラブルシューティング

### リアルタイムログの監視
```bash
pm2 logs
# またはプロジェクト内のログファイル
tail -f logs/tcg_runner.log
```

### ログローテーション
`logs/tcg_runner.log` は 20MB に達すると自動的に `tcg_runner.log.1` へローテーションされます。容量圧迫の心配はありません。

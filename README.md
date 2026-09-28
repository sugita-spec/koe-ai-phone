# Koe — 自分の声で受付・架電するAI電話

OpenAI Realtime API（SIP）とTwilioを使う、電話受付・架電MVPです。APIキーなしでもデモモードで管理画面、受付設定、音声登録、架電フローを試せます。ローカルNode.js版と、Cloudflare Workers + D1 + Durable Objects版の両方を収録しています。

## できること

- 着信をAIが受け、氏名・折り返し先・用件・緊急度を聞き取る
- 自分の声の「同意音声」と「サンプル音声」をブラウザで録音し、カスタム音声を作る
- 電話番号・相手名・目的・台本を指定してAIから架電する
- CSVの電話リストを読み込み、平日10〜19時に順番に営業架電する
- 不在・話中・留守電の自動再架電、留守電判定、A/B台本比較を行う
- 架電停止（DNC）を全リスト共通で管理し、通話中の停止希望も自動反映する
- 通話結果、折り返し日時、アポイント、営業KPIを管理する
- 営業サービスと台本を画面から追加・編集し、後からサービスを増やす
- 通話の文字起こし、要約、伝言、通話時間を保存・一覧表示する
- 通話履歴を検索・詳細表示・CSV出力し、通知メールの再送やフォローSMSを行う
- CRM・カレンダーへWebhookで通話結果や予約情報を送る
- 社内メンバーごとに閲覧・架電担当・管理者の専用トークンを発行する
- 保存期間を30〜365日で設定し、期限を過ぎた通話データを自動削除する
- 営業時間、挨拶、FAQ、有人転送先、標準ボイスを管理画面で変更する
- OpenAI/TwilioのWebhook署名を検証する

## まずデモを起動

Node.js 22以上が必要です。

```bash
cp .env.example .env
pnpm install
pnpm dev
```

[http://127.0.0.1:8787](http://127.0.0.1:8787) を開いてください。`.env.example` は `DEMO_MODE=true` なので、外部APIへの送信や実際の発信は行いません。

## Cloudflare Workersで動かす

Cloudflare版では、画面をWorkers Static Assets、設定と通話履歴をD1、通話中のOpenAI Realtime WebSocketを通話ごとのDurable Objectで処理します。

### ローカル確認

```bash
cp .dev.vars.example .dev.vars
pnpm install
pnpm d1:migrate:local
pnpm dev:cloudflare
```

[http://127.0.0.1:8787](http://127.0.0.1:8787) を開きます。`wrangler.jsonc` の初期値は `DEMO_MODE=true` です。

### Cloudflareへ初回デプロイ

```bash
pnpm exec wrangler login
pnpm exec wrangler d1 create koe-ai-phone
```

表示されたD1の `database_id` を `wrangler.jsonc` の仮IDと置き換え、次を実行します。

```bash
pnpm d1:migrate:remote
pnpm deploy
```

公開後に表示された `https://koe-ai-phone.<subdomain>.workers.dev` を `PUBLIC_BASE_URL` として使います。初回はデモモードのため、電話料金は発生しません。

### 実通話を有効にする

`wrangler.jsonc` の `DEMO_MODE` を `false` にし、秘密情報をCloudflareへ登録します。値はソースコードや設定ファイルへ書かないでください。

```bash
pnpm exec wrangler secret put OPENAI_API_KEY
pnpm exec wrangler secret put OPENAI_WEBHOOK_SECRET
pnpm exec wrangler secret put TWILIO_AUTH_TOKEN
pnpm exec wrangler secret put TWILIO_PHONE_NUMBER
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm deploy
```

SMS追客に別の送信元番号を使う場合は `TWILIO_SMS_NUMBER`、CRM・カレンダーWebhookへ共通Bearerトークンを付ける場合は `INTEGRATION_WEBHOOK_TOKEN` を追加で登録できます。CRM・カレンダーの送信先URLとSMSの有効化は管理画面の「受付設定 → 外部サービス連携」で設定します。

`OPENAI_PROJECT_ID`、`TWILIO_ACCOUNT_SID`、`PUBLIC_BASE_URL` は秘密ではないため、`wrangler.jsonc` の `vars` で管理します。

本番モードでは管理APIが `ADMIN_TOKEN` で保護されます。管理画面を開くとトークン入力が一度だけ求められ、ブラウザのセッション中だけ保持されます。WebhookはOpenAI/Twilioそれぞれの署名で検証します。

## 電話サービスの本番接続

### 1. 環境変数（Node.js版）

`.env` を作り、次を設定します。

```dotenv
PORT=8787
PUBLIC_BASE_URL=https://phone.example.com
DEMO_MODE=false

OPENAI_API_KEY=sk-...
OPENAI_WEBHOOK_SECRET=whsec_...
OPENAI_PROJECT_ID=proj_...

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+8150...
STORE_TRANSCRIPTS=true
```

APIキーやTwilioの認証情報はサーバー側だけで読み込み、画面や `data/state.json` には保存しません。

### 2. OpenAIの着信Webhook

OpenAI Platformの **Project → Webhooks** で次を登録します。

- URL: `https://phone.example.com/webhooks/openai`
- Event: `realtime.call.incoming`
- 発行された署名シークレット: `OPENAI_WEBHOOK_SECRET`

公式手順: [Realtime API with SIP](https://developers.openai.com/api/docs/guides/realtime-sip)

### 3. Twilioの着信経路

Twilioの購入番号で、着信時のVoice Webhookを次に設定します。

```text
https://phone.example.com/webhooks/twilio/incoming
```

HTTPメソッドは `POST` にします。このWebhookはTwilio署名を検証したあと、次のOpenAI SIP接続先を含むTwiMLを返します。

```text
sip:proj_あなたのProjectID@sip.api.openai.com;transport=tls
```

OpenAIへSIP INVITEが届くと、上のWebhookが発火し、このアプリが通話をacceptしてAI受付を開始します。

### 4. 架電

管理画面の「電話をかける」から、`090-1234-5678` や `03-1234-5678` のような国内形式で入力します。日本の10桁・11桁の番号だけを受け付け、サーバーがTwilio用の `+81` 形式へ自動変換します。海外番号と緊急・短縮番号は発信できません。Twilioが相手先へ電話し、応答後にOpenAIのSIPセッションへ接続します。進捗は `/webhooks/twilio/status` へ届きます。

Twilio公式: [Call resource](https://www.twilio.com/docs/voice/api/call-resource) / [`<Sip>` TwiML](https://www.twilio.com/docs/voice/twiml/sip)

### 5. 自分の声

「マイボイス」で以下を登録します。

1. 画面に表示された日本語の同意文だけを録音し、「同意音声を登録」
2. 普段の電話口の声を20〜30秒録音し、「AIボイスを作る」

音声ファイルは30秒以内、対応形式は `mpeg / wav / ogg / aac / flac / webm / mp4` です。カスタム音声は対象アカウントで利用できます。詳細は[OpenAI Text to speech — Custom voices](https://developers.openai.com/api/docs/guides/text-to-speech#creating-a-voice)を確認してください。

## 構成

```text
発信者・着信者
      ↕ PSTN
    Twilio
      ↕ SIP
OpenAI Realtime API ←→ このアプリ（Webhook / 通話監視 / 伝言保存）
                            ↕
                       管理ダッシュボード
```

Node.js版は標準機能と `ws` で動き、`data/state.json` に最大500通話まで保存します。Cloudflare版はD1へ最大500件を読み出し、通話中のセッションを通話ごとのDurable Objectで分離します。

## テスト

```bash
pnpm test
pnpm types
pnpm typecheck
pnpm deploy:dry
```

## 本番運用前の確認

- AI音声であることを通話冒頭で明示する（初期設定で有効）
- 録音・文字起こし・発信に関する適用法令、相手の同意、社内ルールを確認する
- HTTPS、アクセス認証、レート制限、監視、バックアップを追加する
- 通話履歴や文字起こしの保存期間・削除手順を決める
- 有人転送、緊急時、個人情報・決済情報を扱う場合の運用を別途設計する
- 本番Webhook URLを公開インターネットから到達可能にする

このMVPは医療・法律・金融・緊急通報などの高リスク用途を想定していません。

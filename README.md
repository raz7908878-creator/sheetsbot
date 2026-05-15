# SRF Sheet Bot 🤖

Telegram bot for managing FB jobs (2FA, Cookies) with local Excel export.

## Features

- 🔐 **FB 2FA Job** — UID | Password | 2FA Key
- 🍪 **FB Cookies Job** — UID | Password | Cookies
- 🔑 **Global Password** — Set once, auto-applied to all jobs
- 📥 **Download .xlsx** — Export jobs as Excel, auto-deletes from server after download
- 🗑️ **Clear Data** — Manually clear all stored jobs

## Setup

### 1. Create Telegram Bot
1. Message `@BotFather` on Telegram → `/newbot`
2. Copy the bot token

### 2. Configure .env
```env
BOT_TOKEN=your_bot_token_here
```

### 3. Run
```bash
npm install
npm start
```

## Excel Format

**2FA Jobs sheet:** `UID | Password | 2FA Key`
**Cookies Jobs sheet:** `UID | Password | Cookies`

## Flow
1. `/start` → Main menu
2. Set global password → 🔑 Set Password
3. Select job → Enter UID → Enter 2FA Key / Cookies
4. Download .xlsx → Data auto-deleted from server ✅

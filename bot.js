require('dotenv').config();
process.env.NTBA_FIX_350 = 1;
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const store = require('./sheets');

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing! Set it in .env file.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ============ USER STATE ============
const userStates = {};

function getState(userId) {
  return userStates[userId] || null;
}
function setState(userId, state) {
  userStates[userId] = state;
}
function clearState(userId) {
  delete userStates[userId];
}

function getUsername(msg) {
  if (msg.from.username) return '@' + msg.from.username;
  if (msg.from.first_name) return msg.from.first_name;
  return 'User_' + msg.from.id;
}

async function extractUid(input) {
  const profileMatch = input.match(/facebook\.com\/profile\.php\?id=(\d+)/);
  if (profileMatch) return profileMatch[1];

  const numericMatch = input.match(/facebook\.com\/(\d+)/);
  if (numericMatch) return numericMatch[1];

  // Try donetools API for any other facebook link (like share links)
  if (input.includes('facebook.com')) {
    try {
      const getRes = await fetch('https://donetools.com/find-facebook-id', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const cookies = getRes.headers.get('set-cookie');
      const html = await getRes.text();

      let csrfToken = '';
      const metaCsrf = html.match(/<meta name="csrf-token" content="([^"]+)"/i);
      if (metaCsrf) csrfToken = metaCsrf[1];

      let fingerprint = null;
      let serverMemo = null;
      
      const allLivewire = html.matchAll(/wire:initial-data="([^"]+)"/g);
      for (const match of allLivewire) {
          const decoded = match[1].replace(/&quot;/g, '"');
          try {
              const data = JSON.parse(decoded);
              if (data.fingerprint && data.fingerprint.name === 'public.tools.find-facebook-id') {
                  fingerprint = data.fingerprint;
                  serverMemo = data.serverMemo;
                  break;
              }
          } catch(e) {}
      }

      if (fingerprint && serverMemo) {
        const payload = {
          fingerprint: fingerprint,
          serverMemo: serverMemo,
          updates: [
            { type: 'syncInput', payload: { id: 'dt1', name: 'link', value: input } },
            { type: 'callMethod', payload: { id: 'dt2', method: 'onFindFacebookID', params: [] } }
          ]
        };

        const postRes = await fetch('https://donetools.com/livewire/message/public.tools.find-facebook-id', {
          method: 'POST',
          headers: {
            'Accept': 'text/html, application/xhtml+xml',
            'Content-Type': 'application/json',
            'Cookie': cookies || '',
            'Origin': 'https://donetools.com',
            'Referer': 'https://donetools.com/find-facebook-id',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'x-csrf-token': csrfToken,
            'x-livewire': 'true'
          },
          body: JSON.stringify(payload)
        });

        const data = await postRes.json();
        if (data?.serverMemo?.data?.data?.id) {
            return String(data.serverMemo.data.data.id);
        }
      }
    } catch (err) {
      console.error('Error extracting UID via donetools:', err.message);
    }
  }

  return input;
}

// ============ MAIN MENU ============

async function getMainMenu(userId, username) {
  const globalPassword = await store.getSetting(`global_password_${userId}`);
  const counts = await store.getJobCounts(userId);
  const passwordStatus = globalPassword ? `🟢 \`${globalPassword}\`` : '🔴 Not Set';

  const text = `
╔══════════════════════════════╗
║     🔥 *SRF SHEET BOT* 🔥      ║
╚══════════════════════════════╝

👋 Welcome, *${username}*!

🔑 *Password:* ${passwordStatus}
📊 *Jobs:* ${counts.twoFa} 2FA | ${counts.cookies} Cookies

━━━━━━━━━━━━━━━━━━━
Select a job or action:`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔐 FB 2FA Job', callback_data: 'job_2fa' },
          { text: '🍪 FB Cookies Job', callback_data: 'job_cookies' }
        ],
        [
          { text: '📥 Download 2FA', callback_data: 'download_2fa' },
          { text: '📥 Download Cookies', callback_data: 'download_cookies' }
        ],
        [
          { text: '✏️ Edit Last 2FA', callback_data: 'edit_last_2fa' },
          { text: '✏️ Edit Last Cookies', callback_data: 'edit_last_cookies' }
        ],
        [
          { text: '🗑️ Delete All 2FA', callback_data: 'clear_2fa' },
          { text: '🗑️ Delete All Cookies', callback_data: 'clear_cookies' }
        ],
        [
          { text: '🔑 Set Password', callback_data: 'set_password' },
          { text: '🗑️ Clear All Data', callback_data: 'clear_data' }
        ]
      ]
    }
  };

  return { text, keyboard };
}

// ============ /start ============

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  clearState(msg.from.id);
  const { text, keyboard } = await getMainMenu(msg.from.id, getUsername(msg));
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...keyboard });
});

bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id;
  clearState(msg.from.id);
  const { text, keyboard } = await getMainMenu(msg.from.id, getUsername(msg));
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...keyboard });
});

// ============ /admin ============

bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (process.env.ADMIN_ID && msg.from.id.toString() !== process.env.ADMIN_ID) {
    return bot.sendMessage(chatId, '⛔ You are not authorized to use this command.');
  }

  const stats = await store.getAllUserStats();
  if (stats.length === 0) {
    return bot.sendMessage(chatId, '📊 *Admin Panel*\n\nNo jobs have been submitted yet.', { parse_mode: 'Markdown' });
  }

  let text = '📊 *Admin Panel - User Stats*\n\n';
  let total2Fa = 0;
  let totalCookies = 0;
  const keyboard = [];

  stats.forEach((user, index) => {
    total2Fa += user.twoFa;
    totalCookies += user.cookies;
    text += `${index + 1}. *${user.username}* (\`${user.userId}\`)\n`;
    text += `   ├ 2FA: ${user.twoFa}\n`;
    text += `   ├ Cookies: ${user.cookies}\n`;
    text += `   └ Total: *${user.total}*\n\n`;

    const shortName = user.username.length > 12 ? user.username.substring(0, 10) + '..' : user.username;
    const row = [];
    if (user.twoFa > 0) {
      row.push({ text: `📥 ${shortName} 2FA`, callback_data: `admin_dl_2fa_${user.userId}` });
    }
    if (user.cookies > 0) {
      row.push({ text: `📥 ${shortName} Cookies`, callback_data: `admin_dl_cookies_${user.userId}` });
    }
    if (row.length > 0) {
      row.push({ text: `🗑️ Clear`, callback_data: `admin_clear_${user.userId}` });
      keyboard.push(row);
    }
  });

  text += `━━━━━━━━━━━━━━━━━\n`;
  text += `📈 *GRAND TOTAL:*\n`;
  text += `   ├ Total 2FA: ${total2Fa}\n`;
  text += `   ├ Total Cookies: ${totalCookies}\n`;
  text += `   └ *All Jobs: ${total2Fa + totalCookies}*`;

  const opts = { parse_mode: 'Markdown' };
  if (keyboard.length > 0) {
    opts.reply_markup = { inline_keyboard: keyboard };
  }

  await bot.sendMessage(chatId, text, opts);
});

// ============ /setpassword ============

bot.onText(/\/setpassword (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const password = match[1].trim();
  await store.setSetting(`global_password_${msg.from.id}`, password);
  await bot.sendMessage(chatId, `✅ *Global password updated!*\n\n🔑 Password: \`${password}\``, { parse_mode: 'Markdown' });
});

// ============ CALLBACK QUERIES ============

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  // ---- ADMIN CLEAR DATA ----
  if (data.startsWith('admin_clear_')) {
    if (process.env.ADMIN_ID && userId.toString() !== process.env.ADMIN_ID) {
      return; 
    }
    const targetUserId = data.split('_')[2];
    
    await bot.sendMessage(chatId, `⚠️ *Are you sure you want to clear all data for UID:* \`${targetUserId}\`?`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Yes, Clear', callback_data: `admin_confirmclear_${targetUserId}` },
            { text: '❌ Cancel', callback_data: 'cancel' }
          ]
        ]
      }
    });
    return;
  }

  // ---- ADMIN CONFIRM CLEAR DATA ----
  if (data.startsWith('admin_confirmclear_')) {
    if (process.env.ADMIN_ID && userId.toString() !== process.env.ADMIN_ID) {
      return; 
    }
    const targetUserId = data.split('_')[2];
    await store.clearJobs(targetUserId, 'all');
    clearState(targetUserId);
    await bot.sendMessage(chatId, `🗑️ *All data successfully cleared for UID:* \`${targetUserId}\``, { parse_mode: 'Markdown' });
    return;
  }

  // ---- ADMIN DOWNLOAD ----
  if (data.startsWith('admin_dl_')) {
    if (process.env.ADMIN_ID && userId.toString() !== process.env.ADMIN_ID) {
      return; 
    }

    const parts = data.split('_');
    const type = parts[2]; // '2fa' or 'cookies'
    const targetUserId = parts[3];
    
    const counts = await store.getJobCounts(targetUserId);
    const jobCount = type === '2fa' ? counts.twoFa : counts.cookies;
    
    if (jobCount === 0) {
      await bot.sendMessage(chatId, `⚠️ No ${type.toUpperCase()} jobs found for that user.`);
      return;
    }

    await bot.sendMessage(chatId, `⏳ Generating .xlsx file for UID: ${targetUserId}...`);

    try {
      const filePath = await store.generateExcel(targetUserId, type);
      if (!filePath) {
        await bot.sendMessage(chatId, '⚠️ No data to export.');
        return;
      }

      const allStats = await store.getAllUserStats();
      const targetUserStat = allStats.find(u => String(u.userId) === String(targetUserId));
      const targetUsername = targetUserStat ? targetUserStat.username : 'Unknown';
      const safeUsername = targetUsername.replace(/_/g, '\\_').replace(/\*/g, '\\*').replace(/\[/g, '\\[').replace(/`/g, '\\`');

      await bot.sendDocument(chatId, filePath, {
        caption: `📥 *Admin Export*\nUser ID: \`${targetUserId}\` ( ${safeUsername} )\nType: ${type.toUpperCase()}\nCount: ${jobCount} jobs`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🔍 Filter Live', callback_data: `filter_live_${type}_${targetUserId}` }]]
        }
      });

      fs.unlinkSync(filePath);
    } catch (err) {
      console.error('Admin Export error:', err.message);
      await bot.sendMessage(chatId, '❌ Failed to generate file.');
    }
    return;
  }

  // ---- 2FA JOB ----
  if (data === 'job_2fa') {
    const globalPassword = await store.getSetting(`global_password_${userId}`);
    if (!globalPassword) {
      await bot.sendMessage(chatId,
        '⚠️ *No global password set!*\n\nSet one first:\n• Tap 🔑 *Set Password* from menu\n• Or send: `/setpassword yourpass`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    setState(userId, { step: '2fa_uid', job_type: '2fa' });
    await bot.sendMessage(chatId,
      '🔐 *FB 2FA Job*\n\n📝 Send the *UID*:',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    );
  }

  // ---- COOKIES JOB ----
  else if (data === 'job_cookies') {
    const globalPassword = await store.getSetting(`global_password_${userId}`);
    if (!globalPassword) {
      await bot.sendMessage(chatId,
        '⚠️ *No global password set!*\n\nSet one first:\n• Tap 🔑 *Set Password* from menu\n• Or send: `/setpassword yourpass`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    setState(userId, { step: 'cookies_uid', job_type: 'cookies' });
    await bot.sendMessage(chatId,
      '🍪 *FB Cookies Job*\n\n📝 Send the *UID*:',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    );
  }

  // ---- SET PASSWORD ----
  else if (data === 'set_password') {
    setState(userId, { step: 'set_password' });
    await bot.sendMessage(chatId,
      '🔑 *Set Global Password*\n\nSend the new password:',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } }
    );
  }

  // ---- DOWNLOAD ----
  else if (data.startsWith('download_')) {
    const type = data.split('_')[1]; // '2fa' or 'cookies'
    const counts = await store.getJobCounts(userId);
    const jobCount = type === '2fa' ? counts.twoFa : counts.cookies;
    
    if (jobCount === 0) {
      await bot.sendMessage(chatId, `⚠️ No ${type.toUpperCase()} jobs recorded yet. Submit some jobs first!`);
      return;
    }

    await bot.sendMessage(chatId, '⏳ Generating .xlsx file...');

    try {
      const filePath = await store.generateExcel(userId, type);
      if (!filePath) {
        await bot.sendMessage(chatId, '⚠️ No data to export.');
        return;
      }

      const captionText = type === '2fa' 
        ? `📥 *SRF Job Records (2FA)*\n\n🔐 2FA: ${counts.twoFa} jobs`
        : `📥 *SRF Job Records (Cookies)*\n\n🍪 Cookies: ${counts.cookies} jobs`;

      await bot.sendDocument(chatId, filePath, {
        caption: captionText,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🔍 Filter Live', callback_data: `filter_live_${type}_${userId}` }]]
        }
      });

      // Auto-delete temp file only, keep job data
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error('Export error:', err.message);
      await bot.sendMessage(chatId, '❌ Failed to generate file. Try again.');
    }
  }

  // ---- FILTER LIVE ----
  else if (data.startsWith('filter_live_')) {
    const parts = data.split('_');
    const type = parts[2]; // '2fa' or 'cookies'
    const targetUserId = parts[3];

    if (userId.toString() !== targetUserId && (!process.env.ADMIN_ID || userId.toString() !== process.env.ADMIN_ID)) {
      return bot.sendMessage(chatId, '⛔ You cannot filter these jobs.');
    }

    const waitMsg = await bot.sendMessage(chatId, `⏳ Checking accounts for ${type.toUpperCase()} jobs... This might take a moment.`);

    try {
      const onProgress = async (current, total) => {
        if (current % 10 === 0 || current === total) {
          const percent = Math.round((current / total) * 100);
          await bot.editMessageText(`⏳ Checking accounts for ${type.toUpperCase()} jobs... ${percent}% (${current}/${total})`, {
            chat_id: chatId,
            message_id: waitMsg.message_id
          }).catch(() => {});
        }
      };

      const result = await store.generateLiveExcel(targetUserId, type, onProgress);
      
      await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});

      if (!result || result.totalCount === 0) {
        await bot.sendMessage(chatId, '⚠️ No jobs found to filter.');
        return;
      }

      if (!result.filePath) {
        await bot.sendMessage(chatId, `❌ Out of ${result.totalCount} jobs checked, 0 are live.`);
        return;
      }

      const captionText = `📥 *Live Accounts Filtered*\n\n✅ Checked: ${result.totalCount}\n🟢 Live: ${result.liveCount}\n🔴 Dead: ${result.totalCount - result.liveCount}`;

      await bot.sendDocument(chatId, result.filePath, {
        caption: captionText,
        parse_mode: 'Markdown'
      });

      fs.unlinkSync(result.filePath);
    } catch (err) {
      console.error('Filter live error:', err.message);
      await bot.sendMessage(chatId, '❌ Failed to filter live accounts.');
    }
  }

  // ---- FILTER UPLOADED FILE ----
  else if (data === 'filter_file_upload') {
    const state = getState(userId);
    if (!state || !state.fileId) {
      return bot.sendMessage(chatId, '⚠️ File session expired. Please upload the .xlsx file again.');
    }
    const fileId = state.fileId;
    
    await bot.editMessageText(`⏳ Downloading file and checking accounts... 0%`, {
      chat_id: chatId,
      message_id: query.message.message_id
    }).catch(() => {});

    try {
      const fileLink = await bot.getFileLink(fileId);
      const fetchRes = await fetch(fileLink);
      const buffer = await fetchRes.arrayBuffer();
      
      const onProgress = async (current, total) => {
        if (current % 10 === 0 || current === total) {
          const percent = Math.round((current / total) * 100);
          await bot.editMessageText(`⏳ Checking accounts... ${percent}% (${current}/${total})`, {
            chat_id: chatId,
            message_id: query.message.message_id
          }).catch(() => {});
        }
      };

      const result = await store.filterUploadedExcel(Buffer.from(buffer), onProgress);
      
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});

      if (!result || result.totalCount === 0) {
        await bot.sendMessage(chatId, '⚠️ No valid UIDs found in the first column or invalid file.');
        return;
      }
      
      if (!result.filePath) {
        await bot.sendMessage(chatId, `❌ Out of ${result.totalCount} rows checked, 0 are live.`);
        return;
      }

      const captionText = `📥 *Live Accounts Filtered*\n\n✅ Checked: ${result.totalCount}\n🟢 Live: ${result.liveCount}\n🔴 Dead: ${result.totalCount - result.liveCount}`;

      await bot.sendDocument(chatId, result.filePath, {
        caption: captionText,
        parse_mode: 'Markdown'
      });

      fs.unlinkSync(result.filePath);
    } catch (err) {
      console.error('Filter file error:', err);
      await bot.sendMessage(chatId, '❌ Failed to filter the uploaded file.');
    }
  }

  // ---- CLEAR DATA ----
  else if (data === 'clear_data') {
    const counts = await store.getJobCounts(userId);
    if (counts.total === 0) {
      await bot.sendMessage(chatId, '⚠️ No data to clear.');
      return;
    }

    setState(userId, { step: 'confirm_clear' });
    await bot.sendMessage(chatId,
      `⚠️ *Are you sure?*\n\nThis will delete *${counts.total} jobs* (${counts.twoFa} 2FA + ${counts.cookies} Cookies)\n\n⛔ This cannot be undone!`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Yes, Delete All', callback_data: 'confirm_clear_yes' },
              { text: '❌ Cancel', callback_data: 'cancel' }
            ]
          ]
        }
      }
    );
  }

  else if (data === 'confirm_clear_yes') {
    await store.clearJobs(userId, 'all');
    clearState(userId);
    await bot.sendMessage(chatId, '🗑️ *All job data deleted!*', { parse_mode: 'Markdown' });
  }

  // ---- CLEAR 2FA ----
  else if (data === 'clear_2fa') {
    const counts = await store.getJobCounts(userId);
    if (counts.twoFa === 0) {
      await bot.sendMessage(chatId, '⚠️ No 2FA jobs to clear.');
      return;
    }

    setState(userId, { step: 'confirm_clear_2fa' });
    await bot.sendMessage(chatId,
      `⚠️ *Are you sure?*\n\nThis will delete *${counts.twoFa} 2FA jobs*\n\n⛔ This cannot be undone!`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Yes, Delete 2FA', callback_data: 'confirm_clear_2fa_yes' },
              { text: '❌ Cancel', callback_data: 'cancel' }
            ]
          ]
        }
      }
    );
  }
  else if (data === 'confirm_clear_2fa_yes') {
    await store.clearJobs(userId, '2fa');
    clearState(userId);
    await bot.sendMessage(chatId, '🗑️ *All 2FA job data deleted!*', { parse_mode: 'Markdown' });
  }

  // ---- CLEAR COOKIES ----
  else if (data === 'clear_cookies') {
    const counts = await store.getJobCounts(userId);
    if (counts.cookies === 0) {
      await bot.sendMessage(chatId, '⚠️ No Cookies jobs to clear.');
      return;
    }

    setState(userId, { step: 'confirm_clear_cookies' });
    await bot.sendMessage(chatId,
      `⚠️ *Are you sure?*\n\nThis will delete *${counts.cookies} Cookies jobs*\n\n⛔ This cannot be undone!`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Yes, Delete Cookies', callback_data: 'confirm_clear_cookies_yes' },
              { text: '❌ Cancel', callback_data: 'cancel' }
            ]
          ]
        }
      }
    );
  }
  else if (data === 'confirm_clear_cookies_yes') {
    await store.clearJobs(userId, 'cookies');
    clearState(userId);
    await bot.sendMessage(chatId, '🗑️ *All Cookies job data deleted!*', { parse_mode: 'Markdown' });
  }

  // ---- EDIT LAST JOB ----
  else if (data === 'edit_last_2fa' || data === 'edit_last_cookies') {
    const type = data === 'edit_last_2fa' ? '2fa' : 'cookies';
    const lastJob = await store.getLastJob(userId, type);
    if (!lastJob) {
      await bot.sendMessage(chatId, `⚠️ No ${type.toUpperCase()} job found to edit.`);
      return;
    }
    
    setState(userId, { step: 'select_edit', job_type: type });
    
    const valueDisp = type === '2fa' ? lastJob.two_fa_key : `${lastJob.cookies.substring(0, 40)}...`;
    const label = type === '2fa' ? '2FA Key' : 'Cookies';
    
    await bot.sendMessage(chatId,
      `✏️ *Edit Last ${type.toUpperCase()} Job*\n\n` +
      `👤 UID: \`${lastJob.uid}\`\n` +
      `🔑 ${label}: \`${valueDisp}\`\n\n` +
      `What do you want to edit?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✏️ Edit UID', callback_data: `edit_${type}_uid` }],
            [{ text: `✏️ Edit ${label}`, callback_data: `edit_${type}_value` }],
            [{ text: '❌ Cancel', callback_data: 'cancel' }]
          ]
        }
      }
    );
  }
  else if (data === 'edit_2fa_uid' || data === 'edit_cookies_uid') {
    const type = data === 'edit_2fa_uid' ? '2fa' : 'cookies';
    setState(userId, { step: `editing_${type}_uid` });
    await bot.sendMessage(chatId, "📝 Send the new *UID*:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } });
  }
  else if (data === 'edit_2fa_value' || data === 'edit_cookies_value') {
    const type = data === 'edit_2fa_value' ? '2fa' : 'cookies';
    const label = type === '2fa' ? '2FA Key' : 'Cookies';
    setState(userId, { step: `editing_${type}_value` });
    await bot.sendMessage(chatId, `📝 Send the new *${label}*:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } });
  }

  // ---- CANCEL ----
  else if (data === 'cancel') {
    clearState(userId);
    await bot.sendMessage(chatId, '❌ Cancelled.\n\nSend /start for the menu.');
  }
});

// ============ MESSAGE HANDLER (conversation flow) ============

bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (msg.document) {
    const doc = msg.document;
    if (doc.file_name && doc.file_name.endsWith('.xlsx')) {
      setState(userId, { step: 'uploaded_file', fileId: doc.file_id });
      await bot.sendMessage(chatId, `📁 Received *${doc.file_name}*\n\nDo you want to filter live accounts from this file?`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🔍 Filter Live Accounts', callback_data: `filter_file_upload` }]]
        }
      });
    }
    return;
  }

  const text = msg.text ? msg.text.trim() : '';
  const state = getState(userId);

  if (!state) return;

  const cancelBtn = { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } };

  // ---- SET PASSWORD ----
  if (state.step === 'set_password') {
    if (!text) return bot.sendMessage(chatId, '⚠️ Send a valid password.');
    await store.setSetting(`global_password_${userId}`, text);
    clearState(userId);
    await bot.sendMessage(chatId, `✅ *Password set!*\n\n🔑 Password: \`${text}\``, { parse_mode: 'Markdown' });
    return;
  }

  // ---- 2FA: UID step ----
  if (state.step === '2fa_uid') {
    if (!text) return bot.sendMessage(chatId, '⚠️ Send a valid UID.');
    
    let waitMsg = null;
    if (text.includes('facebook.com')) {
      waitMsg = await bot.sendMessage(chatId, '⏳ Extracting UID from link...');
    }
    
    const uid = await extractUid(text);
    
    if (waitMsg) await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    
    setState(userId, { ...state, step: '2fa_key', uid });
    await bot.sendMessage(chatId,
      `✅ UID: \`${uid}\`\n\n📝 Now send the *2FA Key*:`,
      { parse_mode: 'Markdown', ...cancelBtn }
    );
    return;
  }

  // ---- 2FA: Key step ----
  if (state.step === '2fa_key') {
    if (!text) return bot.sendMessage(chatId, '⚠️ Send a valid 2FA key.');

    const globalPassword = await store.getSetting(`global_password_${userId}`);

    const jobData = {
      user_id: userId,
      username: getUsername(msg),
      job_type: '2fa',
      uid: state.uid,
      password: globalPassword,
      two_fa_key: text
    };

    await store.addJob(userId, jobData);
    clearState(userId);

    const counts = await store.getJobCounts(userId);

    await bot.sendMessage(chatId,
      `✅ *2FA Job Saved!*\n\n` +
      `┠ 👤 UID: \`${state.uid}\`\n` +
      `┠ 🔑 Pass: \`${globalPassword}\`\n` +
      `┠ 🔐 2FA: \`${text}\`\n` +
      `┗━━━━━━━━━━━━━━━\n\n` +
      `📊 Total: ${counts.total} jobs\n\n` +
      `Send /start for menu or keep submitting!`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔐 Another 2FA Job', callback_data: 'job_2fa' },
              { text: '🍪 Cookies Job', callback_data: 'job_cookies' }
            ],
            [{ text: '✏️ Edit This Job', callback_data: 'edit_last_2fa' }],
            [{ text: '📥 Download 2FA', callback_data: 'download_2fa' }]
          ]
        }
      }
    );
    return;
  }

  // ---- COOKIES: UID step ----
  if (state.step === 'cookies_uid') {
    if (!text) return bot.sendMessage(chatId, '⚠️ Send a valid UID.');
    
    let waitMsg = null;
    if (text.includes('facebook.com')) {
      waitMsg = await bot.sendMessage(chatId, '⏳ Extracting UID from link...');
    }
    
    const uid = await extractUid(text);
    
    if (waitMsg) await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    
    setState(userId, { ...state, step: 'cookies_value', uid });
    await bot.sendMessage(chatId,
      `✅ UID: \`${uid}\`\n\n📝 Now send the *Cookies*:`,
      { parse_mode: 'Markdown', ...cancelBtn }
    );
    return;
  }

  // ---- COOKIES: Value step ----
  if (state.step === 'cookies_value') {
    if (!text) return bot.sendMessage(chatId, '⚠️ Send valid cookies.');

    const globalPassword = await store.getSetting(`global_password_${userId}`);

    const jobData = {
      user_id: userId,
      username: getUsername(msg),
      job_type: 'cookies',
      uid: state.uid,
      password: globalPassword,
      cookies: text
    };

    await store.addJob(userId, jobData);
    clearState(userId);

    const counts = await store.getJobCounts(userId);

    await bot.sendMessage(chatId,
      `✅ *Cookies Job Saved!*\n\n` +
      `┠ 👤 UID: \`${state.uid}\`\n` +
      `┠ 🔑 Pass: \`${globalPassword}\`\n` +
      `┠ 🍪 Cookies: \`${text.substring(0, 40)}...\`\n` +
      `┗━━━━━━━━━━━━━━━\n\n` +
      `📊 Total: ${counts.total} jobs\n\n` +
      `Send /start for menu or keep submitting!`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🍪 Another Cookies Job', callback_data: 'job_cookies' },
              { text: '🔐 2FA Job', callback_data: 'job_2fa' }
            ],
            [{ text: '✏️ Edit This Job', callback_data: 'edit_last_cookies' }],
            [{ text: '📥 Download Cookies', callback_data: 'download_cookies' }]
          ]
        }
      }
    );
    return;
  }

  // ---- EDITING VALUES ----
  if (state.step && state.step.startsWith('editing_')) {
    if (!text) return bot.sendMessage(chatId, '⚠️ Send a valid value.');
    
    const parts = state.step.split('_');
    const type = parts[1]; // '2fa' or 'cookies'
    const field = parts[2]; // 'uid' or 'value'
    
    let updates = {};
    let displayValue = text;
    
    if (field === 'uid') {
      let waitMsg = null;
      if (text.includes('facebook.com')) {
        waitMsg = await bot.sendMessage(chatId, '⏳ Extracting UID from link...');
      }
      
      const uid = await extractUid(text);
      
      if (waitMsg) await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      
      updates = { uid };
      displayValue = uid;
    } else {
      if (type === '2fa') {
        updates = { two_fa_key: text };
      } else {
        updates = { cookies: text };
        displayValue = `${text.substring(0, 40)}...`;
      }
    }
    
    const success = await store.updateLastJob(userId, type, updates);
    if (success) {
      clearState(userId);
      const label = field === 'uid' ? 'UID' : (type === '2fa' ? '2FA Key' : 'Cookies');
      
      const lastJob = await store.getLastJob(userId, type);
      const valDisp = type === '2fa' ? lastJob.two_fa_key : `${lastJob.cookies.substring(0, 40)}...`;

      await bot.sendMessage(chatId, 
        `✅ *${label} Updated!* to \`${displayValue}\`\n\n` +
        `*Current Job Status:*\n` +
        `👤 UID: \`${lastJob.uid}\`\n` +
        `${type === '2fa' ? '🔐 2FA' : '🍪 Cookies'}: \`${valDisp}\``, 
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✏️ Edit Again', callback_data: `edit_last_${type}` }],
              [{ text: '🔙 Menu', callback_data: 'cancel' }]
            ]
          }
        }
      );
    } else {
      await bot.sendMessage(chatId, "⚠️ Failed to update. Job might not exist.");
    }
    return;
  }
});

// ============ STARTUP ============

console.log('🤖 SRF Sheet Bot starting...');
console.log('✅ Bot is running! Send /start in Telegram.');

bot.on('polling_error', (err) => console.error('Polling error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err));

// ============ RENDER WEB SERVICE ============
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('SRF Sheet Bot is running!');
});

app.listen(PORT, () => {
  console.log(`🌐 Express web server running on port ${PORT}`);
});

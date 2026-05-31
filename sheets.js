const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { Redis } = require('@upstash/redis');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REST_TOKEN,
});

const SETTINGS_KEY = 'srf:settings';
const JOBS_KEY = 'srf:jobs';

// ============ SETTINGS ============

async function getSetting(key) {
  try {
    const value = await redis.hget(SETTINGS_KEY, key);
    return value || null;
  } catch (e) {
    console.error('Redis getSetting error:', e);
    return null;
  }
}

async function setSetting(key, value) {
  try {
    await redis.hset(SETTINGS_KEY, { [key]: value });
  } catch (e) {
    console.error('Redis setSetting error:', e);
  }
}

// ============ JOBS STORAGE ============

async function loadJobs() {
  try {
    const data = await redis.get(JOBS_KEY);
    return data || {};
  } catch (e) {
    console.error('Redis loadJobs error:', e);
    return {};
  }
}

async function saveJobsFile(jobs) {
  try {
    await redis.set(JOBS_KEY, jobs);
  } catch (e) {
    console.error('Redis saveJobsFile error:', e);
  }
}

async function getUserJobs(userId) {
  const jobs = await loadJobs();
  return jobs[userId] || { twoFa: [], cookies: [] };
}

async function addJob(userId, jobData) {
  const jobs = await loadJobs();
  if (!jobs[userId]) jobs[userId] = { twoFa: [], cookies: [] };
  
  const now = new Date();
  const entry = {
    ...jobData,
    date: now.toLocaleDateString('en-GB'),
    time: now.toLocaleTimeString('en-GB', { hour12: false }),
    timestamp: now.toISOString()
  };

  if (jobData.job_type === '2fa') {
    jobs[userId].twoFa.push(entry);
  } else if (jobData.job_type === 'cookies') {
    jobs[userId].cookies.push(entry);
  }

  await saveJobsFile(jobs);
  return entry;
}

async function getJobCounts(userId) {
  const userJobs = await getUserJobs(userId);
  return {
    twoFa: userJobs.twoFa.length,
    cookies: userJobs.cookies.length,
    total: userJobs.twoFa.length + userJobs.cookies.length
  };
}

async function getAllUserStats() {
  const jobs = await loadJobs();
  const stats = [];
  
  for (const userId in jobs) {
    const userJobs = jobs[userId];
    const twoFaCount = Array.isArray(userJobs.twoFa) ? userJobs.twoFa.length : 0;
    const cookiesCount = Array.isArray(userJobs.cookies) ? userJobs.cookies.length : 0;
    
    if (twoFaCount > 0 || cookiesCount > 0) {
      let username = 'Unknown';
      if (twoFaCount > 0 && userJobs.twoFa[0].username) {
        username = userJobs.twoFa[0].username;
      } else if (cookiesCount > 0 && userJobs.cookies[0].username) {
        username = userJobs.cookies[0].username;
      }
      
      stats.push({
        userId,
        username,
        twoFa: twoFaCount,
        cookies: cookiesCount,
        total: twoFaCount + cookiesCount
      });
    }
  }
  
  stats.sort((a, b) => b.total - a.total);
  return stats;
}

async function clearJobs(userId, type) {
  const jobs = await loadJobs();
  if (!jobs[userId]) return;

  if (type === '2fa') jobs[userId].twoFa = [];
  if (type === 'cookies') jobs[userId].cookies = [];
  if (type === 'all') { jobs[userId].twoFa = []; jobs[userId].cookies = []; }
  await saveJobsFile(jobs);
}

async function getLastJob(userId, type) {
  const jobs = await loadJobs();
  if (!jobs[userId] || !jobs[userId][type === '2fa' ? 'twoFa' : 'cookies']) return null;
  const arr = jobs[userId][type === '2fa' ? 'twoFa' : 'cookies'];
  return arr.length > 0 ? arr[arr.length - 1] : null;
}

async function updateLastJob(userId, type, updates) {
  const jobs = await loadJobs();
  if (!jobs[userId] || !jobs[userId][type === '2fa' ? 'twoFa' : 'cookies']) return false;
  const arr = jobs[userId][type === '2fa' ? 'twoFa' : 'cookies'];
  if (arr.length === 0) return false;
  
  arr[arr.length - 1] = { ...arr[arr.length - 1], ...updates };
  await saveJobsFile(jobs);
  return true;
}

// ============ EXCEL EXPORT ============

async function generateExcel(userId, type) {
  const userJobs = await getUserJobs(userId);
  let hasData = false;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SRF Sheet Bot';
  workbook.created = new Date();

  // ---- 2FA Jobs Sheet ----
  if ((type === '2fa' || type === 'all') && userJobs.twoFa.length > 0) {
    hasData = true;
    const sheet2fa = workbook.addWorksheet('2FA Jobs');
    sheet2fa.getColumn(1).width = 25;
    sheet2fa.getColumn(2).width = 25;
    sheet2fa.getColumn(3).width = 40;

    userJobs.twoFa.forEach(job => {
      sheet2fa.addRow([job.uid, job.password, job.two_fa_key]);
    });
  }

  // ---- Cookies Jobs Sheet ----
  if ((type === 'cookies' || type === 'all') && userJobs.cookies.length > 0) {
    hasData = true;
    const sheetCookies = workbook.addWorksheet('Cookies Jobs');
    sheetCookies.getColumn(1).width = 25;
    sheetCookies.getColumn(2).width = 25;
    sheetCookies.getColumn(3).width = 70;

    userJobs.cookies.forEach(job => {
      sheetCookies.addRow([job.uid, job.password, job.cookies]);
    });
  }

  if (!hasData) return null;

  const prefix = type === '2fa' ? '2FA_' : type === 'cookies' ? 'Cookies_' : '';
  const filePath = path.join(DATA_DIR, `SRF_${prefix}Jobs_${Date.now()}.xlsx`);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

// ============ FILTER LIVE ============

async function checkLiveUid(uid) {
  try {
    const res = await fetch(`https://graph.facebook.com/${uid}/picture?type=normal`, {
      method: 'GET',
      redirect: 'manual'
    });
    
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location && (location.includes('static.xx.fbcdn.net') || location.includes('C5yt7Cqf3zU.jpg'))) {
        return false; // dead
      }
      if (location) {
        return true; // live
      }
    } else if (res.status === 404 || res.status === 400) {
      return false; // dead or invalid
    }
    
    return true; // fallback
  } catch (err) {
    console.error('Check UID error:', err);
    return false;
  }
}

async function generateLiveExcel(userId, type) {
  const userJobs = await getUserJobs(userId);
  let jobsList = [];

  if (type === '2fa') jobsList = userJobs.twoFa;
  else if (type === 'cookies') jobsList = userJobs.cookies;

  if (!jobsList || jobsList.length === 0) return null;

  const liveJobs = [];
  for (const job of jobsList) {
    const isLive = await checkLiveUid(job.uid);
    if (isLive) {
      liveJobs.push(job);
    }
  }

  if (liveJobs.length === 0) return { filePath: null, liveCount: 0, totalCount: jobsList.length };

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SRF Sheet Bot';
  workbook.created = new Date();

  const sheetName = type === '2fa' ? 'Live 2FA Jobs' : 'Live Cookies Jobs';
  const sheet = workbook.addWorksheet(sheetName);
  sheet.getColumn(1).width = 25;
  sheet.getColumn(2).width = 25;
  sheet.getColumn(3).width = type === '2fa' ? 40 : 70;

  liveJobs.forEach(job => {
    sheet.addRow([job.uid, job.password, type === '2fa' ? job.two_fa_key : job.cookies]);
  });

  const prefix = type === '2fa' ? '2FA_' : type === 'cookies' ? 'Cookies_' : '';
  const filePath = path.join(DATA_DIR, `SRF_Live_${prefix}Jobs_${Date.now()}.xlsx`);
  await workbook.xlsx.writeFile(filePath);

  return { filePath, liveCount: liveJobs.length, totalCount: jobsList.length };
}

async function filterUploadedExcel(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return null;
  
  const newWorkbook = new ExcelJS.Workbook();
  newWorkbook.creator = 'SRF Sheet Bot';
  const newWorksheet = newWorkbook.addWorksheet('Live Accounts');
  
  let totalCount = 0;
  let liveCount = 0;
  
  for (let i = 1; i <= worksheet.rowCount; i++) {
    const row = worksheet.getRow(i);
    const firstCell = row.getCell(1).value;
    
    if (!firstCell) continue;
    
    const cellValue = firstCell.toString().trim();
    
    if (/^\d+$/.test(cellValue)) {
      totalCount++;
      const isLive = await checkLiveUid(cellValue);
      if (isLive) {
        liveCount++;
        newWorksheet.addRow(row.values);
      }
    } else {
      if (i === 1) {
        newWorksheet.addRow(row.values);
      }
    }
  }
  
  if (totalCount === 0) return { filePath: null, liveCount: 0, totalCount: 0 };
  
  if (liveCount === 0) return { filePath: null, liveCount: 0, totalCount };
  
  const filePath = path.join(DATA_DIR, `SRF_Filtered_Jobs_${Date.now()}.xlsx`);
  await newWorkbook.xlsx.writeFile(filePath);
  
  return { filePath, liveCount, totalCount };
}

module.exports = {
  getSetting,
  setSetting,
  addJob,
  getJobCounts,
  getAllUserStats,
  clearJobs,
  generateExcel,
  generateLiveExcel,
  filterUploadedExcel,
  loadJobs,
  getLastJob,
  updateLastJob
};

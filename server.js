const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '8737255406:AAGDfuIznZb3zjVV3Px0d6M4g4jjiRtm9gM';

// Start Express first for Render
app.get('/', (req, res) => res.send('Lens Bot is running!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startBot();
});

// ===== Google Lens Search =====
async function searchGoogleLens(imagePath) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });

    // Go to Google Images
    await page.goto('https://images.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Click camera icon (search by image)
    const cameraBtn = await page.$('[aria-label="Search by image"]') || await page.$('.nDcEnd');
    if (cameraBtn) {
      await cameraBtn.click();
      await new Promise(r => setTimeout(r, 2000));
    } else {
      // Try alternative selector
      const btns = await page.$$('div[role="button"]');
      for (let btn of btns) {
        const text = await page.evaluate(el => el.getAttribute('aria-label'), btn);
        if (text && text.includes('image')) {
          await btn.click();
          await new Promise(r => setTimeout(r, 2000));
          break;
        }
      }
    }

    // Upload image
    const uploadInput = await page.$('input[type="file"]');
    if (uploadInput) {
      await uploadInput.uploadFile(imagePath);
      await new Promise(r => setTimeout(r, 5000));
    } else {
      await browser.close();
      return { success: false, error: 'لم أتمكن من إيجاد زر رفع الصورة' };
    }

    // Wait for results
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    // Get current URL
    const resultUrl = page.url();

    // Try to get text results
    const results = await page.evaluate(() => {
      let data = {
        title: '',
        descriptions: [],
        links: [],
        locations: []
      };

      // Get page title/main result
      const mainTitle = document.querySelector('h1, h2, [data-attrid="title"]');
      if (mainTitle) data.title = mainTitle.textContent.trim();

      // Get all text that might contain location info
      const allText = document.body.innerText;
      
      // Look for location-related keywords
      const locationKeywords = ['located', 'location', 'address', 'city', 'country', 'street', 'park', 'palace', 'building', 'monument'];
      const lines = allText.split('\n').filter(line => line.trim().length > 5);
      
      // Get first meaningful results
      const resultElements = document.querySelectorAll('[data-text-ad], .g, [data-hveid], .srKDX, .UAiK1e');
      resultElements.forEach((el, i) => {
        if (i < 5) {
          const text = el.textContent.trim();
          if (text.length > 10 && text.length < 500) {
            data.descriptions.push(text.substring(0, 200));
          }
        }
      });

      // Get links
      const linkElements = document.querySelectorAll('a[href*="http"]');
      linkElements.forEach((el, i) => {
        if (i < 5) {
          const href = el.href;
          const text = el.textContent.trim();
          if (text.length > 3 && !href.includes('google.com') && !href.includes('gstatic')) {
            data.links.push({ text: text.substring(0, 100), url: href });
          }
        }
      });

      // Look for "Exact matches" or visual matches text
      const exactMatches = document.querySelectorAll('.fKDtNb, .VFACy, .UAiK1e, .OSrXXb');
      exactMatches.forEach((el, i) => {
        if (i < 5) {
          const text = el.textContent.trim();
          if (text.length > 5) {
            data.descriptions.push(text.substring(0, 200));
          }
        }
      });

      return data;
    });

    // Take screenshot of results
    const screenshotPath = imagePath.replace('.jpg', '_results.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });

    await browser.close();

    return {
      success: true,
      resultUrl,
      results,
      screenshotPath
    };

  } catch (error) {
    if (browser) await browser.close();
    return { success: false, error: error.message };
  }
}

// ===== Bot =====
let bot;

function startBot() {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.on('polling_error', (err) => {
    console.error('Polling error:', err.message);
  });

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
`🔍 *بوت البحث بالصور (Google Lens)*

أرسل لي أي صورة وأبحث لك عنها!

📸 أرسل صورة مكان (قصر، حديقة، شارع، مبنى)
🔎 أبحث لك وأحاول أعرف وين الموقع
📋 أرجع لك النتائج + سكرين شوت لنتائج البحث

*الاستخدام:* ارسل صورة وانتظر النتيجة (10-20 ثانية)`, {
      parse_mode: 'Markdown'
    });
  });

  // Handle photos
  bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;

    try {
      await bot.sendMessage(chatId, '🔍 جاري البحث عن الصورة... انتظر 10-20 ثانية');

      // Get highest resolution photo
      const photo = msg.photo[msg.photo.length - 1];
      const fileId = photo.file_id;

      // Download the photo
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const imagePath = `/tmp/lens_${chatId}_${Date.now()}.jpg`;
      fs.writeFileSync(imagePath, response.data);

      // Search with Google Lens
      const result = await searchGoogleLens(imagePath);

      if (result.success) {
        // Build response message
        let message = '🔍 *نتائج البحث:*\n\n';

        if (result.results.title) {
          message += `📌 *${result.results.title}*\n\n`;
        }

        if (result.results.descriptions.length > 0) {
          message += '📋 *معلومات:*\n';
          const uniqueDescs = [...new Set(result.results.descriptions)].slice(0, 3);
          uniqueDescs.forEach(desc => {
            message += `• ${desc}\n`;
          });
          message += '\n';
        }

        if (result.results.links.length > 0) {
          message += '🔗 *روابط ذات صلة:*\n';
          const uniqueLinks = result.results.links.slice(0, 3);
          uniqueLinks.forEach(link => {
            message += `• [${link.text}](${link.url})\n`;
          });
          message += '\n';
        }

        message += `🌐 [فتح النتائج في Google](${result.resultUrl})`;

        // Send results text
        await bot.sendMessage(chatId, message, { 
          parse_mode: 'Markdown',
          disable_web_page_preview: true 
        });

        // Send screenshot of results
        if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
          await bot.sendPhoto(chatId, result.screenshotPath, {
            caption: '📸 سكرين شوت لنتائج البحث'
          });
          fs.unlinkSync(result.screenshotPath);
        }

      } else {
        await bot.sendMessage(chatId, `❌ خطأ: ${result.error}\n\nجرب صورة ثانية.`);
      }

      // Delete temp image
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);

    } catch (error) {
      console.error('Error:', error.message);
      await bot.sendMessage(chatId, `❌ حدث خطأ: ${error.message}\n\nجرب مرة ثانية.`);
    }
  });

  // Handle documents (images sent as files)
  bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const doc = msg.document;

    if (!doc.mime_type || !doc.mime_type.startsWith('image/')) {
      return bot.sendMessage(chatId, '❌ أرسل صورة فقط.');
    }

    try {
      await bot.sendMessage(chatId, '🔍 جاري البحث عن الصورة... انتظر 10-20 ثانية');

      const file = await bot.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const imagePath = `/tmp/lens_${chatId}_${Date.now()}.jpg`;
      fs.writeFileSync(imagePath, response.data);

      const result = await searchGoogleLens(imagePath);

      if (result.success) {
        let message = '🔍 *نتائج البحث:*\n\n';

        if (result.results.title) {
          message += `📌 *${result.results.title}*\n\n`;
        }

        if (result.results.descriptions.length > 0) {
          message += '📋 *معلومات:*\n';
          const uniqueDescs = [...new Set(result.results.descriptions)].slice(0, 3);
          uniqueDescs.forEach(desc => {
            message += `• ${desc}\n`;
          });
          message += '\n';
        }

        if (result.results.links.length > 0) {
          message += '🔗 *روابط ذات صلة:*\n';
          const uniqueLinks = result.results.links.slice(0, 3);
          uniqueLinks.forEach(link => {
            message += `• [${link.text}](${link.url})\n`;
          });
          message += '\n';
        }

        message += `🌐 [فتح النتائج في Google](${result.resultUrl})`;

        await bot.sendMessage(chatId, message, { 
          parse_mode: 'Markdown',
          disable_web_page_preview: true 
        });

        if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
          await bot.sendPhoto(chatId, result.screenshotPath, {
            caption: '📸 سكرين شوت لنتائج البحث'
          });
          fs.unlinkSync(result.screenshotPath);
        }

      } else {
        await bot.sendMessage(chatId, `❌ خطأ: ${result.error}\n\nجرب صورة ثانية.`);
      }

      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);

    } catch (error) {
      console.error('Error:', error.message);
      await bot.sendMessage(chatId, `❌ حدث خطأ: ${error.message}\n\nجرب مرة ثانية.`);
    }
  });

  console.log('Bot started!');
}

// Keep alive
setInterval(() => {
  console.log('Alive:', new Date().toISOString());
}, 60000);

process.on('unhandledRejection', (err) => console.error('Unhandled:', err.message));
process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));

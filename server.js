const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '8737255406:AAGDfuIznZb3zjVV3Px0d6M4g4jjiRtm9gM';

// Start Express first
app.get('/', (req, res) => res.send('Lens Bot is running!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startBot();
});

// ===== Upload image to get public URL =====
async function uploadImage(imagePath) {
  // Upload to 0x0.st (free, no API key needed)
  const form = new FormData();
  form.append('file', fs.createReadStream(imagePath));
  
  try {
    const response = await axios.post('https://0x0.st', form, {
      headers: form.getHeaders(),
      timeout: 15000
    });
    return response.data.trim();
  } catch (e) {
    // Fallback: upload to litterbox (temp file host)
    const form2 = new FormData();
    form2.append('reqtype', 'fileupload');
    form2.append('time', '1h');
    form2.append('fileToUpload', fs.createReadStream(imagePath));
    
    const response2 = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form2, {
      headers: form2.getHeaders(),
      timeout: 15000
    });
    return response2.data.trim();
  }
}

// ===== Yandex Reverse Image Search =====
async function searchYandex(imagePath) {
  let browser;
  try {
    // First upload the image to get a public URL
    const imageUrl = await uploadImage(imagePath);
    console.log('Image uploaded:', imageUrl);

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

    // Use Yandex reverse image search URL directly
    const yandexUrl = `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(imageUrl)}`;
    console.log('Searching:', yandexUrl);

    await page.goto(yandexUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));

    // Extract results
    const results = await page.evaluate(() => {
      let data = {
        title: '',
        descriptions: [],
        similarSites: [],
        tags: []
      };

      // Get page title or main description
      const titles = document.querySelectorAll('.CbirObjectResponse-Title, .CbirItem-Title, h2, .MMViewerButtons-TextContainer');
      titles.forEach(el => {
        const text = el.textContent.trim();
        if (text.length > 3 && text.length < 200) {
          data.title = text;
        }
      });

      // Get tags/categories
      const tags = document.querySelectorAll('.CbirTags-Tag, .Tags-Tag, .CbirItem-Tag, a[class*="Tag"]');
      tags.forEach(el => {
        const text = el.textContent.trim();
        if (text.length > 1 && text.length < 50) {
          data.tags.push(text);
        }
      });

      // Get descriptions from similar images
      const descriptions = document.querySelectorAll('.CbirSites-ItemTitle, .CbirItem-Title, .CbirSites-ItemDescription, .Thumb-Title, [class*="Description"]');
      descriptions.forEach((el, i) => {
        if (i < 8) {
          const text = el.textContent.trim();
          if (text.length > 5 && text.length < 300) {
            data.descriptions.push(text);
          }
        }
      });

      // Get similar sites/sources
      const sites = document.querySelectorAll('.CbirSites-Item a, .CbirSites-ItemDomain');
      sites.forEach((el, i) => {
        if (i < 5) {
          const text = el.textContent.trim();
          const href = el.href || '';
          if (text.length > 3) {
            data.similarSites.push({ text: text.substring(0, 100), url: href });
          }
        }
      });

      // Also try to get "Other sizes" or "Pages with this image"
      const otherResults = document.querySelectorAll('.other-sites__item-title, .CbirOtherSizes-Item, a[class*="Site"]');
      otherResults.forEach((el, i) => {
        if (i < 5) {
          const text = el.textContent.trim();
          const href = el.href || '';
          if (text.length > 3) {
            data.similarSites.push({ text: text.substring(0, 100), url: href });
          }
        }
      });

      // Get any text that looks like a location or place name
      const allText = document.body.innerText;
      const lines = allText.split('\n').filter(l => l.trim().length > 10 && l.trim().length < 150);
      const locationHints = lines.filter(l => 
        /hotel|resort|park|palace|museum|city|pool|swim|beach|tower|bridge|mosque|church/i.test(l) ||
        /فندق|منتجع|حديقة|قصر|متحف|مدينة|مسبح|شاطئ|برج|جسر|مسجد/i.test(l)
      );
      if (locationHints.length > 0) {
        data.descriptions = [...locationHints.slice(0, 3), ...data.descriptions];
      }

      return data;
    });

    // Take screenshot of results
    const screenshotPath = imagePath.replace('.jpg', '_results.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const resultUrl = page.url();
    await browser.close();

    return {
      success: true,
      resultUrl,
      imageUrl,
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
`🔍 *بوت البحث بالصور*

أرسل لي أي صورة وأبحث لك عنها!

📸 أرسل صورة مكان (قصر، حديقة، شارع، مبنى، مسبح)
🔎 أبحث لك في Yandex وأحاول أعرف وين الموقع
📋 أرجع لك النتائج + سكرين شوت

*الاستخدام:* ارسل صورة وانتظر (15-30 ثانية)`, {
      parse_mode: 'Markdown'
    });
  });

  // Handle photos
  bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;

    try {
      await bot.sendMessage(chatId, '🔍 جاري البحث... انتظر 15-30 ثانية');

      // Get highest resolution photo
      const photo = msg.photo[msg.photo.length - 1];
      const file = await bot.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const imagePath = `/tmp/lens_${chatId}_${Date.now()}.jpg`;
      fs.writeFileSync(imagePath, response.data);

      // Search
      const result = await searchYandex(imagePath);

      if (result.success) {
        let message = '🔍 *نتائج البحث:*\n\n';

        if (result.results.title) {
          message += `📌 *${result.results.title}*\n\n`;
        }

        if (result.results.tags.length > 0) {
          const uniqueTags = [...new Set(result.results.tags)].slice(0, 5);
          message += `🏷 *تصنيفات:* ${uniqueTags.join(' | ')}\n\n`;
        }

        if (result.results.descriptions.length > 0) {
          message += '📋 *معلومات:*\n';
          const uniqueDescs = [...new Set(result.results.descriptions)].slice(0, 4);
          uniqueDescs.forEach(desc => {
            message += `• ${desc}\n`;
          });
          message += '\n';
        }

        if (result.results.similarSites.length > 0) {
          message += '🔗 *مصادر:*\n';
          const uniqueSites = result.results.similarSites.slice(0, 3);
          uniqueSites.forEach(site => {
            if (site.url && site.url.startsWith('http')) {
              message += `• [${site.text}](${site.url})\n`;
            } else {
              message += `• ${site.text}\n`;
            }
          });
          message += '\n';
        }

        message += `🌐 [فتح النتائج كاملة](${result.resultUrl})`;

        await bot.sendMessage(chatId, message, { 
          parse_mode: 'Markdown',
          disable_web_page_preview: true 
        });

        // Send screenshot
        if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
          await bot.sendPhoto(chatId, result.screenshotPath, {
            caption: '📸 سكرين شوت لنتائج البحث'
          });
          fs.unlinkSync(result.screenshotPath);
        }

      } else {
        await bot.sendMessage(chatId, `❌ خطأ: ${result.error}\n\nجرب صورة ثانية.`);
      }

      // Cleanup
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);

    } catch (error) {
      console.error('Error:', error.message);
      await bot.sendMessage(chatId, `❌ حدث خطأ: ${error.message}\n\nجرب مرة ثانية.`);
    }
  });

  // Handle documents (images as files)
  bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const doc = msg.document;

    if (!doc.mime_type || !doc.mime_type.startsWith('image/')) {
      return bot.sendMessage(chatId, '❌ أرسل صورة فقط.');
    }

    try {
      await bot.sendMessage(chatId, '🔍 جاري البحث... انتظر 15-30 ثانية');

      const file = await bot.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const imagePath = `/tmp/lens_${chatId}_${Date.now()}.jpg`;
      fs.writeFileSync(imagePath, response.data);

      const result = await searchYandex(imagePath);

      if (result.success) {
        let message = '🔍 *نتائج البحث:*\n\n';

        if (result.results.title) {
          message += `📌 *${result.results.title}*\n\n`;
        }

        if (result.results.tags.length > 0) {
          const uniqueTags = [...new Set(result.results.tags)].slice(0, 5);
          message += `🏷 *تصنيفات:* ${uniqueTags.join(' | ')}\n\n`;
        }

        if (result.results.descriptions.length > 0) {
          message += '📋 *معلومات:*\n';
          const uniqueDescs = [...new Set(result.results.descriptions)].slice(0, 4);
          uniqueDescs.forEach(desc => {
            message += `• ${desc}\n`;
          });
          message += '\n';
        }

        if (result.results.similarSites.length > 0) {
          message += '🔗 *مصادر:*\n';
          const uniqueSites = result.results.similarSites.slice(0, 3);
          uniqueSites.forEach(site => {
            if (site.url && site.url.startsWith('http')) {
              message += `• [${site.text}](${site.url})\n`;
            } else {
              message += `• ${site.text}\n`;
            }
          });
          message += '\n';
        }

        message += `🌐 [فتح النتائج كاملة](${result.resultUrl})`;

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

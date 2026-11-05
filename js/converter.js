    class UserError extends Error {}

    // События о ходе конвертации наружу. Слушателя может не быть — тогда ничего не происходит
    function emit(name, detail) {
      document.dispatchEvent(new CustomEvent('converter:' + name, { detail }));
    }

    const VALID_STATUSES = new Set(['Completed', 'Watching', 'On-Hold', 'Dropped', 'Plan to Watch']);
    const JSON_STATUS_MAP = {
      completed: 'Completed',
      watching: 'Watching',
      on_hold: 'On-Hold',
      dropped: 'Dropped',
      planned: 'Plan to Watch',
    };

    const state = { entries: [], skipped: [], format: null };

    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('fileInput');
    const alertError = document.getElementById('alertError');
    const result = document.getElementById('result');
    const summaryBar = document.getElementById('summaryBar');
    const previewBody = document.getElementById('previewBody');
    const downloadBtn = document.getElementById('downloadBtn');
    const resetBtn = document.getElementById('resetBtn');
    const mainStatus = document.getElementById('mainStatus');

    const anixartConsent = document.getElementById('anixartConsent');
    const anixartRowCount = document.getElementById('anixartRowCount');
    const anixartSkippedNote = document.getElementById('anixartSkippedNote');
    const anixartSkippedCount = document.getElementById('anixartSkippedCount');
    const anixartSkippedList = document.getElementById('anixartSkippedList');
    const anixartStartBtn = document.getElementById('anixartStartBtn');
    const anixartCancelBtn = document.getElementById('anixartCancelBtn');
    const anixartProgress = document.getElementById('anixartProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const progressSubtext = document.getElementById('progressSubtext');
    const anixartReview = document.getElementById('anixartReview');
    const shikimoriErrorAlert = document.getElementById('shikimoriErrorAlert');
    const anixartSummary = document.getElementById('anixartSummary');
    const reviewMulti = document.getElementById('reviewMulti');
    const reviewMultiBody = document.getElementById('reviewMultiBody');
    const reviewDuplicates = document.getElementById('reviewDuplicates');
    const reviewDuplicatesBody = document.getElementById('reviewDuplicatesBody');
    const reviewUnresolved = document.getElementById('reviewUnresolved');
    const reviewUnresolvedBody = document.getElementById('reviewUnresolvedBody');
    const reviewBackBtn = document.getElementById('reviewBackBtn');
    const reviewNextBtn = document.getElementById('reviewNextBtn');
    const downloadUnresolvedBtn = document.getElementById('downloadUnresolvedBtn');
    const anixartConfirmBtn = document.getElementById('anixartConfirmBtn');
    const anixartRestartBtn = document.getElementById('anixartRestartBtn');

    function escapeHtml(str) {
      return String(str ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function cdata(str) {
      return '<![CDATA[' + String(str ?? '').replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
    }

    // ---- Разбор источников ----

    function sniffFormat(text) {
      if (text.startsWith('<')) {
        // Отличаем HTML по DOCTYPE <html>.
        if (/^<!doctype\s+html/i.test(text) || /^<html[\s>]/i.test(text)) {
          const doc = new DOMParser().parseFromString(text, 'text/html');
          if (doc.querySelector('li[data-shiki-id]')) {
            return { format: 'yummy-html', raw: doc };
          }
          throw new UserError('Не удалось распознать формат файла.');
        }
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.querySelector('parsererror')) {
          throw new UserError('Файл повреждён или содержит некорректный XML.');
        }
        if (doc.querySelector('myanimelist > anime')) {
          return { format: 'xml', raw: doc };
        }
        throw new UserError('Не удалось распознать формат файла.');
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new UserError('Не удалось распознать формат файла.');
      }
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
        // Отличаем YummyAnime по наличию поля "ya_id"
        if ('ya_id' in data[0]) {
          return { format: 'yummy-json', raw: data };
        }
        if ('target_id' in data[0]) {
          return { format: 'json', raw: data };
        }
      }
      throw new UserError('Не удалось распознать формат файла.');
    }

    function parseShikimoriXml(doc) {
      const entries = [];
      const skipped = [];
      for (const el of doc.querySelectorAll('myanimelist > anime')) {
        const text = tag => el.querySelector(tag)?.textContent ?? '';
        const id = Number(text('series_animedb_id'));
        const title = text('series_title');
        const status = text('my_status');
        if (!id) {
          skipped.push({ title: title || '(без названия)', reason: 'нет series_animedb_id' });
          continue;
        }
        if (!VALID_STATUSES.has(status)) {
          skipped.push({ title, reason: `неизвестный статус: ${status || '(пусто)'}` });
          continue;
        }
        entries.push({
          id,
          title,
          watchedEpisodes: Number(text('my_watched_episodes')) || 0,
          score: Number(text('my_score')) || 0,
          status,
          comments: text('my_comments'),
          timesWatched: Number(text('my_times_watched')) || 0,
        });
      }
      return { entries, skipped };
    }

    function parseShikimoriJson(arr) {
      const entries = [];
      const skipped = [];
      for (const item of arr) {
        const id = Number(item.target_id);
        const title = item.target_title ?? '';
        if (!id) {
          skipped.push({ title: title || '(без названия)', reason: 'нет target_id' });
          continue;
        }
        const status = JSON_STATUS_MAP[item.status];
        if (!status) {
          skipped.push({ title, reason: `неизвестный статус: ${item.status || '(пусто)'}` });
          continue;
        }
        entries.push({
          id,
          title,
          watchedEpisodes: Number(item.episodes) || 0,
          score: Number(item.score) || 0,
          status,
          comments: item.text || '',
          timesWatched: Number(item.rewatches) || 0,
        });
      }
      return { entries, skipped };
    }

    // ---- Разбор YummyAnime HTML ----

    // Статус определяется колонкой таблицы (заголовок <h3>)
    // "Любимое" игноируем - доп. метка, не статус
    const YUMMY_HTML_STATUS_MAP = {
      'Смотрю': 'Watching',
      'В планах': 'Plan to Watch',
      'Просмотрено': 'Completed',
      'Брошено': 'Dropped',
      'Отложено': 'On-Hold',
    };

    function parseYummyHtml(doc) {
      const entries = [];
      const skipped = [];
      for (const td of doc.querySelectorAll('table td[data-list-id]')) {
        const heading = td.querySelector('h3')?.textContent.trim() ?? '';
        const status = YUMMY_HTML_STATUS_MAP[heading];
        if (!status) continue;
        for (const li of td.querySelectorAll('li[data-shiki-id]')) {
          const id = Number(li.dataset.shikiId);
          const title = li.childNodes[0]?.textContent?.trim() ?? '';
          if (!id) {
            skipped.push({ title: title || '(без названия)', reason: 'нет data-shiki-id' });
            continue;
          }
          entries.push({
            id,
            title,
            watchedEpisodes: 0,
            score: Number(li.dataset.vote) || 0,
            status,
            comments: '',
            timesWatched: 0,
          });
        }
      }
      return { entries, skipped };
    }

    // ---- Разбор Anixart CSV ----

    const ANIXART_STATUS_MAP = {
      'Смотрю': 'Watching',
      'В планах': 'Plan to Watch',
      'Просмотрено': 'Completed',
      'Брошено': 'Dropped',
      'Отложено': 'On-Hold',
    };

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Ждём посекундно и сообщаем оставшееся время
    async function sleepWithCountdown(totalSeconds, onTick) {
      for (let left = totalSeconds; left > 0; left--) {
        if (onTick) onTick(left);
        await sleep(1000);
      }
    }

    // Очиащем от пробелов, чтобы не иметь проблем с отличием названий на Shiki/Anixart и AL
    // ("Ao Ashi" / "Aoashi", "Kakegurui××" / "Kakegurui ××").
    function normalizeTitle(s) {
      return String(s ?? '').toLowerCase().normalize('NFKC').replace(/\s+/g, '');
    }

    // Заменяем кириллицу на латиницу в заведомо не-кирилических названиях
    // (У Anixart в "Madoka Magiсa" вылезла кириллическая "с".
    const CYRILLIC_LOOKALIKES = { а: 'a', с: 'c', е: 'e', о: 'o', р: 'p', х: 'x', у: 'y', А: 'A', С: 'C', Е: 'E', О: 'O', Р: 'P', Х: 'X', У: 'Y' };

    // Берём из AltTitlesБерём первое латинское название
    const CYRILLIC_RE = /[Ѐ-ӿ]/;
    function firstLatinAltTitle(altTitles) {
      return altTitles.find(t => !CYRILLIC_RE.test(t));
    }

    // Если первое латинское название не дало результат, ищем по второму
    function secondLatinAltTitle(altTitles) {
      return altTitles.filter(t => !CYRILLIC_RE.test(t))[1];
    }

    // Убираем упоминание формата из названия: у Shiki/Anixart и AL почти никогда не совпадают
    function stripFormatWords(s) {
      return String(s ?? '')
        .replace(/^(?:Gekijouban|Eiga)\s+/i, '')
        .replace(/\s+Movie\s*:/i, ':')
        .replace(/\s+Movie\s*$/i, '')
        .replace(/\s+Remake\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Для названий типа SPY×FAMILY пробуем поиск с символом «Косой крестик» вместо буквы X
    function xToTimesSign(s) {
      return /\sx\s/i.test(s) ? String(s).replace(/\sx\s/gi, '×') : null;
    }

    // Заменяем номер сезона со слова на число с суффиксом
    const ORDINAL_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
    function spelledOrdinalToNumeral(s) {
      return String(s ?? '').replace(/\b(First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth)(\s*Season)\b/gi,
        (m, word, seasonPart) => { const n = ORDINAL_WORDS[word.toLowerCase()]; return `${n}${ordinalSuffix(n)}${seasonPart}`; });
    }

    // Готовим строку для поиска на AniList: убираем кириллицу,
    // гравис/акут вместо апострофа и лишние пробелы. 
    // Настоящий апостроф «’» бывает у тайтлов типа Gintama,
    // гравис/акут пока на AL не встречался
    function sanitizeSearchTitle(s) {
      return fixOrdinalSuffix(String(s ?? '')
        .replace(/[асеорхуАСЕОРХУ]/g, c => CYRILLIC_LOOKALIKES[c] || c)
        .replace(/[`´]/g, '')
        .replace(/\s+/g, ' ')
        .trim());
    }

    // Запасной вариант: убираем апостроф, если поиск с ним не дал результатов
    function sanitizeSearchTitleNoApostrophe(s) {
      return sanitizeSearchTitle(s).replace(/[’‘']/g, '').replace(/\s+/g, ' ').trim();
    }

    // Anixart иногда добавляет "TV-2"/"ТВ-3" для сезонов, заменяем под формат AniList
    function stripSeasonSuffix(s) {
      const m = String(s ?? '').match(/^(.*?)\s+(?:TV|ТВ)[-\s]?(\d+)$/i);
      return m ? { base: m[1].trim(), num: m[2] } : null;
    }

    function ordinalSuffix(n) {
      const mod100 = n % 100;
      return (mod100 >= 11 && mod100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    }

    // AniList романизирует сезоны как «Season N» или «Nth Season», пробуем искать с ними
    function ordinalSeason(num) {
      const n = Number(num);
      return `${n}${ordinalSuffix(n)} Season`;
    }

    // AniList не фильтрует поиск по номеру сезона - проверяем уже после
    // получения результатов
    function seasonNumberPatterns(num) {
      const n = Number(num);
      const patterns = [new RegExp(`\\bseason\\s*${n}\\b`, 'i'), new RegExp(`\\b${n}${ordinalSuffix(n)}\\s*season\\b`, 'i')];
      const roman = { 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII', 9: 'IX' }[n];
      if (roman) patterns.push(new RegExp(`\\b${roman}\\b`));
      return patterns;
    }

    function narrowCandidatesBySeasonNumber(candidates, num) {
      const patterns = seasonNumberPatterns(num);
      const matches = candidates.filter(c => [c.title.romaji, c.title.english].filter(Boolean).some(t => patterns.some(p => p.test(t))));
      return matches.length === 1 ? matches[0] : null;
    }

    // Декоративные символы типа «Madoka☆Magica» не трогаем
    const DECORATIVE_SYMBOLS_RE = /[☆★✩✰♪♫♥❤]/g;
    function stripDecorative(s) {
      return String(s ?? '').replace(DECORATIVE_SYMBOLS_RE, '');
    }
    function narrowCandidatesByOriginalTitle(origTitle, candidates) {
      const norm = normalizeTitle(stripDecorative(sanitizeSearchTitle(origTitle)));
      const matches = candidates.filter(c => [c.title.romaji, c.title.english].filter(Boolean).some(t => normalizeTitle(stripDecorative(t)) === norm));
      return matches.length === 1 ? matches[0] : null;
    }

    // Anixart иногда путает суффикс числительного («3nd Season» вместо «3rd Season») - чиним
    function fixOrdinalSuffix(s) {
      return String(s ?? '').replace(/(\d+)(?:st|nd|rd|th)\b/gi, (_, num) => `${num}${ordinalSuffix(Number(num))}`);
    }

    // AltTitles иногда содержит незаэкранированные кавычки — берём это поле как всё, что
    // между OrigTitle и двумя последними полями (Favorite, Status).
    function parseAnixartLine(line) {
      const m = line.match(/^(\d+),/);
      if (!m) return null;
      let rest = line.slice(m[0].length);

      function takeQuotedOrPlainField(str) {
        if (str[0] === '"') {
          let i = 1;
          while (i < str.length && !(str[i] === '"' && (str[i + 1] === ',' || str[i + 1] === undefined))) i++;
          return [str.slice(1, i), str.slice(i + 2)];
        }
        const idx = str.indexOf(',');
        return idx === -1 ? [str, ''] : [str.slice(0, idx), str.slice(idx + 1)];
      }

      const [ruTitle, r1] = takeQuotedOrPlainField(rest);
      const [origTitle, r2] = takeQuotedOrPlainField(r1);

      const lastComma = r2.lastIndexOf(',');
      if (lastComma === -1) return null;
      const status = r2.slice(lastComma + 1);
      const beforeStatus = r2.slice(0, lastComma);
      const secondLastComma = beforeStatus.lastIndexOf(',');
      if (secondLastComma === -1) return null;
      const favorite = beforeStatus.slice(secondLastComma + 1);
      let altTitlesRaw = beforeStatus.slice(0, secondLastComma);
      if (altTitlesRaw.startsWith('"') && altTitlesRaw.endsWith('"')) altTitlesRaw = altTitlesRaw.slice(1, -1);

      return { ruTitle, origTitle, altTitlesRaw, favorite, status };
    }

    // AltTitles иногда содержит перевод строки внутри кавычек
    // («LINK CLICK\n, Shi Guang...»), что ломает парсер
    // Склеиваем физические строки обратно, пока число кавычек в буфере нечётное.
    function splitAnixartCsvRecords(text) {
      const rawLines = text.split(/\r?\n/);
      const records = [];
      let buf = null;
      for (const line of rawLines) {
        buf = buf === null ? line : buf + '\n' + line;
        const quoteCount = (buf.match(/"/g) || []).length;
        if (quoteCount % 2 === 0) {
          records.push(buf);
          buf = null;
        }
      }
      if (buf !== null) records.push(buf);
      return records.filter(l => l.trim() !== '');
    }

    function parseAnixartCsv(text) {
      const lines = splitAnixartCsvRecords(text);
      const dataLines = lines.slice(1);
      const rows = [];
      const skipped = [];
      dataLines.forEach((line, i) => {
        const p = parseAnixartLine(line);
        if (!p) { skipped.push({ title: `(строка ${i + 2})`, reason: 'не удалось разобрать строку CSV' }); return; }
        const title = p.origTitle.trim() || p.ruTitle.trim();
        const status = ANIXART_STATUS_MAP[p.status.trim()];
        if (!status) { skipped.push({ title, reason: `неизвестный статус: ${p.status.trim() || '(пусто)'}` }); return; }
        const altRaw = p.altTitlesRaw.trim();
        const altTitles = altRaw && altRaw !== 'Не указаны' ? altRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
        rows.push({ ruTitle: p.ruTitle.trim(), origTitle: p.origTitle.trim(), altTitles, status });
      });
      return { rows, skipped };
    }

    // ---- Поиск ID на AniList ----

    const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
    const ANILIST_BATCH_SIZE = 20;

    // Shikimori принимает GraphQL-запросы без авторизации, хоть документация и запрещает «имитацию браузера»
    // Ну, мы и не имитируем )))
    const SHIKIMORI_ENDPOINT = 'https://shikimori.io/api/graphql';
    const SHIKIMORI_BATCH_SIZE = 20;

    // Shikimori заявляет лимит 5rps/90rpm. Ждём между запросами
    const SHIKIMORI_MIN_INTERVAL_MS = 700;
    let shikimoriLastRequestAt = 0;
    async function shikimoriThrottle() {
      const wait = shikimoriLastRequestAt + SHIKIMORI_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      shikimoriLastRequestAt = Date.now();
    }

    async function searchAnilistBatch(titles, perPage = 5, onCooldown) {
      const parts = titles.map((t, i) => `m${i}: Page(perPage: ${perPage}) { media(search: $s${i}, type: ANIME) { id idMal title { romaji english } format episodes } }`);
      const varsDecl = titles.map((t, i) => `$s${i}: String`).join(', ');
      const query = `query (${varsDecl}) { ${parts.join(' ')} }`;
      const variables = {};
      titles.forEach((t, i) => { variables['s' + i] = t; });

      for (let attempt = 0; ; attempt++) {
        const res = await fetch(ANILIST_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query, variables }),
        });
        if (res.status === 429) {
          if (attempt >= 5) throw new UserError('AniList не отвечает (слишком много запросов). Попробуйте позже.');
          const retryAfter = Number(res.headers.get('retry-after')) || 5;
          await sleepWithCountdown(retryAfter + 1, left => onCooldown?.('AniList ограничил частоту запросов — повтор через', left));
          continue;
        }
        const remaining = Number(res.headers.get('x-ratelimit-remaining'));
        let json;
        try { json = await res.json(); } catch { throw new UserError('AniList вернул некорректный ответ.'); }
        if (!json.data) throw new UserError('Не удалось получить ответ от AniList.');
        return { json, remaining };
      }
    }

    function decideMatch(searchTitle, candidates) {
      const norm = normalizeTitle(searchTitle);
      const exact = candidates.filter(c => normalizeTitle(c.title.romaji) === norm || normalizeTitle(c.title.english || '') === norm);
      if (exact.length === 1) return { candidates, chosen: exact[0], auto: true };
      return { candidates, chosen: candidates[0] || null, auto: false };
    }

    function shikimoriCandidateToMatchShape(c) {
      return { idMal: Number(c.malId), title: { romaji: c.name, english: c.russian || null }, format: c.kind ? c.kind.toUpperCase() : null, episodes: c.episodes };
    }

    // Shikimori не отдаёт x-ratelimit-remaining, как это делает от AniList
    // Если словили 429, ждём Retry-After и пробуем ещё раз
    async function searchShikimoriBatch(titles, limit = 5, onCooldown) {
      const parts = titles.map((t, i) => `m${i}: animes(search: $s${i}, limit: ${limit}) { malId name russian kind episodes status }`);
      const varsDecl = titles.map((t, i) => `$s${i}: String`).join(', ');
      const query = `query (${varsDecl}) { ${parts.join(' ')} }`;
      const variables = {};
      titles.forEach((t, i) => { variables['s' + i] = t; });

      for (let attempt = 0; ; attempt++) {
        await shikimoriThrottle();
        const res = await fetch(SHIKIMORI_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query, variables }),
        });
        if (res.status === 429) {
          if (attempt >= 5) throw new Error('Shikimori не отвечает (слишком много запросов, HTTP 429)');
          const retryAfter = Number(res.headers.get('retry-after')) || 5;
          await sleepWithCountdown(retryAfter + 1, left => onCooldown?.('Shikimori ограничил частоту запросов — повтор через', left));
          continue;
        }
        if (!res.ok) throw new Error(`Shikimori HTTP ${res.status}`);
        let json;
        try { json = await res.json(); } catch { throw new Error('Shikimori вернул некорректный ответ.'); }
        if (!json.data) throw new Error('Shikimori: пустой ответ.');
        return json.data;
      }
    }

    // Anixart дописывает суффиксы «ТВ-N» и «TV-N» - на Shikimori их нет
    // Срезаем заранее — как и с AniList, номер сезона  не участвует в запросе
    function shikimoriSearchTitleFor(row) {
      const stripped = stripSeasonSuffix(row.ruTitle);
      return stripped ? stripped.base : row.ruTitle;
    }

    // Русские названия у Anixart почти всегда совпадают с Shikimori дословно —
    // сначала проверяем через Shiki, оставшееся ищем через AniList
    async function runShikimoriSearchPass(rows, indices, results, onStatus) {
      const total = indices.length;
      let failedTitles = 0;
      let notFoundTitles = 0;
      let lastError = null;
      const label = 'Ищем по русскому названию (Шикимори)';
      for (let i = 0; i < indices.length; i += SHIKIMORI_BATCH_SIZE) {
        const chunk = indices.slice(i, i + SHIKIMORI_BATCH_SIZE);
        const chunkTitles = chunk.map(idx => shikimoriSearchTitleFor(rows[idx]));
        try {
          const data = await searchShikimoriBatch(chunkTitles, 5,
            (cooldownLabel, left) => onStatus({ label, cooldownLabel, cooldown: left }));
          chunk.forEach((idx, j) => {
            const candidates = (data['m' + j] ?? []).filter(c => c.malId).map(shikimoriCandidateToMatchShape);
            if (candidates.length === 0) {
              notFoundTitles++;
              results[idx] = { candidates: [], chosen: null, auto: false };
            } else {
              results[idx] = decideMatch(chunkTitles[j], candidates);
            }
          });
        } catch (err) {
          console.warn('Shikimori: батч не отвечен, пропускаем (эти строки попадут в поиск AniList):', err);
          failedTitles += chunk.length;
          lastError = err instanceof Error ? err.message : String(err);
        }
        onStatus({ label, done: Math.min(i + chunk.length, total), total });
      }
      return { failedTitles, notFoundTitles, totalTitles: total, lastError };
    }

    // Прогоняем поиск батчами по подмножеству строк и сообщаем прогресс текущего прохода
    async function runSearchPass(rows, indices, results, searchStringFor, perPage, label, onStatus) {
      const total = indices.length;
      for (let i = 0; i < indices.length; i += ANILIST_BATCH_SIZE) {
        const chunk = indices.slice(i, i + ANILIST_BATCH_SIZE);
        const chunkTitles = chunk.map(idx => searchStringFor(rows[idx]));
        const { json, remaining } = await searchAnilistBatch(chunkTitles, perPage,
          (cooldownLabel, left) => onStatus({ label, cooldownLabel, cooldown: left }));
        chunk.forEach((idx, j) => {
          const candidates = (json.data['m' + j]?.media ?? []).filter(c => c.idMal);
          if (candidates.length > 0) results[idx] = decideMatch(chunkTitles[j], candidates);
          else if (!results[idx]) results[idx] = { candidates: [], chosen: null, auto: false };
        });
        onStatus({ label, done: Math.min(i + chunk.length, total), total });
        if (!Number.isNaN(remaining) && remaining <= 2) {
          await sleepWithCountdown(15, left =>
            onStatus({ label, cooldownLabel: 'Бережём лимит запросов AniList — продолжим через', cooldown: left }));
        }
      }
    }

    async function runAnixartSearch(rows, onStatus) {
      const results = new Array(rows.length);
      const allIdx = rows.map((_, idx) => idx);

      // Автоматически принимаем только точное совпадение исходного названия. 
      // Всё найденное с помощью фильтров - на ручную проверку
      const forceManualReview = (indices) => {
        indices.forEach(idx => { if (results[idx].auto) results[idx] = { ...results[idx], auto: false }; });
      };

      // shikimoriStats храним всегда, в том числе при успехе — иначе нет знаменателя
      // для доли откатов на AniList. shikimoriError — производная, только для плашки
      let shikimoriError = null;
      let shikimoriStats = null;
      const idxWithRu = allIdx.filter(idx => rows[idx].ruTitle);
      if (idxWithRu.length > 0) {
        shikimoriStats = await runShikimoriSearchPass(rows, idxWithRu, results, onStatus);
        if (shikimoriStats.failedTitles > 0 || shikimoriStats.notFoundTitles > 0) {
          shikimoriError = shikimoriStats;
        }
      }

      const idxAfterShikimori = allIdx.filter(idx => !results[idx]?.auto);
      await runSearchPass(rows, idxAfterShikimori, results, r => sanitizeSearchTitle(r.origTitle), 5, 'Ищем по названию', onStatus);

      const idxNoMatch0 = allIdx.filter(idx => results[idx].candidates.length === 0 && sanitizeSearchTitleNoApostrophe(rows[idx].origTitle) !== sanitizeSearchTitle(rows[idx].origTitle));
      if (idxNoMatch0.length > 0) {
        await runSearchPass(rows, idxNoMatch0, results, r => sanitizeSearchTitleNoApostrophe(r.origTitle), 5, 'Пробуем без апострофа', onStatus);
        forceManualReview(idxNoMatch0);
      }

      const idxNoMatch1 = allIdx.filter(idx => results[idx].candidates.length === 0 && firstLatinAltTitle(rows[idx].altTitles));
      if (idxNoMatch1.length > 0) {
        await runSearchPass(rows, idxNoMatch1, results, r => sanitizeSearchTitle(firstLatinAltTitle(r.altTitles)), 5, 'Ищем по альтернативному названию', onStatus);
        forceManualReview(idxNoMatch1);
      }

      const seasonRows = allIdx.filter(idx => {
        if (results[idx].auto) return false;
        return !!stripSeasonSuffix(sanitizeSearchTitle(rows[idx].origTitle));
      });
      if (seasonRows.length > 0) {
        await runSearchPass(rows, seasonRows, results, r => {
          const s = stripSeasonSuffix(sanitizeSearchTitle(r.origTitle));
          return `${s.base} Season ${s.num}`;
        }, 5, 'Уточняем номер сезона', onStatus);
        forceManualReview(seasonRows);
      }

      const seasonRowsNoMatch = seasonRows.filter(idx => !results[idx].auto);
      if (seasonRowsNoMatch.length > 0) {
        await runSearchPass(rows, seasonRowsNoMatch, results, r => {
          const s = stripSeasonSuffix(sanitizeSearchTitle(r.origTitle));
          return `${s.base} ${ordinalSeason(s.num)}`;
        }, 5, 'Уточняем номер сезона (другая формулировка)', onStatus);
        forceManualReview(seasonRowsNoMatch);
      }

      const seasonRowsStillEmpty = seasonRows.filter(idx => results[idx].candidates.length === 0);
      if (seasonRowsStillEmpty.length > 0) {
        await runSearchPass(rows, seasonRowsStillEmpty, results, r => stripSeasonSuffix(sanitizeSearchTitle(r.origTitle)).base, 8, 'Ищем без номера сезона', onStatus);
        forceManualReview(seasonRowsStillEmpty);
      }

      const idxNoMatch2 = allIdx.filter(idx => results[idx].candidates.length === 0 && secondLatinAltTitle(rows[idx].altTitles));
      if (idxNoMatch2.length > 0) {
        await runSearchPass(rows, idxNoMatch2, results, r => sanitizeSearchTitle(secondLatinAltTitle(r.altTitles)), 5, 'Пробуем другое альтернативное название', onStatus);
        forceManualReview(idxNoMatch2);
      }

      const idxNoMatch3 = allIdx.filter(idx => {
        if (results[idx].candidates.length > 0) return false;
        const s = sanitizeSearchTitle(rows[idx].origTitle);
        return stripFormatWords(s) !== s;
      });
      if (idxNoMatch3.length > 0) {
        await runSearchPass(rows, idxNoMatch3, results, r => stripFormatWords(sanitizeSearchTitle(r.origTitle)), 5, 'Пробуем без служебных слов (Gekijouban/Movie/Remake)', onStatus);
        forceManualReview(idxNoMatch3);
      }

      const idxNoMatch3b = allIdx.filter(idx => {
        if (results[idx].candidates.length > 0) return false;
        const alt = firstLatinAltTitle(rows[idx].altTitles);
        if (!alt) return false;
        const s = sanitizeSearchTitle(alt);
        return stripFormatWords(s) !== s;
      });
      if (idxNoMatch3b.length > 0) {
        await runSearchPass(rows, idxNoMatch3b, results, r => stripFormatWords(sanitizeSearchTitle(firstLatinAltTitle(r.altTitles))), 5, 'Пробуем альт. название без служебных слов', onStatus);
        forceManualReview(idxNoMatch3b);
      }

      const idxNoMatch4 = allIdx.filter(idx => results[idx].candidates.length === 0 && xToTimesSign(sanitizeSearchTitle(rows[idx].origTitle)));
      if (idxNoMatch4.length > 0) {
        await runSearchPass(rows, idxNoMatch4, results, r => xToTimesSign(sanitizeSearchTitle(r.origTitle)), 5, 'Пробуем «×» вместо «x»', onStatus);
        forceManualReview(idxNoMatch4);
      }

      const idxNoMatch5 = allIdx.filter(idx => {
        if (results[idx].candidates.length > 0) return false;
        const s = sanitizeSearchTitle(rows[idx].origTitle);
        return spelledOrdinalToNumeral(s) !== s;
      });
      if (idxNoMatch5.length > 0) {
        await runSearchPass(rows, idxNoMatch5, results, r => spelledOrdinalToNumeral(sanitizeSearchTitle(r.origTitle)), 5, 'Пробуем номер сезона числом вместо слова', onStatus);
        forceManualReview(idxNoMatch5);
      }

      seasonRows.forEach(idx => {
        const r = results[idx];
        if (r.auto || r.candidates.length <= 1) return;
        const s = stripSeasonSuffix(sanitizeSearchTitle(rows[idx].origTitle));
        const narrowed = narrowCandidatesBySeasonNumber(r.candidates, s.num);
        if (narrowed) results[idx] = { candidates: [narrowed], chosen: narrowed, auto: false };
      });

      const stillAmbiguous = allIdx.filter(idx => !results[idx].auto && results[idx].candidates.length > 1 && firstLatinAltTitle(rows[idx].altTitles));
      if (stillAmbiguous.length > 0) {
        const label = 'Пробуем альтернативное название ещё раз';
        for (let i = 0; i < stillAmbiguous.length; i += ANILIST_BATCH_SIZE) {
          const chunk = stillAmbiguous.slice(i, i + ANILIST_BATCH_SIZE);
          const chunkTitles = chunk.map(idx => sanitizeSearchTitle(firstLatinAltTitle(rows[idx].altTitles)));
          const { json, remaining } = await searchAnilistBatch(chunkTitles, 5,
            (cooldownLabel, left) => onStatus({ label, cooldownLabel, cooldown: left }));
          chunk.forEach((idx, j) => {
            const candidates = (json.data['m' + j]?.media ?? []).filter(c => c.idMal);
            if (candidates.length === 0) return;
            const decided = decideMatch(chunkTitles[j], candidates);
            if (decided.auto) results[idx] = decided;
          });
          onStatus({ label, done: Math.min(i + chunk.length, stillAmbiguous.length), total: stillAmbiguous.length });
          if (!Number.isNaN(remaining) && remaining <= 2) {
            await sleepWithCountdown(15, left => onStatus({ label, cooldownLabel: 'Бережём лимит запросов AniList — продолжим через', cooldown: left }));
          }
        }
      }

      allIdx.forEach(idx => {
        const r = results[idx];
        if (r.auto || r.candidates.length <= 1) return;
        const narrowed = narrowCandidatesByOriginalTitle(rows[idx].origTitle, r.candidates);
        if (narrowed) results[idx] = { candidates: [narrowed], chosen: narrowed, auto: false };
      });

      return { results, shikimoriError, shikimoriStats };
    }

    function buildEntryFromAnixartMatch(row, match) {
      return {
        id: match.idMal,
        title: match.title.romaji || match.title.english || row.origTitle,
        watchedEpisodes: row.status === 'Completed' ? (match.episodes ?? 0) : 0,
        score: 0,
        status: row.status,
        comments: '',
        timesWatched: 0,
      };
    }

    // ---- Сборка MAL XML ----

    function buildTotals(entries) {
      const t = { Completed: 0, Watching: 0, 'On-Hold': 0, Dropped: 0, 'Plan to Watch': 0 };
      for (const e of entries) t[e.status]++;
      return t;
    }

    function buildMalXml(entries) {
      const t = buildTotals(entries);
      const lines = [];
      lines.push('<?xml version="1.0" encoding="UTF-8" ?>');
      lines.push('<myanimelist>');
      lines.push('\t<myinfo>');
      lines.push('\t\t<user_export_type>1</user_export_type>');
      lines.push(`\t\t<user_total_anime>${entries.length}</user_total_anime>`);
      lines.push(`\t\t<user_total_watching>${t.Watching}</user_total_watching>`);
      lines.push(`\t\t<user_total_completed>${t.Completed}</user_total_completed>`);
      lines.push(`\t\t<user_total_onhold>${t['On-Hold']}</user_total_onhold>`);
      lines.push(`\t\t<user_total_dropped>${t.Dropped}</user_total_dropped>`);
      lines.push(`\t\t<user_total_plantowatch>${t['Plan to Watch']}</user_total_plantowatch>`);
      lines.push('\t</myinfo>');
      for (const e of entries) {
        lines.push('\t<anime>');
        lines.push(`\t\t<series_animedb_id>${e.id}</series_animedb_id>`);
        lines.push(`\t\t<series_title>${cdata(e.title)}</series_title>`);
        lines.push(`\t\t<my_watched_episodes>${e.watchedEpisodes}</my_watched_episodes>`);
        lines.push('\t\t<my_start_date>0000-00-00</my_start_date>');
        lines.push('\t\t<my_finish_date>0000-00-00</my_finish_date>');
        lines.push(`\t\t<my_score>${e.score}</my_score>`);
        lines.push(`\t\t<my_status>${e.status}</my_status>`);
        lines.push(`\t\t<my_comments>${cdata(e.comments)}</my_comments>`);
        lines.push(`\t\t<my_times_watched>${e.timesWatched}</my_times_watched>`);
        lines.push('\t</anime>');
      }
      lines.push('</myanimelist>');
      return lines.join('\n');
    }

    // ---- UI ----

    function showError(message) {
      alertError.textContent = message;
      alertError.hidden = false;
      result.hidden = true;
      mainStatus.textContent = 'Не удалось обработать файл';
      emit('error', { message });
    }

    function resetUI() {
      alertError.hidden = true;
      alertError.textContent = '';
      result.hidden = true;
      anixartConsent.hidden = true;
      anixartProgress.hidden = true;
      anixartReview.hidden = true;
      dropzone.hidden = false;
      mainStatus.textContent = 'Выберите файл экспорта';
    }

    const FORMAT_LABEL = {
      xml: 'Шикимори XML',
      json: 'Шикимори JSON',
      'yummy-json': 'YummyAnime JSON',
      'yummy-html': 'YummyAnime HTML',
      anixart: 'Anixart (через Шикимори)',
    };

    function renderPreview() {
      dropzone.hidden = true;
      alertError.hidden = true;
      result.hidden = false;

      mainStatus.textContent = `${state.entries.length} записей · ${FORMAT_LABEL[state.format]}`;

      let summary = `<span class="count"><b>${state.entries.length}</b> записей распознано</span>`
        + `<span class="fmt-badge">${FORMAT_LABEL[state.format]}</span>`;
      if (state.skipped.length > 0) {
        const items = state.skipped.map(s => `<li>${escapeHtml(s.title)} — ${escapeHtml(s.reason)}</li>`).join('');
        summary += `<details class="skipped-details"><summary>Пропущено: ${state.skipped.length}</summary><ul>${items}</ul></details>`;
      }
      summaryBar.innerHTML = summary;

      previewBody.innerHTML = state.entries.map(e => `
        <tr>
          <td>${escapeHtml(e.title)}</td>
          <td>${escapeHtml(e.status)}</td>
          <td class="num">${e.score || '—'}</td>
          <td class="num">${e.watchedEpisodes}</td>
          <td class="comment" title="${escapeHtml(e.comments)}">${escapeHtml(e.comments)}</td>
        </tr>
      `).join('');

      downloadBtn.disabled = state.entries.length === 0;

      emit('converted', {
        format: state.format,
        entries: state.entries.length,
        skipped: state.skipped.length,
      });
    }

    function handleFile(file) {
      resetUI();
      const isCsv = file.name.toLowerCase().endsWith('.csv');
      // Только расширение: в имени файла может быть имя пользователя
      emit('upload', { ext: file.name.toLowerCase().split('.').pop() });
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = String(reader.result).replace(/^﻿/, '').trim();
          if (!text) throw new UserError('Файл пуст.');

          if (isCsv) {
            const { rows, skipped } = parseAnixartCsv(text);
            if (rows.length === 0) throw new UserError('В файле не найдено ни одной записи для конвертации.');
            startAnixartConsent(rows, skipped);
            return;
          }

          const { format, raw } = sniffFormat(text);
          const PARSERS = {
            xml: parseShikimoriXml,
            json: parseShikimoriJson,
            'yummy-json': parseShikimoriJson,
            'yummy-html': parseYummyHtml,
          };
          const { entries, skipped } = PARSERS[format](raw);
          if (entries.length === 0) throw new UserError('В файле не найдено ни одной записи для конвертации.');
          state.entries = entries;
          state.skipped = skipped;
          state.format = format;
          renderPreview();
        } catch (err) {
          showError(err instanceof UserError ? err.message : 'Не удалось распознать формат файла.');
        }
      };
      reader.onerror = () => showError('Не удалось прочитать файл.');
      reader.readAsText(file, 'utf-8');
    }

    let anixartState = null; // { rows, csvSkipped, results }

    function startAnixartConsent(rows, csvSkipped) {
      anixartState = { rows, csvSkipped, results: null };
      emit('anixart-parsed', { rows: rows.length, csvSkipped: csvSkipped.length });
      dropzone.hidden = true;
      anixartRowCount.textContent = rows.length;
      if (csvSkipped.length > 0) {
        anixartSkippedNote.hidden = false;
        anixartSkippedCount.textContent = csvSkipped.length;
        anixartSkippedList.innerHTML = csvSkipped.map(s => `<li>${escapeHtml(s.title)} — ${escapeHtml(s.reason)}</li>`).join('');
      } else {
        anixartSkippedNote.hidden = true;
      }
      anixartConsent.hidden = false;
    }

    async function runAnixartFlow() {
      anixartConsent.hidden = true;
      anixartProgress.hidden = false;
      progressFill.style.width = '0%';
      progressText.textContent = 'Ищем по русскому названию…';
      progressSubtext.hidden = true;

      // ---- Прогресс-бар ----
      function onStatus(status) {
        if (status.cooldown !== undefined) {
          progressSubtext.hidden = false;
          progressSubtext.textContent = `${status.cooldownLabel} ${status.cooldown} сек…`;
          return;
        }
        progressSubtext.hidden = true;
        progressFill.style.width = (status.total ? Math.round((status.done / status.total) * 100) : 100) + '%';
        progressText.textContent = `${status.label}… ${status.done} / ${status.total}`;
      }

      try {
        const { results, shikimoriError, shikimoriStats } = await runAnixartSearch(anixartState.rows, onStatus);
        anixartState.results = results;
        anixartState.shikimoriError = shikimoriError;
        anixartState.shikimoriStats = shikimoriStats;
        anixartProgress.hidden = true;
        renderAnixartReview();
      } catch (err) {
        anixartProgress.hidden = true;
        showError(err instanceof UserError ? err.message : 'Не удалось выполнить поиск в AniList.');
      }
    }

    // Обзор совпадений разбит на 3 шага:
    // 1. Однозначные случаи (только отметить ошибки)
    // 2. Выбор из нескольких вариантов 
    // 3. Не найденное
    // Однозначные совпадения (1 результат в выдаче) принимаются автоматически
    function renderAnixartReview() {
      const { rows, results } = anixartState;

      if (anixartState.shikimoriError) {
        const { failedTitles, notFoundTitles, totalTitles, lastError } = anixartState.shikimoriError;
        const parts = [];
        if (failedTitles > 0) {
          parts.push(failedTitles === totalTitles
            ? `поиск не сработал (${lastError})`
            : `поиск не сработал для ${failedTitles} из ${totalTitles} названий (${lastError})`);
        }
        if (notFoundTitles > 0) parts.push(`не найдено ${notFoundTitles} из ${totalTitles} названий`);
        shikimoriErrorAlert.textContent = `Шикимори: ${parts.join('; ')} — эти названия дополнительно проверены через AniList.`;
        shikimoriErrorAlert.className = failedTitles > 0 ? 'alert alert-error' : 'alert alert-info';
        shikimoriErrorAlert.hidden = false;
      } else {
        shikimoriErrorAlert.hidden = true;
      }

      const auto = [];
      const single = [];
      const multi = [];
      const notFound = [];
      results.forEach((r, idx) => {
        if (r.auto) auto.push({ row: rows[idx], idx, match: r.chosen });
        else if (r.candidates.length === 1) single.push({ row: rows[idx], idx, match: r.candidates[0] });
        else if (r.candidates.length > 1) multi.push({ row: rows[idx], idx, candidates: r.candidates });
        else notFound.push({ row: rows[idx], idx });
      });
      anixartState.auto = auto;
      anixartState.single = single;
      anixartState.multi = multi;
      anixartState.notFound = notFound;
      anixartState.skippedMultiIdx = new Set();
      anixartState.excludedIdx = new Set();

      // sh === null, если строк с русским названием не было и проход не запускался
      const sh = anixartState.shikimoriStats;
      emit('anixart-search', {
        total: results.length,
        shikimoriOk: sh ? sh.totalTitles - sh.failedTitles - sh.notFoundTitles : null,
        shikimoriFailed: sh ? sh.failedTitles : null,
        shikimoriNotFound: sh ? sh.notFoundTitles : null,
        fellBackToAniList: sh ? sh.failedTitles + sh.notFoundTitles : null,
        shikimoriError: sh && sh.lastError ? String(sh.lastError).slice(0, 100) : null,
        auto: auto.length,
        single: single.length,
        multi: multi.length,
        notFound: notFound.length,
      });

      anixartSummary.innerHTML = `<span class="count"><b>${auto.length + single.length}</b> сопоставлено автоматически</span>`
        + `<span class="fmt-badge">Несколько вариантов: ${multi.length}</span>`
        + (notFound.length > 0 ? `<span class="fmt-badge">Не найдено: ${notFound.length}</span>` : '');

      if (multi.length > 0) {
        renderReviewMulti();
        showReviewStep('multi');
      } else {
        proceedPastMulti();
      }

      anixartReview.hidden = false;
    }

    function candidateLabel(c) {
      const en = c.title.english && c.title.english !== c.title.romaji ? ` / ${c.title.english}` : '';
      let title = c.title.romaji + en;
      if (title.length > 70) title = title.slice(0, 69) + '…';
      return `${escapeHtml(title)} — ${escapeHtml(c.format || '?')}, ${c.episodes ?? '?'} эп., MAL#${c.idMal}`;
    }

    function renderReviewMulti() {
      reviewMultiBody.innerHTML = anixartState.multi.map(({ row, idx, candidates }) => {
        const options = candidates.map((c, i) => `<option value="${i}"${i === 0 ? ' selected' : ''}>${candidateLabel(c)}</option>`).join('');
        return `
          <tr data-idx="${idx}">
            <td>${escapeHtml(row.ruTitle)}<span class="orig-title">${escapeHtml(row.origTitle)}</span></td>
            <td>
              <select class="candidate-select">
                ${options}
                <option value="-1">— нет совпадения / пропустить —</option>
              </select>
            </td>
          </tr>
        `;
      }).join('');
    }

    function computeFinalSelections() {
      const list = [];
      anixartState.auto.forEach(({ row, idx, match }) => list.push({ idx, row, match }));
      anixartState.single.forEach(({ row, idx, match }) => list.push({ idx, row, match }));
      anixartState.multi.forEach(({ row, idx, candidates }) => {
        const val = Number(reviewMultiBody.querySelector(`tr[data-idx="${idx}"] select`).value);
        if (val === -1 || Number.isNaN(val)) return;
        list.push({ idx, row, match: candidates[val] });
      });
      return list;
    }

    function computeDuplicateGroups() {
      const byMalId = new Map();
      computeFinalSelections().forEach(item => {
        const id = item.match.idMal;
        if (!byMalId.has(id)) byMalId.set(id, []);
        byMalId.get(id).push(item);
      });
      return [...byMalId.values()].filter(group => group.length > 1);
    }

    function renderReviewDuplicates(groups) {
      reviewDuplicatesBody.innerHTML = groups.flatMap(group => group.map(({ row, idx, match }) => `
        <tr data-idx="${idx}">
          <td>${escapeHtml(row.ruTitle)}<span class="orig-title">${escapeHtml(row.origTitle)}</span></td>
          <td>${candidateLabel(match)}</td>
          <td><label class="wrong-toggle"><input type="checkbox" class="exclude-checkbox"> Исключить</label></td>
        </tr>
      `)).join('');
    }

    // Собирает финальный список «не сопоставлено»
    function prepareUnresolvedStep() {
      const skippedMulti = anixartState.multi.filter(({ idx }) =>
        Number(reviewMultiBody.querySelector(`tr[data-idx="${idx}"] select`).value) === -1);
      const excluded = [...reviewDuplicatesBody.querySelectorAll('tr')]
        .filter(tr => tr.querySelector('.exclude-checkbox').checked)
        .map(tr => Number(tr.dataset.idx));

      anixartState.skippedMultiIdx = new Set(skippedMulti.map(x => x.idx));
      anixartState.excludedIdx = new Set(excluded);
      anixartState.unresolved = [
        ...anixartState.notFound.map(({ row }) => ({ title: row.origTitle || row.ruTitle, reason: 'не найдено на AniList' })),
        ...skippedMulti.map(({ row }) => ({ title: row.origTitle || row.ruTitle, reason: 'пропущено вручную' })),
        ...excluded.map(idx => {
          const row = anixartState.rows[idx];
          return { title: row.origTitle || row.ruTitle, reason: 'исключено как повторное совпадение' };
        }),
      ];

      reviewUnresolvedBody.innerHTML = anixartState.unresolved.map(u => `
        <tr><td>${escapeHtml(u.title)}</td><td>${escapeHtml(u.reason)}</td></tr>
      `).join('') || `<tr><td colspan="2">Все названия сопоставлены.</td></tr>`;
      downloadUnresolvedBtn.disabled = anixartState.unresolved.length === 0;
    }

    function proceedPastMulti() {
      const duplicateGroups = computeDuplicateGroups();
      anixartState.duplicateGroupCount = duplicateGroups.length;
      if (duplicateGroups.length > 0) {
        renderReviewDuplicates(duplicateGroups);
        showReviewStep('duplicates');
      } else {
        prepareUnresolvedStep();
        showReviewStep('unresolved');
      }
    }

    function proceedPastDuplicates() {
      prepareUnresolvedStep();
      showReviewStep('unresolved');
    }

    function showReviewStep(step) {
      anixartState.currentStep = step;
      reviewMulti.hidden = step !== 'multi';
      reviewDuplicates.hidden = step !== 'duplicates';
      reviewUnresolved.hidden = step !== 'unresolved';
      reviewBackBtn.hidden = !(step === 'duplicates' && anixartState.multi.length > 0);
      reviewNextBtn.hidden = step === 'unresolved';
      downloadUnresolvedBtn.hidden = step !== 'unresolved';
      anixartConfirmBtn.hidden = step !== 'unresolved';
    }

    function downloadUnresolvedList() {
      emit('download-unresolved', { count: anixartState.unresolved.length });
      const text = anixartState.unresolved.map(u => u.title).join('\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'anixart_ne_sopostavleno.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    function finishAnixartReview() {
      const finalEntries = computeFinalSelections()
        .filter(({ idx }) => !anixartState.excludedIdx.has(idx))
        .map(({ row, match }) => buildEntryFromAnixartMatch(row, match));
      const finalSkipped = [...anixartState.csvSkipped, ...anixartState.unresolved];

      // Шаг выбора уже скрыт, но его select'ы живы — их читает computeFinalSelections.
      // 0 — согласился с первым вариантом AniList, -1 — отказался, иначе выбрал другой
      let multiKeptDefault = 0, multiChanged = 0, multiSkipped = 0;
      anixartState.multi.forEach(({ idx }) => {
        const val = Number(reviewMultiBody.querySelector(`tr[data-idx="${idx}"] select`).value);
        if (val === -1) multiSkipped++;
        else if (val === 0) multiKeptDefault++;
        else multiChanged++;
      });
      emit('anixart-review', {
        multi: anixartState.multi.length,
        multiKeptDefault,
        multiChanged,
        multiSkipped,
        duplicateGroups: anixartState.duplicateGroupCount ?? 0,
        excluded: anixartState.excludedIdx.size,
        unresolved: anixartState.unresolved.length,
        finalEntries: finalEntries.length,
      });

      if (finalEntries.length === 0) {
        anixartReview.hidden = true;
        dropzone.hidden = false;
        showError('После проверки не осталось ни одной записи для конвертации.');
        return;
      }

      state.entries = finalEntries;
      state.skipped = finalSkipped;
      state.format = 'anixart';
      anixartReview.hidden = true;
      renderPreview();
    }

    function downloadResult() {
      emit('download', { format: state.format, entries: state.entries.length });
      const xml = buildMalXml(state.entries);
      const blob = new Blob([xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'myanimelist_import.xml';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    // ---- Обработчики ----

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) handleFile(file);
      fileInput.value = '';
    });

    downloadBtn.addEventListener('click', downloadResult);

    anixartStartBtn.addEventListener('click', runAnixartFlow);
    anixartCancelBtn.addEventListener('click', () => { anixartState = null; resetUI(); });
    anixartConfirmBtn.addEventListener('click', finishAnixartReview);
    anixartRestartBtn.addEventListener('click', () => { anixartState = null; resetUI(); });

    reviewNextBtn.addEventListener('click', () => {
      if (anixartState.currentStep === 'multi') proceedPastMulti();
      else if (anixartState.currentStep === 'duplicates') proceedPastDuplicates();
    });
    reviewBackBtn.addEventListener('click', () => showReviewStep('multi'));
    downloadUnresolvedBtn.addEventListener('click', downloadUnresolvedList);

    resetBtn.addEventListener('click', () => {
      anixartState = null;
      state.entries = [];
      state.skipped = [];
      state.format = null;
      resetUI();
    });
  

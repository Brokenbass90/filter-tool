ВАДИМ: база поставщиков + локальный OCR/PDF helper (v6)

Состав папки
1) vadim-filter-tool.html — сама программа (открывается в браузере).
2) helper/ — локальный OCR/PDF сервер (Node.js). Нужен только для PDF-сканов.
3) START_* / RUN_* — скрипты запуска.

Требования
- Chrome или Edge (для ZIP-импорта).
- Node.js 18+ (подойдёт 20/22).
- Интернет нужен только при первом OCR (tesseract.js может докачать языковые данные).

Быстрый запуск (macOS)
1) Терминал → перейти в папку:
   cd "/path/to/vadim-tool-bundle-v6"
2) Снять «карантин» и дать права:
   xattr -dr com.apple.quarantine .
   chmod +x *.command
3) Запуск (сервер + открытие программы):
   ./START_MAC.command

Важно: если вы уже запустили START_MAC.command, НЕ запускайте отдельно `npm start` в helper — порт будет занят.

Остановка (macOS)
- Закройте окно терминала со START_MAC.command или нажмите Ctrl+C.
- Если порт «залип» — запустите: ./STOP_MAC.command

Если macOS всё равно блокирует двойной клик:
- System Settings → Privacy & Security → Open Anyway
- или запускайте через Терминал как выше.

(Если SmartScreen ругается — More info → Run anyway)
Быстрый запуск (Windows)
- Двойной клик START_WIN.bat
- Остановка/если порт занят: STOP_WIN.bat
(Если SmartScreen ругается — More info → Run anyway)

Ручной запуск (любой OS)
1) Запуск сервера:
   cd helper
   npm i
   npm start
   (должно появиться: listening on http://127.0.0.1:17871)
2) Открыть программу:
   откройте vadim-filter-tool.html в браузере.

Проверка сервера
Откройте: http://127.0.0.1:17871/health
Должно вернуть JSON: {"ok":true,...}

Как работает PDF
- Если PDF содержит встроенный текст — сервер отдаёт его быстро (mode="text").
- Если PDF — скан — сервер рендерит страницы и делает OCR (mode="ocr").
- По умолчанию обрабатывается до 25 страниц (настройка OCR_MAX_PAGES).

Переменные окружения (не обязательно)
OCR_PORT=17871
OCR_MAX_PAGES=25
OCR_MAX_UPLOAD_MB=40
OCR_LANG=rus+eng
OCR_MIN_TEXT_CHARS_FASTPATH=40

# pi-notify

Уведомления о завершении работы агента [Pi](https://pi.dev): звук + пуш на Windows, macOS и произвольный Linux-скрипт.

Когда агент доделывает прогон и больше не продолжает сам, расширение играет звук и шлёт системное уведомление. Полезно, если вы свернули терминал и занялись другим делом, пока агент работает.

## Установка

Как и другие пакеты Pi — из git, npm или локального пути:

```bash
pi install git:github.com/balamyt92/pi-notify
# разовый прогон без записи в settings:
pi -e git:github.com/balamyt92/pi-notify
# локально:
pi install ~/work/extensions/pi-notify
```

После установки — `/reload` в сессии Pi. Проверить, что всё заведено: `/notify-test` (сразу шлёт тестовое уведомление текущей платформы) и `/notify-status` (показывает активный конфиг и команды).

## Когда срабатывает

Основной триггер — событие `agent_settled`. Это единственная граница жизненного цикла Pi, после которой гарантированно нет автоматических retry, compaction или очереди на продолжение. Уведомление на `agent_end` давало бы дубли: за ним может идти перезапуск. Второй, независимый триггер — вопрос агента; см. ниже.

Учитываются три итога прогона:

| Итог | Смысл |
|---|---|
| `completed` | агент отработал обычный ответ |
| `aborted` | прогон прерван (Esc / остановка) |
| `error` | финальная ошибка модели или провайдера |

По умолчанию шлются все три. Список настраивается через `notifyOn`.

### Вопрос агента

Второй независимый триггер — вопрос, заданный инструментом `ask_user_question`
(пакет `@juicesharp/rpiv-ask-user-question`). Пока анкета ждёт ответа, прогон
заблокирован и граница `agent_settled` не наступит никогда — без этого хука
уведомления по такому прогону не было бы вовсе. Это особенно заметно на фоновых
сабагентах: вопрос задан, а сигнала нет.

Технически — подписка на канал `pi.events` под именем `rpiv:ask-user:prompt`,
который публикует этот пакет. Контракт пакета: имена каналов неизменяемы,
payload дополняемый, поэтому расширение читает его толерантно и не падает на
незнакомых или битых полях.

Особенности этого триггера:

- `minDurationSeconds` и `notifyOn` к нему **не применяются** — агент ждёт, ждать
  более позднего момента бессмысленно;
- тело уведомления — текст первого вопроса с `header`-чипом плюс счётчик
  остальных: `Кэш: Брать Redis? (+2)`;
- `PI_NOTIFY_KIND` при этом `question`, а не `run` — по нему скрипт подбирает
  отдельный звук или приоритет;
- выключается отдельно: `onQuestion: false`. Общий `enabled: false` глушит и его.

Подписка живёт на шине того рантайма расширений, где загружено pi-notify. Фоновый
сабагент поднимает свой экземпляр расширения и подписывается на своей шине — чем
это отличается от основного сессии, см. следующий раздел.

### Шум от фоновых сабагентов: `requireUI`

Фоновый сабагент поднимает собственный рантайм расширений (`createAgentSession` +
`bindExtensions` без `uiContext`), то есть каждый агент поднимает свой экземпляр
pi-notify и шлёт свой `agent_settled`-пуш с текстом своего последнего ответа.
На N агентов — N тостов поверх основного.

По умолчанию это отсечено: при `requireUI: true` сигнал проходит только из сессии,
где `ctx.hasUI === true`, то есть из интерактивной (TUI) или RPC. Headless-рантайм
сабагента и печатный режим (`pi -p`) молчат.

Флаг стоит снять (`requireUI: false`), если вы сознательно хотите пуши из
печатного режима или из самих сабагентов.

## Настройка

Основной способ — файл `~/.pi/agent/notify.json`. Он пер-машинный и не затирается при `pi update`. Шаблон — `config.example.json` в пакете:

```json
{
  "enabled": true,
  "sound": true,
  "push": true,
  "minDurationSeconds": 0,
  "notifyOn": ["completed", "aborted", "error"],
  "title": "Pi",
  "onQuestion": true,
  "questionTitle": "Pi: вопрос",
  "requireUI": true,
  "commands": {
    "darwin": { "sound": "...", "push": "..." },
    "win32": { "sound": "...", "push": "..." },
    "linux": { "sound": "...", "push": "..." }
  }
}
```

Приоритет: **файл → env → дефолты**. Все поля необязательные — отсутствующие берутся из встроенных значений.

| Поле | Тип | Дефолт | Назначение |
|---|---|---|---|
| `enabled` | bool | `true` | общий выключатель |
| `sound` | bool | `true` | играть канал звука |
| `push` | bool | `true` | играть канал пуша |
| `minDurationSeconds` | number | `0` | не слать, если прогон короче порога (сек) |
| `notifyOn` | string[] | все три | какие итоги порождают уведомление |
| `title` | string | `"Pi"` | заголовок уведомления |
| `onQuestion` | bool | `true` | слать уведомление, когда агент задал вопрос |
| `questionTitle` | string | `"Pi: вопрос"` | заголовок уведомления о вопросе |
| `requireUI` | bool | `true` | молчать в сессиях без UI (фоновые сабагенты, печатный режим) |
| `soundFile` | string | `null` | файл звука; `null` → встроенный `assets/notify.mp3` |
| `soundDurationMs` | number | `5000` | сколько держать плеер живым (мс), покрывает длительность файла |
| `volume` | number | `0.4` | громкость 0.0–1.0 (Windows/WSL) |
| `commands` | object | см. ниже | команды по платформам и каналам |

`minDurationSeconds` удобен, чтобы не получать пуш на каждую быструю реплику. Например, `30` — уведомлять только прогоны дольше получаски.

### Команды по платформам

`commands.<platform>.<channel>`, где `<platform>` — `darwin` / `win32` / `wsl` / `linux`, а `<channel>` — `sound` / `push`. Строка переопределяет встроенную команду для этой платформы и канала. Пустая строка (`""`) — канал не играть.

Встроенные команды по умолчанию:

**macOS (`darwin`)**
- звук: `afplay /System/Library/Sounds/Glass.aiff`
- пуш: `osascript -e 'display notification (system attribute "PI_NOTIFY_MESSAGE") with title (system attribute "PI_NOTIFY_TITLE")'`

**Windows (`win32`)**
- звук: PowerShell + WinRT `MediaPlayer` играет `PI_NOTIFY_SOUND_FILE` (MP3/WAV)
- пуш: PowerShell toast через WinRT (`ToastNotificationManager`)

Обе Windows-команды передаются через `-EncodedCommand` (UTF-16LE base64) — так не ломается на кавычках и кириллице.

**Linux**
- звук: цепочка `paplay → aplay → ничего` (пробует PulseAudio, потом ALSA, при отсутствии молча пропускает)
- пуш: `notify-send "$PI_NOTIFY_TITLE" "$PI_NOTIFY_MESSAGE"`

**WSL (`wsl`)**
- звук: `powershell.exe` + WinRT `MediaPlayer` играет `PI_NOTIFY_SOUND_FILE` (MP3/WAV) на Windows
- пуш: `powershell.exe` → Windows toast (WinRT)

### Звук: встроенный файл и переопределение

В пакет встроен звук `assets/notify.mp3` — он играется по умолчанию на Windows и в WSL. На macOS/Linux дефолт — системные проигрыватели (их можно тоже перевести на файл, см. ниже).

Сменить звук: `soundFile` в конфиге или `PI_NOTIFY_SOUND_FILE` в окружении. Путь можно дать в WSL- или Windows-формате:

```json
{
  "soundFile": "C:\\Windows\\Media\\Alarm01.wav",
  "soundDurationMs": 4000
}
```

В WSL относительный/WSL-путь автоматически конвертируется в UNC `\\wsl.localhost\<distro>\...`, чтобы `powershell.exe` прочитал файл из Linux-дерева. Уже windows-путь (`C:\...` или `\\...`) остаётся как есть.

`soundDurationMs` — фиксированный сон плеера. Событие `MediaEnded` в Windows PowerShell 5.1 не отдаётся, поэтому длительность задаётся явно и должна покрывать файл с запасом. Для встроенного `notify.mp3` (~1.8 с) дефолта 5000 мс хватает.

`volume` — громкость 0.0–1.0 (линейная, WinRT `MediaPlayer.Volume`). Дефолт `0.4` — заметно тише максимума. Действует на Windows/WSL; на macOS/Linux громкость регулируется проигрывателем/системой. Слишком тихо или громко — подстройте под себя, например `"volume": 0.2`.

Чтобы на macOS/Linux тоже играл ваш файл, переопределите команду канала `sound`, например:

```json
{
  "commands": {
    "darwin": { "sound": "afplay \"$PI_NOTIFY_SOUND_FILE\"" },
    "linux": { "sound": "paplay \"$PI_NOTIFY_SOUND_FILE\" 2>/dev/null || true" }
  }
}
```

### WSL: почему отдельная платформа

В WSL2 Node сообщает `process.platform === "linux"`, но нативного звука и нотификаций в Linux-ядре нет — аудиосистема и тосты живут на Windows. Родные `paplay`/`notify-send` либо отсутствуют, либо не выводят ничего слышимого.

Поэтому расширение определяет WSL (по `WSL_DISTRO_NAME` / `WSL_INTEROP`) и для него шлёт уведомление в Windows через interop: `powershell.exe` с тем же тостом/звуком, что и на нативном Windows.

**Проброс текста через границу WSL→Windows.** WSL не передаёт произвольные Linux-переменные окружения в Windows-процессы. Для этого служит `WSLENV` — список имён, которые разрешено переносить. Расширение само добавляет `PI_NOTIFY_TITLE:PI_NOTIFY_MESSAGE:PI_NOTIFY_OUTCOME:PI_NOTIFY_DURATION:PI_NOTIFY_SOUND_FILE:PI_NOTIFY_SOUND_DURATION` в `WSLENV` дочернего процесса, сохраняя уже заданные вами записи. Значения передаются как есть (без флага `/p`, то есть без конвертации путей), кириллица и спецсимволы доходят корректно — проверено round-trip через UTF-8.

Если вы пишете свой скрипт для WSL (`commands.wsl.push`), он тоже получает `PI_NOTIFY_*` в окружении, а `powershell.exe` внутри него увидит их благодаря `WSLENV`. Для чистого bash-скрипта в WSL ничего делать не нужно — переменные доступны как обычно.

> Проверка на вашей машине: `/notify-test`. Если тост появился на Windows и встроенный `notify.mp3` слышен — связка работает. Если звука нет, а тост есть — проверьте громкость Windows и что `soundDurationMs` покрывает длительность файла.

## Контракт: произвольный Linux-скрипт

Главный сценарий для Linux — своя скрипка. Текст уведомления **никогда не подставляется в командную строку**. Он приходит дочернему процессу через переменные окружения:

| Переменная | Содержимое |
|---|---|
| `PI_NOTIFY_TITLE` | заголовок (`title` из конфига, для вопроса — `questionTitle`) |
| `PI_NOTIFY_MESSAGE` | тело: текст последнего ответа агента, текст вопроса либо служебный текст для abort/error |
| `PI_NOTIFY_OUTCOME` | `completed` / `aborted` / `error` |
| `PI_NOTIFY_DURATION` | длительность прогона, целое число секунд |
| `PI_NOTIFY_KIND` | `run` — итог прогона; `question` — агент ждёт ответа на вопрос |

Скрипт читает их сам. Пример `~/bin/pi-notify.sh`:

```bash
#!/bin/sh
# Тело уже в $PI_NOTIFY_MESSAGE — интерполяция не нужна, инъекция невозможна.
notify-send -u normal "$PI_NOTIFY_TITLE" "$PI_NOTIFY_MESSAGE"
# своя доп. логика:
echo "$(date -Is) $PI_NOTIFY_OUTCOME ${PI_NOTIFY_DURATION}s" >> ~/.pi/notify.log
```

Подключить:

```json
{
  "commands": {
    "linux": { "push": "~/bin/pi-notify.sh" }
  }
}
```

Команда исполняется через `sh -c`, поэтому доступны пайпы, `||`, подстановки. Тот же контракт работает для звука и для любой платформы — можно, например, на macOS дёрнуть свой скрипт вместо `afplay`.

### Безопасность текста

Расширение намеренно не интерполирует `PI_NOTIFY_MESSAGE` в команду. Если бы тело уведомления подставлялось в строку вида `notify-send "$MSG"`, кавычка или `;` в ответе агента сломали бы команду или позволили инжект. Вместо этого команда ссылается на `$PI_NOTIFY_MESSAGE`, а значение живёт в окружении процесса. Для osascript — `system attribute "PI_NOTIFY_MESSAGE"`, для PowerShell — `$env:PI_NOTIFY_MESSAGE`.

## Переменные окружения

Для CI и разовых переопределений (поверх файла):

| Переменная | Переопределяет |
|---|---|
| `PI_NOTIFY` | `enabled` (`1`/`true` вкл, `0`/`false` выкл) |
| `PI_NOTIFY_SOUND` | `sound` |
| `PI_NOTIFY_PUSH` | `push` |
| `PI_NOTIFY_TITLE` | `title` |
| `PI_NOTIFY_QUESTION` | `onQuestion` (`1`/`true` вкл, `0`/`false` выкл) |
| `PI_NOTIFY_QUESTION_TITLE` | `questionTitle` |
| `PI_NOTIFY_REQUIRE_UI` | `requireUI` |
| `PI_NOTIFY_SOUND_FILE` | `soundFile` (файл звука) |
| `PI_NOTIFY_SOUND_DURATION` | `soundDurationMs` |
| `PI_NOTIFY_VOLUME` | `volume` (0.0–1.0) |
| `PI_NOTIFY_MIN_DURATION` | `minDurationSeconds` |
| `PI_NOTIFY_CMD_SOUND` | команду `sound` текущей платформы |
| `PI_NOTIFY_CMD_PUSH` | команду `push` текущей платформы |

Пример — выключить звук, оставить только пуш:

```bash
PI_NOTIFY_SOUND=0 pi
```

## Команды

- `/notify-test` — мгновенно слать тестовое уведомление по текущему плану платформы, в обход порога длительности. Проверка, что звук и пуш на этой машине работают.
- `/notify-status` — показать разрешённый конфиг: флаги, порог, `notifyOn`, заголовок, настройки вопроса, платформу и фактические команды звука/пуша.

## Зависимости от ОС

Расширение не тянет npm-зависимостей. Всё держится на штатных утилитах:

| ОС | Звук | Пуш |
|---|---|---|
| macOS | `afplay` (встроен) | `osascript` (встроен) |
| Windows | PowerShell (встроен) | PowerShell + WinRT (встроен, Win10/11) |
| WSL | `powershell.exe` (interop) | `powershell.exe` + WinRT (interop) |
| Linux | `paplay`/`aplay` (опционально) | `notify-send` (libnotify) или свой скрипт |

Если утилиты нет, канал молча не срабатывает — сессию это не роняет. На Linux без `notify-send` путь — свой скрипт через `commands.linux.push`. В WSL всё работает через `powershell.exe`, который есть в любом Windows.

## Разработка

```bash
cd ~/work/extensions/pi-notify
npm install          # или симлинки на уже стоящие пакеты
npm run typecheck    # tsc --noEmit
npm test             # node --test tests/*.test.ts
```

Структура:

| Файл | Роль |
|---|---|
| `index.ts` | точка входа: вешает события `agent_*`, регистрирует команды |
| `config.ts` | загрузка/слияние конфига, env-оверрайды, встроенные команды |
| `notify.ts` | чистая логика: извлечение итога, текст, порог, план |
| `exec.ts` | запуск команд detached-процессами, best-effort |
| `tests/` | офлайн-тесты логики + интеграционный прогон событий |

Логика вынесена в чистые функции (`notify.ts`, `config.ts`) и тестируется без Pi и без ОС. `exec.ts` и `index.ts` — тонкий слой ввода-вывода.

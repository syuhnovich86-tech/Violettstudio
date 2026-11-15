# Android: прямой HTTPS и внутренние обновления

Android build 7 использует `https://31-10-64-46.sslip.io` для API, защищённых медиа и Expo Updates. Runtime Android — `0.6.0`; старые APK остаются на `0.5.0` и получают свои обновления отдельно.

## Источники конфигурации

- `apps/mobile/src/api/client.ts`: Android API идёт напрямую, без перехода на Tailscale при ошибке. Старые абсолютные ссылки именно на API прежнего домена преобразуются в прямые. Неудачные POST не повторяются автоматически.
- `apps/mobile/plugins/withAndroidReleaseSafety.js`: задаёт прямой URL в **нативном AndroidManifest.xml**, включает запрет открытого HTTP в обычной сборке. Общий `updates.url` в `app.json` оставлен для существующей iOS-версии; для Android он переопределяется этим плагином.
- `apps/mobile/app.json`: Android `versionCode: 7`, `runtimeVersion: 0.6.0`. Не публиковать новые Android-экспорты в старый runtime `0.5.0`.
- `apps/mobile/scripts/build-android-local.ps1`: после prebuild проверяет нативный адрес, включённые обновления и runtime.

Не отключать Expo Updates и не включать `disableAntiBrickingMeasures`. APK должен сохранять package `ru.violetta.mediacenter` и прежний сертификат подписи, иначе установка поверх существующей версии не пройдёт.

## Проверки перед выпуском

Из каталога `apps/mobile`:

```powershell
node scripts/test-android-native-config.cjs
node --experimental-transform-types scripts/test-direct-api.mjs android
node --experimental-transform-types scripts/test-direct-api.mjs ios
node --experimental-transform-types scripts/test-client-failover.mjs
node node_modules/typescript/bin/tsc --noEmit
```

Проверить **готовый APK** с помощью `apksigner verify --print-certs` и `aapt dump`: package, увеличенный versionCode, runtime `0.6.0`, нативный HTTPS URL и включённые обновления. Проверить установку поверх build 6 и запуск, затем загрузку и применение OTA на эмуляторе. Фиксировать ограничения виртуальной сети отдельно от результата сборки.

## Публикация OTA

Экспортировать только Android, нормализовать пути в `metadata.json` в формат `/`, загрузить в отдельный staging-каталог, затем атомарно переместить в `/srv/vita29/app-data/mobile-updates/0.6.0/<timestamp>`. Сервер уже разделяет обновления по runtime. Проверить прямой manifest, хеши bundle/assets и HTTP 204 с `expo-current-update-id` установленного обновления.

Адрес проверки: `https://31-10-64-46.sslip.io/api/v1/mobile/updates/manifest`, заголовки `expo-platform: android`, `expo-runtime-version: 0.6.0`.

## Сетевой маршрут при проверке

Фиксировать фактический IP соединения (`curl --write-out '%{remote_ip}'`), а не только имя в URL. Локальная запись HOSTS может направлять публичное имя на LAN-адрес и скрывать отказ внешнего маршрута. Проверять отдельно LAN, внешний доступ из независимой сети и доступ из домашнего Wi-Fi через публичный IP. Для последнего использовать `curl --noproxy '*' --resolve 31-10-64-46.sslip.io:443:31.10.64.46 https://31-10-64-46.sslip.io/api/v1/health` без отключения проверки TLS.

Успех запроса с сервера, использующего исходящий VPN, не подтверждает NAT loopback домашнего шлюза. Для проверки этого пути фиксировать исходный интерфейс и таблицу маршрутизации. При тайм-ауте на Wi-Fi и успехе через мобильную сеть сначала проверить этот сетевой путь; не возвращать Android на Tailscale и не повторять POST автоматически.

Для текущего домашнего SNR-CPE-ME2-Lite сохранена локальная запись DNS: `31-10-64-46.sslip.io → 192.168.1.212`. Она обходит неработающий возврат через публичный IP внутри домашней сети. Запись проверена после перезагрузки роутера; пользователь подтвердил работу приложения по Wi-Fi. Публичное разрешение имени остаётся `31.10.64.46`. При замене роутера или смене LAN-адреса сервера перенести/обновить эту запись. Отдельный Private DNS на клиенте может обходить локальную запись; его путь проверять отдельно.

Переезд сервера должен сохранить этот HTTPS-адрес или предусматривать отдельную миграцию клиентов. Tailscale может оставаться для администрирования и старых клиентов; новому Android он не нужен.

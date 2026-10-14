# Предлагаемая структура репозитория

Эта структура будет создана на этапе каркаса; сейчас она служит контрактом.

```text
vita29-files/
├── README.md
├── docs/
│   ├── architecture-v1.md
│   ├── repository-layout.md
│   └── roadmap.md
├── backend/
│   ├── pyproject.toml
│   ├── alembic.ini
│   ├── migrations/
│   ├── src/vita29/
│   │   ├── api/
│   │   ├── auth/
│   │   ├── db/
│   │   ├── media/
│   │   ├── settings.py
│   │   └── main.py
│   └── tests/
├── frontend/
│   ├── package.json
│   ├── src/
│   └── tests/
├── deploy/
│   ├── compose.yaml
│   ├── Caddyfile
│   ├── env.example
│   └── systemd/
├── scripts/
│   ├── backup.ps1-or-sh
│   ├── restore.ps1-or-sh
│   └── deploy.ps1-or-sh
└── .github/workflows/       # только если понадобится удалённый Git
```

Правила границ:

- `backend` не зависит от физического пути диска;
- `frontend` общается только с версионированным API `/api/v1`;
- `deploy` не содержит паролей и других секретов;
- операции с файлами сосредоточены в модуле `media`, а не разбросаны по обработчикам API;
- тесты хранилища используют временный каталог;
- содержимое `sources/` остаётся только справочным и не изменяется.


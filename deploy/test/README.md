# Mobile integration environment

Start the isolated API and seed two import-enabled accounts:

```powershell
docker compose --env-file .env -f compose.yaml up --build -d
```

The API is available at `http://127.0.0.1:18000/api/v1`. Android Emulator uses
`http://10.0.2.2:18000/api/v1`; a physical phone uses the workstation LAN IP.

Accounts: `test-owner` and `violetta`. Their password is `VITA29_TEST_PASSWORD`.
The seed also creates the shared private folder `Фото с iPhone`.

Reset only the isolated test data:

```powershell
docker compose --env-file .env -f compose.yaml down -v
```

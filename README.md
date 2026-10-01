# Fieldstock

Multi-base asset ledger with a React/Vite interface, Express REST API, and **MySQL 8** database. InnoDB foreign keys enforce relational integrity; transactions keep stock checks, movement writes, and audit events atomic. Opening and closing balances are derived from the movement ledger.

## MySQL setup

MySQL Server must be running. In MySQL Workbench, connect as `root`, open `server/setup.sql`, and execute it to create the `fieldstock` database.

For local development, copy the environment template and set `MYSQL_PASSWORD` to your Workbench root password. Also set a long random JWT secret:

```powershell
Copy-Item .env.example .env
```

Edit `.env` locally. The application connects to MySQL as `root` for local development only. For shared or production use, create a restricted MySQL account and update `MYSQL_USER` and `MYSQL_PASSWORD` accordingly. `.env` is ignored by Git.

## Run

```powershell
npm install
npm run dev
```

Open http://localhost:5173. The API listens on http://localhost:3001 and creates tables from `server/schema.sql` on first connection. Demo records are seeded if the bases table is empty.

Demo application accounts (local evaluation only):

- Admin: `admin` / `admin123!`
- Base Commander (Northgate): `commander` / `command123!`
- Logistics Officer: `logistics` / `logistics123!`

## API

- `POST /api/auth/login`, `GET /api/me`
- `GET /api/summary`, `/api/bases`, `/api/equipment`
- `GET|POST /api/purchases`, `GET|POST /api/transfers`
- `GET|POST /api/assignments`, `POST /api/assignments/:id/expense`
- `GET /api/audit` (Admin only)

JWT authentication is required for application APIs. Commanders are scoped to their assigned base; logistics officers can access purchases and transfers; admins have full access. Passwords are stored as salted scrypt hashes. Mutations write an audit event in the same MySQL transaction as the ledger changes.

Assignments track custody without reducing base stock. Expenditure reduces closing stock. Net movement is purchases + transfers in - transfers out. The opening balance is stock immediately before the selected start date.

The earlier SQLite demo database is not migrated automatically. MySQL is seeded with fresh demo data. Before operational use, add managed user provisioning/password resets, HTTPS, rate limiting, backups, versioned migrations, pagination, and a reviewed deployment configuration. Change the demo app passwords before shared use.

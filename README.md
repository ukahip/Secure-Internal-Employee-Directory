# 🏢 Secure Employee Directory

A production-grade three-tier web application demonstrating AWS cloud security best practices — private subnets, KMS encryption at rest, IAM least privilege, Secrets Manager credential management, and SSM-only EC2 access. No SSH. No hardcoded secrets.


## ✨ Features

- **Email + password authentication** — bcrypt-hashed passwords, JWT sessions, stored in PostgreSQL
- **Role-based routing** — regular users go to `/app`, admin goes to `/admin` automatically on login
- **Personal profile dashboard** — users see and edit only their own employee record
- **Employee directory** — browse all colleagues; own card is highlighted and clickable
- **Admin panel** — completely separate page at `/admin`, username + password login (credentials stored as server environment variables — not in the database)
- **Dark and light mode** — preference saved in localStorage across sessions
- **Fully mobile-responsive** — bottom navigation bar on mobile, pill nav on desktop
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection` set via Vercel on every response

---

## 🗂️ File Structure

```
employee-directory/
├── index.html          # Public login and registration page
├── app.html            # Authenticated user dashboard  → served at /app
├── admin.html          # Admin management panel        → served at /admin
├── vercel.json         # URL routing, API rewrite, security headers
├── README.md
└── api/
    └── proxy.js        # Vercel serverless function — reads API_BASE_URL server-side
                        # Forwards JWT Authorization header to backend
                        # Backend URL never exposed to the browser
```

---

## 🏗️ Architecture

```
Browser (Vercel CDN — global)
    │
    │  HTTPS
    │  /api/* → serverless proxy (API_BASE_URL read server-side only)
    │  JWT forwarded in Authorization header
    ▼
Application Load Balancer
    │  HTTP:80  ·  Internet-facing  ·  Public subnets
    │  Security group: alb-sg
    ▼
EC2 — Node.js + Express  (Port 8080)
    │  Private subnet  ·  No public IP
    │  Access via SSM Session Manager only — no SSH, no port 22
    │  IAM role: EmployeeDirAppRole
    │  Fetches DB credentials from Secrets Manager at startup
    ▼
RDS PostgreSQL 15
    │  Private subnet  ·  Zero internet path
    │  Encrypted at rest — KMS Customer Managed Key
    │  Security group: rds-sg (accepts only from app-sg)
```

---

## 🔐 Security Controls

| Control | Detail |
|---------|--------|
| No public EC2 IP | Private subnet — SSM Session Manager only |
| No SSH | No port 22, no key pair. Browser terminal via AWS Systems Manager |
| Secrets management | DB credentials stored in Secrets Manager, fetched at runtime — never in source code |
| Encryption at rest | RDS and Secrets Manager encrypted with Customer Managed KMS Key |
| IAM least privilege | EC2 role scoped to project secrets namespace only |
| Security group chaining | alb-sg → app-sg → rds-sg. Each tier accepts only from the previous |
| Password hashing | bcryptjs, cost factor 12. Passwords never stored in plain text |
| JWT sessions | Employee sessions: 7-day expiry. Admin sessions: 8-hour expiry |
| Admin credentials | Stored as environment variables on EC2 — not in the database |
| API URL hidden | Vercel proxy reads `API_BASE_URL` server-side — never reaches the browser |
| Security headers | `nosniff`, `DENY` frame options, XSS protection on all Vercel responses |
| VPC Flow Logs | All ACCEPT and REJECT traffic captured to CloudWatch |

---

## 🔄 How the Proxy Works

```
Browser  →  fetch('/api/auth/login')
         →  vercel.json rewrites to /api/proxy?path=auth/login
         →  proxy.js reads process.env.API_BASE_URL  (server-side only)
         →  forwards request + Authorization header to ALB
         →  returns JSON response to browser
```

**Critical:** `vercel.json` uses `(.*)` regex capture with `$1` — not `:path*`. The `(.*)` syntax correctly passes the captured path as a query parameter to the proxy function. The proxy also validates the path parameter and returns a structured error if it is missing.

---

## 🔒 Auth Flow

### Employee (email + password)
```
Register:  name + email + password
           → bcrypt.hash(password, 12) stored in users table
           → employee record created and linked
           → JWT returned (7-day expiry)
           → redirected to /app

Login:     email + password
           → bcrypt.compare against stored hash
           → JWT returned with employee_id, is_admin: false
           → redirected to /app
```

### Admin (username + password)
```
Login:     username + password
           → compared against ADMIN_USERNAME / ADMIN_PASSWORD env vars
           → 800ms delay on failure (brute-force protection)
           → JWT returned with is_admin: true (8-hour expiry)
           → redirected to /admin
           → session persisted in localStorage, restored on next visit
```

---

## 📱 Pages and Navigation

| URL | File | Who can access |
|-----|------|---------------|
| `/` | `index.html` | Everyone — login and register |
| `/app` | `app.html` | Logged-in employees only |
| `/admin` | `admin.html` | Admin only — no link from main app |

### `/app` — three client-side pages
| Tab | What it does |
|-----|-------------|
| **My Profile** | Full personal record in a banner card — name, role, department, email, phone, DOB, start date, address, emergency contact |
| **Directory** | All staff (name, role, department only). Own card highlighted with "You" badge — click to go back to profile |
| **Edit Profile** | Update phone, department, date of birth, start date, address, emergency contact |

### `/admin` — admin dashboard
- Login gate — username and password
- Stats bar — total employees, departments, unique roles, session duration
- Searchable full employee table
- Add employee modal
- Edit employee modal (all fields)
- Delete with confirmation — removes employee and linked user account

---

## 🚀 API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | None | Health check — `{"status":"ok"}` |
| `GET` | `/employees` | JWT | Directory list — name, role, department only |
| `POST` | `/auth/register` | None | Create employee account |
| `POST` | `/auth/login` | None | Authenticate, receive JWT |
| `GET` | `/auth/me` | JWT | Get own full profile |
| `PUT` | `/auth/me` | JWT | Update own profile |
| `POST` | `/admin/login` | None | Admin credentials → JWT |
| `GET` | `/admin/employees` | Admin JWT | All employees, all fields |
| `POST` | `/admin/employees` | Admin JWT | Add employee |
| `PUT` | `/admin/employees/:id` | Admin JWT | Edit employee |
| `DELETE` | `/admin/employees/:id` | Admin JWT | Delete employee + linked user |

---

## 🔧 Environment Variables

### EC2 — `/app/.env`

| Variable | Description |
|----------|-------------|
| `AWS_REGION` | AWS region |
| `APP_PORT` | Node.js server port (e.g. `8080`) |
| `SECRET_ARN` | ARN of the Secrets Manager secret for DB credentials |
| `DB_HOST` | RDS endpoint hostname |
| `JWT_SECRET` | Random string for signing JWT tokens — auto-generated by setup script |
| `ADMIN_USERNAME` | Admin login username |
| `ADMIN_PASSWORD` | Admin login password |

### Vercel — Project Settings → Environment Variables

| Variable | Description |
|----------|-------------|
| `API_BASE_URL` | ALB DNS name — e.g. `http://your-alb.region.elb.amazonaws.com` |

> Update `API_BASE_URL` to `https://yourdomain.com` after adding an ACM certificate.

---

## 🛠️ EC2 Setup

Run the one-time setup script to configure credentials and auto-generate the JWT secret:

```bash
sudo su -
bash /tmp/setup.sh
```

The script prompts for an admin username and password, generates a secure random JWT secret via Node.js crypto, writes the complete `.env` file, installs `bcryptjs` and `jsonwebtoken`, and restarts the systemd service.

Manual install if needed:
```bash
cd /app
npm install bcryptjs jsonwebtoken
systemctl restart employee-dir
systemctl status employee-dir
```

---

## 🧱 Tech Stack

**AWS Infrastructure**
- VPC — custom CIDR, 5 subnets across 2 availability zones
- Application Load Balancer — internet-facing, HTTP:80
- EC2 t3.micro — Amazon Linux 2023, private subnet, systemd service
- RDS PostgreSQL 15 — db.t3.micro, gp3 storage, private subnet group
- Secrets Manager — DB credentials, KMS CMK encrypted
- KMS CMK — symmetric key, encrypts Secrets Manager and RDS
- IAM — least privilege inline policies
- SSM Session Manager — no SSH required
- VPC Flow Logs → CloudWatch

**Backend (Node.js)**
- Express — REST API framework
- bcryptjs — password hashing (cost factor 12)
- jsonwebtoken — JWT signing and verification
- pg — PostgreSQL driver
- @aws-sdk/client-secrets-manager — runtime credential fetch
- cors — cross-origin support
- dotenv — environment configuration

**Frontend**
- Vanilla HTML, CSS, JavaScript — no frameworks, mobile-first
- Typography: Sora (headings) + Plus Jakarta Sans (body)
- Dark/light mode with localStorage persistence
- Bottom navigation bar on mobile, pill navigation on desktop

**Deployment**
- Vercel — global CDN, serverless proxy, security headers
- GitHub — source control, automatic redeploy on push

---

## 📋 HTTPS Setup (once you have a domain)

1. ACM → Request public certificate → DNS validation → add CNAME to DNS provider
2. ALB → Add HTTPS listener port 443 → attach ACM certificate → policy `ELBSecurityPolicy-TLS13-1-2-2021-06`
3. ALB → Update HTTP:80 listener → Redirect to HTTPS 301
4. DNS provider → A record pointing to ALB
5. Vercel → update `API_BASE_URL` to `https://yourdomain.com`

---

## ✅ Validation Checklist

- [x] EC2 has no public IP address
- [x] RDS not publicly accessible
- [x] RDS storage encrypted with KMS CMK
- [x] SSM Session Manager works — no SSH needed
- [x] ALB `/health` returns `{"status":"ok"}`
- [x] Passwords hashed with bcrypt — never stored in plain text
- [x] Employee JWT sessions expire after 7 days
- [x] Admin JWT sessions expire after 8 hours
- [x] Admin page has no link from the main app
- [x] `API_BASE_URL` stored as Vercel env var — not in source code
- [x] Users can only read and edit their own profile data
- [x] Security headers applied to all Vercel responses

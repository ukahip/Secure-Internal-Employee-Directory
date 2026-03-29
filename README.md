# 🏢 Secure Employee Directory

A production-grade three-tier web application demonstrating AWS cloud security best practices — private subnets, KMS encryption, IAM least privilege, Secrets Manager, and SSM-only EC2 access.

---

## 🌐 Live Demo

[View the app](#) <!-- Add your Vercel URL here -->

---

## ✨ Features

- **User authentication** — email and password login with bcrypt hashing and JWT sessions. No additional AWS services required.
- **Personal profiles** — users see only their own employee record after signing in
- **Employee directory** — browse colleagues by name, role, and department
- **Admin panel** — completely separate page at `/admin`, restricted to admin accounts, with full add / edit / delete capability
- **Dark and light mode** — preference saved across sessions
- **Fully mobile-responsive** — bottom navigation bar on mobile, pill navigation on desktop

---

## 🏗️ Architecture

```
Browser (Vercel)
    │
    │ HTTPS  —  /api/* routed through serverless proxy
    │           JWT forwarded server-side (API URL never exposed)
    ▼
Application Load Balancer
    │  HTTP:80  ·  Internet-facing  ·  Public subnet
    ▼
EC2 (Node.js + Express)
    │  Port 8080  ·  Private subnet  ·  No public IP
    │  SSM Session Manager access only
    ▼
RDS PostgreSQL
    │  Private subnet  ·  Zero internet path
    │  Encrypted at rest with KMS CMK
```

---

## 🔐 Security Controls

| Control | Detail |
|---------|--------|
| No public EC2 IP | Private subnet, SSM Session Manager only |
| No SSH | No port 22, no key pair — browser terminal via AWS |
| Secrets management | DB credentials fetched from Secrets Manager at runtime |
| Encryption at rest | RDS and Secrets Manager encrypted with Customer Managed KMS Key |
| IAM least privilege | EC2 role scoped only to its own secrets namespace |
| Security group chaining | ALB → EC2 → RDS, each layer accepts only from the previous |
| Password hashing | bcryptjs with cost factor 12 — passwords never stored in plain text |
| JWT sessions | 7-day expiry, signed with `JWT_SECRET` environment variable |
| API URL hidden | Vercel serverless proxy reads `API_BASE_URL` server-side only |
| VPC Flow Logs | All network traffic logged to CloudWatch |

---

## 📁 Project Structure

```
employee-directory-frontend/
├── index.html          # Login and registration page (public)
├── app.html            # User dashboard (requires login) — served at /app
├── admin.html          # Admin panel (requires admin login) — served at /admin
├── vercel.json         # URL routing and /api/* rewrite config
├── README.md
└── api/
    └── proxy.js        # Serverless function — reads API_BASE_URL from env vars
                        # Forwards JWT header to backend — never exposes API URL
```

---

## ⚙️ How the Auth System Works

Passwords are hashed using **bcryptjs** and stored in the PostgreSQL database. No additional AWS services (Cognito, etc.) are needed.

```
Register:  name + email + password
           → bcrypt.hash(password, 12) → stored in users table
           → employee record created and linked
           → JWT returned (7 days expiry)

Login:     email + password
           → bcrypt.compare(password, stored_hash)
           → JWT returned with user_id, employee_id, is_admin flag

Protected: JWT sent in Authorization: Bearer <token> header
           → proxy.js forwards it to EC2
           → server verifies with jsonwebtoken
```

---

## 🔒 Admin Access

The admin page lives at `/admin` — a completely separate page not linked from the main app.

An account becomes an admin when its email matches the `ADMIN_EMAIL` environment variable on the EC2. Set this before the admin registers their account.

---

## 🔧 Environment Variables

### EC2 — `/app/.env`

| Variable | Description |
|----------|-------------|
| `AWS_REGION` | AWS region (e.g. `us-west-1`) |
| `APP_PORT` | Port to run the server on (e.g. `8080`) |
| `SECRET_ARN` | ARN of the Secrets Manager secret containing DB credentials |
| `DB_HOST` | RDS endpoint hostname |
| `JWT_SECRET` | Long random string used to sign JWT tokens |
| `ADMIN_EMAIL` | Email address that gets admin privileges on first registration |

### Vercel — Project Settings → Environment Variables

| Variable | Description |
|----------|-------------|
| `API_BASE_URL` | Your ALB DNS name — e.g. `http://your-alb.us-west-1.elb.amazonaws.com` |

> Switch `API_BASE_URL` to `https://yourdomain.com` after adding an ACM certificate and HTTPS listener.

---

## 🚀 API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | None | Health check |
| `GET` | `/employees` | None | Public list (name, role, dept only) |
| `POST` | `/auth/register` | None | Create account + employee record |
| `POST` | `/auth/login` | None | Authenticate, receive JWT |
| `GET` | `/auth/me` | JWT | Get own full profile |
| `PUT` | `/auth/me` | JWT | Update own profile |
| `GET` | `/admin/employees` | Admin JWT | All employees with all fields |
| `POST` | `/admin/employees` | Admin JWT | Add employee |
| `PUT` | `/admin/employees/:id` | Admin JWT | Edit employee |
| `DELETE` | `/admin/employees/:id` | Admin JWT | Delete employee |

---

## 🛠️ EC2 Setup

After deploying `server.js`, install the new dependencies:

```bash
sudo su -
cd /app
npm install bcryptjs jsonwebtoken
systemctl restart employee-dir
systemctl status employee-dir
```

Add the new variables to `/app/.env`:

```bash
JWT_SECRET=your-long-random-secret-string-here
ADMIN_EMAIL=your-admin-email@example.com
```

---

## 🧱 Tech Stack

**AWS Infrastructure**
- VPC, public and private subnets, Internet Gateway, NAT Gateway
- Application Load Balancer
- EC2 (Amazon Linux 2023, private subnet, systemd)
- RDS PostgreSQL 15 (private subnet, KMS encrypted)
- Secrets Manager with Customer Managed KMS Key
- IAM least privilege roles and inline policies
- SSM Session Manager (no SSH)
- VPC Flow Logs → CloudWatch

**Application**
- Node.js + Express
- bcryptjs (password hashing)
- jsonwebtoken (JWT sessions)
- pg (PostgreSQL driver)
- @aws-sdk/client-secrets-manager
- cors, dotenv

**Frontend & Deployment**
- HTML, CSS, JavaScript — mobile-first, no frameworks
- Vercel CDN with serverless API proxy
- GitHub — source control and CI/CD

---

## ✅ Validation Checklist

- [x] EC2 has no public IP address
- [x] RDS not publicly accessible
- [x] RDS encrypted with KMS CMK
- [x] SSM Session Manager access works — no SSH required
- [x] `/health` returns `{"status":"ok"}` via ALB
- [x] Passwords hashed with bcrypt — never stored in plain text
- [x] JWT tokens expire after 7 days
- [x] Admin page separate from main app — no navigation link
- [x] `API_BASE_URL` stored as Vercel env var — not in source code
- [x] Users can only access their own profile data

---

## 📋 HTTPS Setup (once you have a domain)

1. Request ACM certificate with DNS validation
2. Add ALB HTTPS listener on port 443 with ACM certificate
3. Update ALB HTTP:80 listener to redirect to HTTPS
4. Point your domain DNS to the ALB
5. Update Vercel `API_BASE_URL` to `https://yourdomain.com`

---

*Built for AltSchool Africa — Cloud Security Track*
